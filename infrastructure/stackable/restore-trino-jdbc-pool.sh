#!/usr/bin/env bash
# Repoint the NiFi "Trino JDBC Pool" controller service from the Maven URL
# (or stale /tmp/ path) to the file:// path provided by the
# nifi-jdbc-podoverride.yaml mount.
#
# Steps:
#   1. Get an OIDC bearer token from Keycloak.
#   2. Stop every processor that references the controller service.
#   3. Disable the controller service.
#   4. Update properties.database-driver-locations.
#   5. Re-enable the controller service.
#   6. Re-start the previously-stopped processors.
#
# Idempotent. Safe to re-run if a step partial-fails.
#
# Usage:
#   bash infrastructure/stackable/restore-trino-jdbc-pool.sh
#
# Requires: kubectl auth to the Stackable cluster; KC_USER/KC_PASS/
# KC_CLIENT_SECRET from your credential store (no defaults — see below)
set -euo pipefail

NIFI_BASE="${NIFI_BASE:-https://212.132.83.82:8443}"
SVC_ID="${SVC_ID:-62a9f79e-019d-1000-ffff-ffffd500f838}"
NEW_DRIVER_PATH="${NEW_DRIVER_PATH:-file:///stackable/userdata/jdbc/trino-jdbc-467.jar}"

KC_BASE="${KC_BASE:-https://identity.facis.cloud}"
KC_CLIENT_ID="${KC_CLIENT_ID:-OIDC}"

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
api()  { curl -sSk -H "Authorization: Bearer $TOKEN" "$@"; }

require_var() {
  if [ -z "${!1:-}" ]; then
    echo "Missing required env var: $1" >&2
    exit 2
  fi
}
require_var KC_USER
require_var KC_PASS
require_var KC_CLIENT_SECRET

log "1. Getting Keycloak OIDC token (user=$KC_USER)..."
TOKEN=$(curl -sSk -X POST "$KC_BASE/realms/facis/protocol/openid-connect/token" \
  -d 'grant_type=password' \
  -d "client_id=$KC_CLIENT_ID" \
  -d "client_secret=$KC_CLIENT_SECRET" \
  -d "username=$KC_USER" \
  --data-urlencode "password=$KC_PASS" \
  -d 'scope=openid' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

log "2. Reading current controller-service state..."
api "$NIFI_BASE/nifi-api/controller-services/$SVC_ID" > /tmp/svc.json
STATE=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["component"]["state"])')
REV=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["revision"]["version"])')
CUR_DRIVER=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["component"]["properties"]["database-driver-locations"])')
log "   state=$STATE  revision=$REV  driver=$CUR_DRIVER"

if [ "$CUR_DRIVER" = "$NEW_DRIVER_PATH" ] && [ "$STATE" = "ENABLED" ]; then
  log "Driver already set to $NEW_DRIVER_PATH and service is ENABLED — nothing to do."
  exit 0
fi

log "3. Listing processors that reference this controller service..."
api "$NIFI_BASE/nifi-api/controller-services/$SVC_ID/references" > /tmp/refs.json
REF_PROC_IDS=$(python3 -c '
import json
d = json.load(open("/tmp/refs.json"))
ids = []
for r in d.get("controllerServiceReferencingComponents", []):
    c = r.get("component", {})
    if c.get("referenceType") == "Processor" and c.get("state") in ("RUNNING", "STOPPED"):
        ids.append((c["id"], c.get("state"), r["revision"]["version"]))
print(json.dumps(ids))
')
log "   referenced processors: $REF_PROC_IDS"

log "4. Stopping any RUNNING referencing processor(s)..."
for entry in $(python3 -c "
import json
for pid, st, rev in json.loads('''$REF_PROC_IDS'''):
    if st == 'RUNNING':
        print(f'{pid}|{rev}')
"); do
  PID="${entry%|*}"; PROC_REV="${entry#*|}"
  api -X PUT "$NIFI_BASE/nifi-api/processors/$PID/run-status" \
    -H 'Content-Type: application/json' \
    -d "{\"revision\":{\"version\":$PROC_REV},\"state\":\"STOPPED\",\"disconnectedNodeAcknowledged\":false}" > /dev/null
  log "   stopped $PID"
done

log "5. Polling until controller-service references are all stopped..."
for i in $(seq 1 30); do
  api "$NIFI_BASE/nifi-api/controller-services/$SVC_ID/references" > /tmp/refs.json
  STILL=$(python3 -c '
import json
d=json.load(open("/tmp/refs.json"))
n=0
for r in d.get("controllerServiceReferencingComponents", []):
    if r["component"].get("state") == "RUNNING": n+=1
print(n)')
  [ "$STILL" -eq 0 ] && break
  sleep 1
done

log "6. Disabling controller service (current rev=$REV)..."
api -X PUT "$NIFI_BASE/nifi-api/controller-services/$SVC_ID/run-status" \
  -H 'Content-Type: application/json' \
  -d "{\"revision\":{\"version\":$REV},\"state\":\"DISABLED\",\"disconnectedNodeAcknowledged\":false}" > /tmp/disable.json

log "7. Polling until DISABLED..."
for i in $(seq 1 30); do
  api "$NIFI_BASE/nifi-api/controller-services/$SVC_ID" > /tmp/svc.json
  STATE=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["component"]["state"])')
  [ "$STATE" = "DISABLED" ] && break
  sleep 1
done
log "   state=$STATE"

REV=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["revision"]["version"])')

log "8. Updating database-driver-locations to $NEW_DRIVER_PATH ..."
PATCH_BODY=$(python3 -c "
import json
print(json.dumps({
    'revision': {'version': $REV},
    'component': {
        'id': '$SVC_ID',
        'properties': {'database-driver-locations': '$NEW_DRIVER_PATH'}
    }
}))")
api -X PUT "$NIFI_BASE/nifi-api/controller-services/$SVC_ID" \
  -H 'Content-Type: application/json' \
  -d "$PATCH_BODY" > /tmp/patched.json
NEW_REV=$(python3 -c 'import json;print(json.load(open("/tmp/patched.json"))["revision"]["version"])')
log "   new revision=$NEW_REV"

log "9. Re-enabling controller service..."
api -X PUT "$NIFI_BASE/nifi-api/controller-services/$SVC_ID/run-status" \
  -H 'Content-Type: application/json' \
  -d "{\"revision\":{\"version\":$NEW_REV},\"state\":\"ENABLED\",\"disconnectedNodeAcknowledged\":false}" > /tmp/enable.json

log "10. Polling until ENABLED + VALID..."
for i in $(seq 1 60); do
  api "$NIFI_BASE/nifi-api/controller-services/$SVC_ID" > /tmp/svc.json
  STATE=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["component"]["state"])')
  VALIDATION=$(python3 -c 'import json;print(json.load(open("/tmp/svc.json"))["component"]["validationStatus"])')
  [ "$STATE" = "ENABLED" ] && [ "$VALIDATION" = "VALID" ] && break
  sleep 2
done
log "   state=$STATE  validation=$VALIDATION"

log "11. Restarting previously-stopped referencing processors..."
for entry in $(python3 -c "
import json
for pid, st, rev in json.loads('''$REF_PROC_IDS'''):
    if st == 'RUNNING':
        print(pid)
"); do
  api "$NIFI_BASE/nifi-api/processors/$entry" > /tmp/proc.json
  PROC_REV=$(python3 -c 'import json;print(json.load(open("/tmp/proc.json"))["revision"]["version"])')
  api -X PUT "$NIFI_BASE/nifi-api/processors/$entry/run-status" \
    -H 'Content-Type: application/json' \
    -d "{\"revision\":{\"version\":$PROC_REV},\"state\":\"RUNNING\",\"disconnectedNodeAcknowledged\":false}" > /dev/null
  log "   started $entry"
done

log "Done."
