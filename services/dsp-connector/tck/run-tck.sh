#!/usr/bin/env bash
# Run the Eclipse DSP TCK (catalogue + transfer suites) against the deployed
# FACIS DSP connector and capture the QA evidence log (NF-7).
#
# Usage:
#   cd services/dsp-connector/tck
#   ./run-tck.sh [config.properties]
set -Eeuo pipefail

TCK_IMAGE="${TCK_IMAGE:-eclipsedataspacetck/dsp-tck-runtime:1.0.1}"
CONFIG="${1:-tck.properties}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="evidence"
LOG="${EVIDENCE_DIR}/tck-run-${STAMP}.log"

mkdir -p "${EVIDENCE_DIR}"

echo "TCK image:  ${TCK_IMAGE}" | tee "${LOG}"
echo "Config:     ${CONFIG}" | tee -a "${LOG}"
echo "Started at: ${STAMP}" | tee -a "${LOG}"
docker image inspect "${TCK_IMAGE}" --format 'Image digest: {{index .RepoDigests 0}}' 2>/dev/null | tee -a "${LOG}" || true
echo "---" | tee -a "${LOG}"

# host.docker.internal works on Docker Desktop; on Linux, add the host gateway.
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -p 8083:8083 \
  -v "$(pwd)/${CONFIG}:/etc/tck/config.properties:ro" \
  "${TCK_IMAGE}" 2>&1 | tee -a "${LOG}"

echo "---" | tee -a "${LOG}"
echo "Finished at: $(date -u +%Y%m%dT%H%M%SZ)" | tee -a "${LOG}"
echo
echo "Evidence log: ${LOG}"
grep -E "Passed tests|Failed tests" "${LOG}" || true
