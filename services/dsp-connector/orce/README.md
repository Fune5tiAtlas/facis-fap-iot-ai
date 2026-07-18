# DSP Connector — ORCE Native Runtime

This directory contains the ORCE Node-RED flows that implement the DSP
connector's control plane on the shared ORCE pod.

## Layout

```
orce/
  flows/
    facis-dsp-state.json        — bootstrap & persist transfers/negotiations
    facis-dsp-health.json       — GET /api/v1/dsp/health, GET /dsp/metrics
    facis-dsp-catalogue.json    — POST /dsp/catalogue/request
    facis-dsp-negotiations.json — POST/GET /dsp/negotiations, terminate
    facis-dsp-transfers.json    — full transfer FSM + access provisioning
    facis-dsp-errors.json       — catch-all error handler
    facis-dsp-iam-verify.json   — NF-1 shared VP/VC verifier (link-call)
    facis-dsp-iam-issuance.json — did.json, OID4VCI issuer, Participant VC self-issuance
    facis-dsp-iam-hub.json      — Identity Hub query API (Mongo-backed)
  config/
    datasets.json               — static FACIS_DATASETS mirror (mounted as ConfigMap)
  tests/
    flows/                      — node --test specs
    fixtures/iam/               — golden VP/VC keys + vectors
    package.json
  README.md (this file)
```

## State storage

The flow uses two PVC-backed JSON files under `/data/dsp-state/`:
- `transfers.json` — the transfer-process map keyed by `tp-...` id
- `negotiations.json` — the negotiation map keyed by `neg-...` id

The catalogue is a read-only ConfigMap mount at `/data/dsp-config/datasets.json`.

**Single-replica only**: the file-based state is not multi-replica safe.
The ORCE pod must run with `replicas: 1`. Postgres backing is out of scope
for this migration.

## Endpoint paths

To avoid colliding with the Simulation flow's `/api/v1/health` and `/metrics`
on the shared ORCE pod, DSP endpoints are namespaced:

| Concern | Path |
|---------|------|
| Health  | `GET /api/v1/dsp/health` |
| Metrics | `GET /dsp/metrics`       |
| Catalogue | `POST /dsp/catalogue/request` |
| Transfers | `POST/GET /dsp/transfers...`  |
| Negotiations | `POST/GET /dsp/negotiations...` |

## Tests

```sh
cd services/dsp-connector/orce
npm install --include=dev
node --test tests/flows
```

The specs re-implement each function-node body inline and exercise it under
`node:test`. **Invariant**: keep the spec helpers in sync with the function-node
`func` strings in the corresponding flow JSON.

## Deploy

The chart's `sync-flows.sh` copies these files into
`helm/facis-dsp-connector/files/orce-flows/` (and `orce-config/`) before
`helm install/upgrade`. The post-install Job fetches the ORCE pod's live
flow set, merges these tabs into it by node id, and POSTs the merged set
back to the ORCE Admin API at `${orceAdminUrl}/flows` with
`Node-RED-Deployment-Type: nodes` — never a full-replace, which would wipe
every other service's tabs on the shared pod.

See `helm/facis-dsp-connector/README.md` for the full deploy procedure and
the ORCE-chart prerequisites (envFrom secrets, volume mounts).
