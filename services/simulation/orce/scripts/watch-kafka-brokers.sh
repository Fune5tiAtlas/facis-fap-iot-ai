#!/bin/sh
# watch-kafka-brokers.sh — main container step for the kafka-broker-watcher
# CronJob. Detect Stackable Kafka NodePort drift and (after two stable
# consecutive detections) re-deploy facis-simulation-kafka.json's
# `kafka-broker-config` node with the fresh broker list.
#
# Split across two containers because no single small image conveniently
# bundles kcat with a real HTTP client:
#   - init container (edenhill/kcat, pinned by digest): runs kcat -L and
#     writes the discovered broker list to $SHARED_DIR/live-brokers.txt.
#   - this (main) container (badouralix/curl-jq, pinned by digest — same
#     image already used and vetted for the same reason by
#     services/dsp-connector/helm/.../orce-flow-deploy-job.yaml): does all
#     HTTP + JSON work with curl and jq.
# Confirmed directly against a live pull: edenhill/kcat has neither curl,
# nor a POST-capable wget (its busybox wget doesn't support --post-file/
# --post-data at all), nor python3 — despite this file's own prior history
# assuming otherwise. jq is used here instead of sed/grep text-matching for
# the same reason: robust against JSON formatting/whitespace changes.
#
# Inputs (all required, no defaults — fail loud if missing):
#   ORCE_ADMIN_URL   e.g. http://orce.orce.svc.cluster.local:1880/orce
#   ORCE_ADMIN_TOKEN bearer for the ORCE Admin API
#   KAFKA_BOOTSTRAP  e.g. 212.132.83.222:9093  (the stable address)
#   STATE_DIR        persistent dir for the "previous brokers" memo
#                     (PVC-backed; required for the 2-cycle stability rule)
#   SHARED_DIR       emptyDir shared with the init container; must already
#                     contain live-brokers.txt by the time this runs
#
# Behaviour:
#   1. Read the live broker list the init container discovered via kcat.
#   2. Read previous list from STATE_DIR/last-brokers.txt (if exists).
#   3. If list differs AND the previous list also differs from currently-deployed
#      → drift confirmed across 2 cycles → patch kafka-broker-config + POST.
#      Else: just update the memo and exit cleanly.
#   4. Always emit a one-line structured JSON log on stdout for ingestion.
set -eu

require_var() {
  v=$(eval "echo \${$1:-}")
  if [ -z "$v" ]; then
    echo "{\"level\":\"error\",\"msg\":\"missing required env var\",\"var\":\"$1\"}" >&2
    exit 2
  fi
}

require_var ORCE_ADMIN_URL
require_var ORCE_ADMIN_TOKEN
require_var KAFKA_BOOTSTRAP
require_var STATE_DIR
require_var SHARED_DIR

mkdir -p "$STATE_DIR"
PREV_FILE="$STATE_DIR/last-brokers.txt"

# Step 1: read what the init container discovered
LIVE_FILE="$SHARED_DIR/live-brokers.txt"
if [ ! -f "$LIVE_FILE" ]; then
  echo "{\"level\":\"error\",\"msg\":\"no live-brokers.txt from init container\",\"path\":\"$LIVE_FILE\"}" >&2
  exit 3
fi
LIVE_NODEPORTS=$(cat "$LIVE_FILE")
if [ -z "$LIVE_NODEPORTS" ]; then
  echo "{\"level\":\"error\",\"msg\":\"live-brokers.txt was empty\"}" >&2
  exit 3
fi

# Step 2: read previous memo
PREV_BROKERS=""
if [ -f "$PREV_FILE" ]; then
  PREV_BROKERS=$(cat "$PREV_FILE")
fi

# Step 3: fetch the broker list currently deployed for the
# `kafka-broker-config` node specifically — not any other kafka-broker-type
# node. The shared flow set also carries sftp-kafka-broker-config,
# sftp-dlq-broker-config, and dsp-consumer-kafka-broker-config (added by
# later plans on this branch), whose `broker` values are unrelated
# (`${SFTP_KAFKA_BROKERS}` substitutions) and must not be touched by this
# simulation-specific watcher.
DEPLOYED_BROKERS=$(
  curl -fsS -H "Authorization: Bearer $ORCE_ADMIN_TOKEN" \
       "$ORCE_ADMIN_URL/flows" 2>/dev/null \
  | jq -r '(.[] | select(.id == "kafka-broker-config") | .broker) // empty'
)

# Compare LIVE against currently DEPLOYED (the kafka.json broker config).
# Note we strip the bootstrap (212.132.83.222:9093) from the deployed string
# since kcat won't return that as a "broker N at" entry — it's the bootstrap
# itself. Same for any previously-bootstrap-led list.
strip_bootstrap() {
  echo "$1" | tr ',' '\n' | grep -v "^${KAFKA_BOOTSTRAP}\$" | sort -u | paste -sd, -
}

DEPLOYED_NODEPORTS=$(strip_bootstrap "$DEPLOYED_BROKERS")

if [ "$LIVE_NODEPORTS" = "$DEPLOYED_NODEPORTS" ]; then
  echo "{\"level\":\"info\",\"msg\":\"no drift\",\"live\":\"$LIVE_NODEPORTS\"}"
  echo "$LIVE_NODEPORTS" > "$PREV_FILE"
  exit 0
fi

# Drift detected — require 2-cycle stability before redeploying
if [ "$LIVE_NODEPORTS" != "$PREV_BROKERS" ]; then
  echo "{\"level\":\"warn\",\"msg\":\"drift detected, awaiting confirmation next cycle\",\"live\":\"$LIVE_NODEPORTS\",\"deployed\":\"$DEPLOYED_NODEPORTS\"}"
  echo "$LIVE_NODEPORTS" > "$PREV_FILE"
  exit 0
fi

# Two consecutive cycles agree — redeploy
echo "{\"level\":\"warn\",\"msg\":\"drift confirmed; redeploying kafka.json\",\"new\":\"$LIVE_NODEPORTS\",\"old\":\"$DEPLOYED_NODEPORTS\"}"

NEW_BROKER_STR="${KAFKA_BOOTSTRAP},${LIVE_NODEPORTS}"

# GET current flows, patch, POST.
# TMP lives on the STATE_DIR PVC, not the container's (read-only) root
# filesystem — `mktemp`'s default location is under `/tmp`, which fails
# under this CronJob's `readOnlyRootFilesystem: true` security context.
# This had (accidentally) been the only thing stopping the
# `Node-RED-Deployment-Type: full` bug below from ever firing.
TMP="$STATE_DIR/flows-redeploy.json.tmp"
curl -fsS -H "Authorization: Bearer $ORCE_ADMIN_TOKEN" "$ORCE_ADMIN_URL/flows" > "$TMP"

if ! jq -e '.[] | select(.id == "kafka-broker-config")' "$TMP" >/dev/null 2>&1; then
  echo "{\"level\":\"error\",\"msg\":\"kafka-broker-config node not found in fetched flows; refusing to POST\"}" >&2
  rm -f "$TMP"
  exit 4
fi

# jq patches ONLY the matching node's `broker` field — every other node,
# on every other service's tab on this shared pod, passes through
# byte-for-byte unchanged.
jq --arg id "kafka-broker-config" --arg broker "$NEW_BROKER_STR" \
   'map(if .id == $id then .broker = $broker else . end)' \
   "$TMP" > "$TMP.new"
mv "$TMP.new" "$TMP"

# Node-RED-Deployment-Type: nodes (merge-by-id), never `full` — a full
# deploy replaces every tab on this SHARED pod (simulation, DSP, SFTP,
# AI-insight all run here) and has already caused real incidents on this
# project. The payload above is still the complete, GET-derived flow set
# with only kafka-broker-config's `broker` field changed in place — that
# is what `nodes` mode expects (a merge target, not a diff) — it is the
# deploy-type header, not the payload shape, that must never be `full`.
curl -fsS -X POST "$ORCE_ADMIN_URL/flows" \
     -H "Authorization: Bearer $ORCE_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -H "Node-RED-Deployment-Type: nodes" \
     --data @"$TMP"

rm -f "$TMP"
echo "{\"level\":\"info\",\"msg\":\"redeploy complete\",\"new\":\"$NEW_BROKER_STR\"}"
