# FACIS AI Insight Service

Governed AI insight generation from energy and IoT datasets. This service is
**ORCE-native**: the runtime is the Node-RED (ORCE) flows under
[`orce/`](orce/). The former Python/FastAPI implementation has been removed —
the ORCE flows serve the same HTTP contract.

## What This Service Provides

- Governed insight endpoints (`anomaly-report`, `city-status`, `energy-summary`)
- Verified-token authorization (Keycloak) and agreement-scoped rate limiting
- Trino-backed analytics context for deterministic insight pipelines
- OpenAI-compatible LLM summarization with rule-based fallback behavior
- Output retrieval endpoints

## Runtime (ORCE)

The flows and their runtime live under [`orce/`](orce/README.md). Endpoints:

- `GET /api/v1/health`
- `POST /api/v1/insights/{anomaly-report,energy-summary,city-status}`
- `GET /api/v1/insights/latest`
- `GET /api/ai/outputs/{output_id}`
- `GET /openapi.json`, `/docs`, `/redoc`

Authorization derives from verified Keycloak access tokens (roles from
`realm_access.roles`); see [`docs/api/verified-token-authz.md`](docs/api/verified-token-authz.md).

Tests: `cd orce && npm run test:flows`.

## Documentation

- [Documentation hub](docs/README.md)
- [OpenAPI contract](docs/openapi.yaml)
- [REST API reference](docs/api/rest-api.md)
- [Verified-token authorization](docs/api/verified-token-authz.md)

Deployment: the AI Insight backend runs **ORCE-native**. As of 2026-07-24 its
flows are **consolidated onto the shared `orce` runtime** (namespace `orce`)
instead of a separate `ai-insight-service:8080` deployment: the 7 flow tabs in
[`orce/flows/`](orce/flows/) plus their subflows are merged into the shared
runtime's flow set, and the AI Insight UI proxy reaches them over loopback
(`AI_INSIGHT_BASE_URL=http://127.0.0.1:1880`, now the default in the
`ai-insight-ui` helm values / configmap). The health tab
(`tab_ai_insight_bootstrap`, `GET /api/v1/health`) is dropped on merge because the
shared runtime already serves that route. The former Python-app deployment
(`helm/facis-ai-insight`, `k8s/`) and the standalone `orce/` container image are
no longer deployed.

To (re)deploy the flows: merge `orce/flows/*.json` (excluding
`tab_ai_insight_bootstrap`) into the shared runtime's **current** flow set and
`POST /orce/flows` as a full deploy. Do NOT POST only these flows — a full deploy
of a partial set wipes the other services' tabs on the shared runtime.

Auth mode: the UI proxy is a trusted gateway that strips client headers and
injects `x-user-roles`, forwarding no bearer token, so the backend must run in
header-trust mode — set **`AI_INSIGHT_AUTH__MODE=off`** on the shared runtime
(secret `facis-ai-insight-secrets`). With the default `enforce`, every
`/api/v1/insights/*` call returns `401 Authorization: Bearer <access token> is
required` and the UI hangs on "Generating insights…". For per-user verified-token
auth instead, set `AI_INSIGHT_AUTH__MODE=enforce` with `AI_INSIGHT_AUTH__ISSUER`
+ `AI_INSIGHT_AUTH__JWKS_URL`, and change the proxy to forward the caller's
Keycloak bearer token.

> Note: `docs/guides/*` and `docs/deployment/*` still describe the old Python
> deployment and are pending a documentation refresh.

## Governance and Compliance

- [SECURITY.md](SECURITY.md)
- [NOTICE.md](NOTICE.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [LICENSE](LICENSE)
