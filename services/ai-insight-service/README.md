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

Deployment: the ORCE runtime is built from [`orce/`](orce/) (its own
Dockerfile bundles the flows onto the `xfsc-orce` base). The former Python-app
deployment (`helm/facis-ai-insight`, `k8s/`) has been removed.

> Note: `docs/guides/*` and `docs/deployment/*` still describe the old Python
> deployment and are pending a documentation refresh.

## Governance and Compliance

- [SECURITY.md](SECURITY.md)
- [NOTICE.md](NOTICE.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [LICENSE](LICENSE)
