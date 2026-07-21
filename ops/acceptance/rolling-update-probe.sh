#!/usr/bin/env bash
# NF-10 / QA test #25: rolling update without downtime.
# Continuously probes PROBE_URL while a rollout runs, then reports the number
# of failed probes and the longest unhealthy streak (downtime proxy).
#
# For the shared ORCE pod (strategy: Recreate, single writer on the flows
# PVC) downtime is expected by design — pass RECREATE_EXPECTED=1 to record it
# as a measured deviation rather than a failure.
set -Eeuo pipefail

NAMESPACE="${NAMESPACE:?set NAMESPACE}"
DEPLOYMENT="${DEPLOYMENT:?set DEPLOYMENT}"
PROBE_URL="${PROBE_URL:?set PROBE_URL}"
RECREATE_EXPECTED="${RECREATE_EXPECTED:-0}"
INTERVAL_MS="${INTERVAL_MS:-200}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="evidence/rolling-${DEPLOYMENT}-${STAMP}.json"
mkdir -p evidence

probes=0; failures=0; cur_streak=0; max_streak=0
probe_loop() {
    while [ -f /tmp/nf10-rolling-${STAMP}.run ]; do
        probes=$((probes + 1))
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${PROBE_URL}" || echo 000)
        if [ "${code}" = "200" ]; then
            cur_streak=0
        else
            failures=$((failures + 1)); cur_streak=$((cur_streak + 1))
            [ "${cur_streak}" -gt "${max_streak}" ] && max_streak=${cur_streak}
        fi
        sleep "$(awk "BEGIN{print ${INTERVAL_MS}/1000}")"
    done
    echo "${probes} ${failures} ${max_streak}" > /tmp/nf10-rolling-${STAMP}.out
}

touch /tmp/nf10-rolling-${STAMP}.run
probe_loop &
PROBE_PID=$!

echo "Triggering rollout of ${DEPLOYMENT}..."
kubectl -n "${NAMESPACE}" rollout restart "deployment/${DEPLOYMENT}"
kubectl -n "${NAMESPACE}" rollout status "deployment/${DEPLOYMENT}" --timeout=10m

rm -f /tmp/nf10-rolling-${STAMP}.run
wait "${PROBE_PID}" 2>/dev/null || true
read -r probes failures max_streak < /tmp/nf10-rolling-${STAMP}.out
rm -f /tmp/nf10-rolling-${STAMP}.out

downtime_ms=$((max_streak * INTERVAL_MS))
if [ "${failures}" -eq 0 ]; then
    status="pass"
elif [ "${RECREATE_EXPECTED}" = "1" ]; then
    status="deviation-expected"
else
    status="fail"
fi

cat > "${OUT}" <<EOF
{
  "check": "rolling-update-no-downtime",
  "qa_test": 25,
  "deployment": "${DEPLOYMENT}",
  "namespace": "${NAMESPACE}",
  "probes": ${probes},
  "failed_probes": ${failures},
  "max_unhealthy_streak_probes": ${max_streak},
  "approx_downtime_ms": ${downtime_ms},
  "recreate_expected": ${RECREATE_EXPECTED},
  "status": "${status}"
}
EOF
cat "${OUT}"
[ "${status}" != "fail" ]
