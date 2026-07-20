#!/usr/bin/env bash
# Copy ORCE flow JSON files into the chart's files/ directory so Helm can
# bundle them into the orce-flows ConfigMap at render time.
#
# Run before `helm install/upgrade` whenever the flow JSON changes.
#
# Usage:
#   cd services/industrial-ingestion-service/helm/facis-industrial-ingestion
#   ./sync-flows.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCE_DIR="${SCRIPT_DIR}/../../orce"
DEST="${SCRIPT_DIR}/files/orce-flows"

if [[ ! -d "${ORCE_DIR}/flows" ]]; then
    echo "error: ${ORCE_DIR}/flows not found" >&2
    exit 1
fi

mkdir -p "${DEST}"

# Wipe stale copies first so removed flows don't linger in the ConfigMap.
find "${DEST}" -maxdepth 1 -type f -name '*.json' -delete

cp -v "${ORCE_DIR}"/flows/*.json "${DEST}/"

echo
echo "Synced flows to ${DEST}"
ls -1 "${DEST}"/*.json | sed 's|.*/|  |'
