#!/usr/bin/env bash
# NF-10: Helm deploy / idempotent redeploy / uninstall evidence for every
# ORCE flow chart, plus zero-touch flow-deploy Job logs (machine-readable
# status lines). Emits evidence/nf10-<stamp>/ with logs + verdicts.jsonl.
set -Eeuo pipefail

NAMESPACE="${NAMESPACE:-facis}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="evidence/nf10-${STAMP}"
VERDICTS="${OUT}/verdicts.jsonl"
REPO_ROOT="$(git rev-parse --show-toplevel)"

# release:chart-path pairs (repo-root relative)
CHARTS="${CHARTS:-facis-simulation:services/simulation/helm/facis-simulation facis-sftp-ingestion:services/sftp-ingestion-service/helm/facis-sftp-ingestion facis-industrial-ingestion:services/industrial-ingestion-service/helm/facis-industrial-ingestion facis-dsp-connector:services/dsp-connector/helm/facis-dsp-connector}"

mkdir -p "${OUT}"
echo "commit: $(git rev-parse HEAD)" > "${OUT}/context.txt"
echo "namespace: ${NAMESPACE}" >> "${OUT}/context.txt"
kubectl version 2>/dev/null >> "${OUT}/context.txt" || true
helm version >> "${OUT}/context.txt"

verdict() { # verdict <check> <release> <status> [detail]
    printf '{"check":"%s","release":"%s","status":"%s","detail":"%s"}\n' \
        "$1" "$2" "$3" "${4:-}" | tee -a "${VERDICTS}"
}

orce_node_count() {
    if [ -n "${ORCE_ADMIN_URL:-}" ] && [ -n "${ORCE_ADMIN_TOKEN:-}" ]; then
        curl -sS -H "Authorization: Bearer ${ORCE_ADMIN_TOKEN}" \
            "${ORCE_ADMIN_URL}/flows" | jq 'if type == "object" then .flows else . end | length'
    else
        echo "-1"
    fi
}

capture_job_logs() { # capture_job_logs <release> <phase>
    local jobs
    jobs=$(kubectl -n "${NAMESPACE}" get jobs -o name 2>/dev/null | grep "$1" || true)
    for j in ${jobs}; do
        kubectl -n "${NAMESPACE}" logs "${j}" > "${OUT}/$1-$2-$(basename "${j}").log" 2>&1 || true
    done
    # TDR #19 machine-readable status line from the flow-deploy Job
    grep -h '"event":"orce-flow-deploy"' "${OUT}/$1-$2-"*.log 2>/dev/null | tail -1 || true
}

for pair in ${CHARTS}; do
    release="${pair%%:*}"
    chart="${REPO_ROOT}/${pair#*:}"
    echo "=== ${release} (${chart}) ==="

    [ -x "${chart}/sync-flows.sh" ] && (cd "${chart}" && ./sync-flows.sh >/dev/null)

    # --- deploy (#23, TDR #2) ---
    before_nodes=$(orce_node_count)
    if helm upgrade --install "${release}" "${chart}" -n "${NAMESPACE}" --wait --timeout 10m \
        > "${OUT}/${release}-deploy.log" 2>&1; then
        event=$(capture_job_logs "${release}" deploy)
        verdict "helm-deploy" "${release}" "pass" "${event}"
    else
        capture_job_logs "${release}" deploy
        verdict "helm-deploy" "${release}" "fail" "see ${release}-deploy.log"
        continue
    fi

    # --- idempotent redeploy (#23, TDR #2) ---
    if helm upgrade "${release}" "${chart}" -n "${NAMESPACE}" --wait --timeout 10m \
        > "${OUT}/${release}-redeploy.log" 2>&1; then
        after_nodes=$(orce_node_count)
        if [ "${before_nodes}" = "-1" ]; then
            verdict "idempotent-redeploy" "${release}" "pass" "helm ok; flow-count check skipped (no ORCE_ADMIN_URL)"
        elif [ "${after_nodes}" -ge "${before_nodes}" ]; then
            verdict "idempotent-redeploy" "${release}" "pass" "nodes ${before_nodes} -> ${after_nodes} (no tenant loss)"
        else
            verdict "idempotent-redeploy" "${release}" "fail" "node count dropped ${before_nodes} -> ${after_nodes}: tenant flows lost"
        fi
    else
        verdict "idempotent-redeploy" "${release}" "fail" "see ${release}-redeploy.log"
    fi

    # --- uninstall + cleanup check (#23) ---
    if [ "${SKIP_UNINSTALL:-0}" = "1" ]; then
        verdict "uninstall" "${release}" "skipped" "SKIP_UNINSTALL=1"
        continue
    fi
    helm uninstall "${release}" -n "${NAMESPACE}" > "${OUT}/${release}-uninstall.log" 2>&1 || true
    leftover=$(kubectl -n "${NAMESPACE}" get all,cm,secret \
        -l "app.kubernetes.io/instance=${release}" -o name 2>/dev/null | wc -l | tr -d ' ')
    if [ "${leftover}" = "0" ]; then
        verdict "uninstall-clean" "${release}" "pass" "no labeled resources left (flows persist on shared ORCE by design)"
    else
        kubectl -n "${NAMESPACE}" get all,cm,secret -l "app.kubernetes.io/instance=${release}" \
            > "${OUT}/${release}-leftovers.log" 2>&1 || true
        verdict "uninstall-clean" "${release}" "fail" "${leftover} resources left; see ${release}-leftovers.log"
    fi

    # --- restore for the next evidence steps ---
    helm upgrade --install "${release}" "${chart}" -n "${NAMESPACE}" --wait --timeout 10m \
        > "${OUT}/${release}-restore.log" 2>&1 || verdict "restore" "${release}" "fail" "see ${release}-restore.log"
done

echo
echo "Evidence bundle: ${OUT}"
echo "Verdicts:"
cat "${VERDICTS}"
if grep -q '"status":"fail"' "${VERDICTS}"; then exit 1; fi
