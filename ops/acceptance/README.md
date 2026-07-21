# IONOS Target-Cluster Acceptance Evidence Harness (NF-10)

Scripted, repeatable capture of the operational acceptance evidence
(QA tests #23–#25, TDR #2/#19, RFC Q-11) against the target cluster. Every
script emits machine-readable JSON verdicts alongside the raw logs; the
whole `evidence/` directory of a run is the deliverable bundle.

| Evidence | QA ref | Script |
|---|---|---|
| Helm deploy / idempotent redeploy / uninstall per chart | #23, TDR #2 | `nf10-evidence.sh` |
| Zero-touch ORCE flow deploy with machine-readable errors | TDR #19 | `nf10-evidence.sh` (Job logs; the deploy Jobs now emit `{"event":"orce-flow-deploy",...}` status lines) |
| Health reports healthy within 30 s of startup | #24 | `health-within-30s.sh` |
| Rolling update without downtime | #25 | `rolling-update-probe.sh` |

## Prerequisites

`kubectl` + `helm` against the target cluster, `jq`, and (for the
flow-preservation check) `ORCE_ADMIN_URL` + `ORCE_ADMIN_TOKEN`. Run from the
repo root on the exact commit being accepted; record `git rev-parse HEAD`
with the bundle.

## Running

```bash
cd ops/acceptance
mkdir -p evidence

# 1. Deploy / idempotent redeploy / uninstall cycle for every flow chart.
NAMESPACE=facis ./nf10-evidence.sh

# 2. Health within 30 s (restarts the ORCE pod — announce before running).
NAMESPACE=orce DEPLOYMENT=orce HEALTH_URL=https://<orce>/api/v1/health ./health-within-30s.sh

# 3a. Rolling update without downtime — stateless service (expected PASS).
NAMESPACE=facis DEPLOYMENT=<ai-insight-deploy> PROBE_URL=https://<ai>/api/v1/health ./rolling-update-probe.sh

# 3b. ORCE pod restart — measured downtime (expected deviation, see below).
NAMESPACE=orce DEPLOYMENT=orce PROBE_URL=https://<orce>/api/v1/health RECREATE_EXPECTED=1 ./rolling-update-probe.sh
```

## Honest findings the evidence will show (state them, don't hide them)

1. **Test 25 vs the shared ORCE pod**: `services/simulation/k8s/orce/orce-deployment.yaml`
   deliberately uses `strategy: Recreate` (single writer on the flows PVC).
   A zero-downtime rolling update of that pod is impossible **by design**;
   the script measures and reports the actual gap instead. This belongs in
   the deviation register (NF-15) with the PVC single-writer rationale.
   Stateless service Deployments (ai-insight, etc.) roll normally and are
   the PASS evidence for #25.
2. **Uninstall semantics on the shared runtime**: `helm uninstall` removes
   the chart's Kubernetes resources (ConfigMap, Job, Secret, SA). Flows
   already deployed onto the shared ORCE runtime are **not** withdrawn —
   flow removal is a manual Admin-API operation. The script verifies clean
   resource removal and documents the flow persistence explicitly.
3. **Idempotent redeploy proof**: the second `helm upgrade` must succeed AND
   the ORCE runtime must end with the same flow set (node count unchanged,
   every other tenant's tabs still present) — that is what the merge-safe
   deploy Jobs guarantee and what the script asserts via the Admin API.
