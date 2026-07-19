#!/bin/sh
# discover-kafka-brokers.sh — init container step for the
# kafka-broker-watcher CronJob. Uses kcat (only available in this
# container's image, not in the main container's curl/jq image — see
# watch-kafka-brokers.sh's header for why the job is split this way) to
# discover the live Stackable Kafka broker NodePorts, and hands the result
# to the main container via a shared emptyDir volume.
#
# Inputs (all required, no defaults — fail loud if missing):
#   KAFKA_BOOTSTRAP   e.g. 212.132.83.222:9093  (the stable address)
#   KAFKA_CERT_DIR    mount path to ca.crt / tls.crt / tls.key
#   SHARED_DIR        emptyDir shared with the main container
set -eu

require_var() {
  v=$(eval "echo \${$1:-}")
  if [ -z "$v" ]; then
    echo "{\"level\":\"error\",\"msg\":\"missing required env var\",\"var\":\"$1\"}" >&2
    exit 2
  fi
}

require_var KAFKA_BOOTSTRAP
require_var KAFKA_CERT_DIR
require_var SHARED_DIR

LIVE_BROKERS=$(
  kcat -L -b "$KAFKA_BOOTSTRAP" \
       -X security.protocol=ssl \
       -X "ssl.ca.location=$KAFKA_CERT_DIR/ca.crt" \
       -X "ssl.certificate.location=$KAFKA_CERT_DIR/tls.crt" \
       -X "ssl.key.location=$KAFKA_CERT_DIR/tls.key" \
       -X ssl.endpoint.identification.algorithm=none 2>/dev/null \
  | awk '/broker [0-9]+ at /{print $4}' \
  | sort -u \
  | paste -sd, -
)

if [ -z "$LIVE_BROKERS" ]; then
  echo "{\"level\":\"error\",\"msg\":\"kcat returned no brokers\",\"bootstrap\":\"$KAFKA_BOOTSTRAP\"}" >&2
  exit 3
fi

echo "$LIVE_BROKERS" > "$SHARED_DIR/live-brokers.txt"
echo "{\"level\":\"info\",\"msg\":\"discovered live brokers\",\"live\":\"$LIVE_BROKERS\"}"
