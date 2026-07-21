#!/usr/bin/env bash
# NF-10 / QA test #24: health endpoint reports healthy within 30 s of startup.
# Restarts the deployment, then polls the health URL until 200, measuring the
# elapsed time from rollout start to first healthy response.
set -Eeuo pipefail

NAMESPACE="${NAMESPACE:-orce}"
DEPLOYMENT="${DEPLOYMENT:-orce}"
HEALTH_URL="${HEALTH_URL:?set HEALTH_URL to the service health endpoint}"
BUDGET_S="${BUDGET_S:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="evidence/health-${DEPLOYMENT}-${STAMP}.json"
mkdir -p evidence

echo "Restarting ${DEPLOYMENT} in ${NAMESPACE}..."
kubectl -n "${NAMESPACE}" rollout restart "deployment/${DEPLOYMENT}"
start=$(date +%s)

healthy_at=""
while true; do
    now=$(date +%s)
    elapsed=$((now - start))
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${HEALTH_URL}" || echo 000)
    if [ "${code}" = "200" ]; then
        healthy_at=${elapsed}
        break
    fi
    if [ "${elapsed}" -gt $((BUDGET_S * 3)) ]; then
        break
    fi
    sleep 1
done

if [ -n "${healthy_at}" ] && [ "${healthy_at}" -le "${BUDGET_S}" ]; then
    status="pass"
elif [ -n "${healthy_at}" ]; then
    status="fail"   # became healthy, but over budget
else
    status="fail"   # never healthy within 3x budget
    healthy_at=-1
fi

cat > "${OUT}" <<EOF
{
  "check": "health-within-30s",
  "qa_test": 24,
  "deployment": "${DEPLOYMENT}",
  "namespace": "${NAMESPACE}",
  "budget_seconds": ${BUDGET_S},
  "healthy_after_seconds": ${healthy_at},
  "status": "${status}"
}
EOF
cat "${OUT}"
[ "${status}" = "pass" ]
