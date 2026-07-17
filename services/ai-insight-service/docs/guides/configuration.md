# Configuration Guide

## Layered Configuration Model

Configuration is resolved in this order (later entries override earlier entries):

1. `config/default.yaml`
2. `config/{FACIS_ENV}.yaml` (for example: `development`, `test`, `production`)
3. Environment variables prefixed with `AI_INSIGHT_` using `__` as nested separator

Example:

- `AI_INSIGHT_TRINO__HOST` -> `trino.host`
- `AI_INSIGHT_RATE_LIMIT__REQUESTS_PER_MINUTE` -> `rate_limit.requests_per_minute`

## Baseline Defaults

Important defaults from `config/default.yaml`:

| Key | Default |
|---|---|
| `http.host` | `0.0.0.0` |
| `http.port` | `8080` |
| `llm.model` | `gpt-4.1-mini` |
| `trino.catalog` | `hive` |
| `trino.target_schema` | `gold` |
| `policy.enabled` | `true` |
| `rate_limit.enabled` | `true` |
| `rate_limit.requests_per_minute` | `10` |
| `trino.http_scheme` | `http` |
| `trino.verify` | `true` |
| `trino.request_timeout_seconds` | `120` |
| `cache.enabled` | `false` |
| `audit.enabled` | `true` |

> **Note on Trino port:** The default in `config/default.yaml` is `8080` (plain HTTP, for local
> dev). The Helm chart default is `8443` (HTTPS, for cluster deployments with Stackable Trino).
> Always set `AI_INSIGHT_TRINO__PORT` explicitly to match your Trino coordinator's actual port.

## Key Environment Variable Groups

### Runtime

- `FACIS_ENV`

### HTTP

- `AI_INSIGHT_HTTP__HOST`
- `AI_INSIGHT_HTTP__PORT`

### LLM Provider

- `AI_INSIGHT_LLM__API_KEY`
- `AI_INSIGHT_LLM__MODEL`
- `AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL`
- `AI_INSIGHT_LLM__TIMEOUT_SECONDS`
- `AI_INSIGHT_LLM__MAX_RETRIES`
- `AI_INSIGHT_LLM__RETRY_BASE_DELAY_SECONDS`
- `AI_INSIGHT_LLM__RETRY_MAX_DELAY_SECONDS`
- `AI_INSIGHT_LLM__REQUIRE_HTTPS`

### Trino and OIDC

- `AI_INSIGHT_TRINO__HOST`
- `AI_INSIGHT_TRINO__PORT`
- `AI_INSIGHT_TRINO__USER`
- `AI_INSIGHT_TRINO__OIDC_TOKEN_URL`
- `AI_INSIGHT_TRINO__OIDC_CLIENT_ID`
- `AI_INSIGHT_TRINO__OIDC_CLIENT_SECRET`
- `AI_INSIGHT_TRINO__OIDC_USERNAME`
- `AI_INSIGHT_TRINO__OIDC_PASSWORD`
- `AI_INSIGHT_TRINO__OIDC_SCOPE`
- `AI_INSIGHT_TRINO__HTTP_SCHEME` — `http` (dev) or `https` (cluster)
- `AI_INSIGHT_TRINO__OIDC_VERIFY`
- `AI_INSIGHT_TRINO__VERIFY` — `true`, `false`, or path to CA cert (e.g. `/app/certs/trino-ca.crt`)
- `AI_INSIGHT_TRINO__REQUEST_TIMEOUT_SECONDS` — default `120`
- `AI_INSIGHT_TRINO__CATALOG`
- `AI_INSIGHT_TRINO__SCHEMA`
- `AI_INSIGHT_TRINO__TARGET_SCHEMA`
- `AI_INSIGHT_TRINO__TABLE_NET_GRID_HOURLY` — default `net_grid_hourly`
- `AI_INSIGHT_TRINO__TABLE_EVENT_IMPACT_DAILY` — default `event_impact_daily`
- `AI_INSIGHT_TRINO__TABLE_STREETLIGHT_ZONE_HOURLY` — default `streetlight_zone_hourly`
- `AI_INSIGHT_TRINO__TABLE_WEATHER_HOURLY` — default `weather_hourly`
- `AI_INSIGHT_TRINO__TABLE_ENERGY_COST_DAILY` — default `energy_cost_daily`
- `AI_INSIGHT_TRINO__TABLE_PV_SELF_CONSUMPTION_DAILY` — default `pv_self_consumption_daily`

### Policy and Rate Limiting

- `AI_INSIGHT_POLICY__ENABLED`
- `AI_INSIGHT_POLICY__AGREEMENT_HEADER`
- `AI_INSIGHT_POLICY__ASSET_HEADER`
- `AI_INSIGHT_POLICY__ROLE_HEADER`
- `AI_INSIGHT_POLICY__REQUIRED_ROLES`
- `AI_INSIGHT_POLICY__ALLOWED_AGREEMENT_IDS`
- `AI_INSIGHT_POLICY__ALLOWED_ASSET_IDS`
- `AI_INSIGHT_RATE_LIMIT__ENABLED`
- `AI_INSIGHT_RATE_LIMIT__REQUESTS_PER_MINUTE`

> **`GET /api/data/{asset_id}` derives its access context from the signed URL, not
> headers.** This route (mounted at the literal `/api/data` prefix -- it's what
> dsp-connector signs for, replacing the old un-matching `/api/v1/dsp/pull` stub)
> verifies the HMAC `token` query parameter, then enforces `PolicyEnforcer` using
> the `agreementId`/`roles` query params bound into that same signature -- never
> from `x-agreement-id`/`x-asset-id`/`x-user-roles` headers. Those three headers
> (`AI_INSIGHT_POLICY__AGREEMENT_HEADER`/`ASSET_HEADER`/`ROLE_HEADER`) remain in
> effect only for `POST /api/v1/dsp/create-pull-url`'s own admission check, which
> is a separate, unchanged signing path.
>
> **Accepted consequence for legacy/Python-mode dsp-connector deployments:**
> dsp-connector's Python/legacy runtime always signs an empty `roles` claim (NF-1
> identity verification only exists in the ORCE runtime), and
> `AI_INSIGHT_POLICY__REQUIRED_ROLES` defaults to `["ai_insight_consumer"]`. Under
> the default policy config, every data pull from a `compatibilityMode: legacy`
> dsp-connector deployment now gets a 403 at `/api/data/{asset_id}` -- this used to
> work, because the stub it replaced was HMAC-only with no role check. This was
> reviewed and accepted: legacy mode is a documented rollback fallback with no real
> identity verification, so it shouldn't retain real data access now that access
> control is actually enforced. Operators who need legacy-mode pulls to keep
> working must explicitly set `AI_INSIGHT_POLICY__REQUIRED_ROLES` to `[]` (empty),
> or migrate the deployment to ORCE mode instead.

### Cache and Audit

- `AI_INSIGHT_CACHE__ENABLED`
- `AI_INSIGHT_CACHE__BACKEND`
- `AI_INSIGHT_CACHE__REDIS_URL`
- `AI_INSIGHT_CACHE__TTL_SECONDS`
- `AI_INSIGHT_CACHE__KEY_PREFIX`
- `AI_INSIGHT_AUDIT__ENABLED`
- `AI_INSIGHT_AUDIT__LOGGER_NAME`

## Secure Configuration Recommendations

- Keep OIDC client secret, user credentials, and API keys in secret stores.
- Use HTTPS endpoints for LLM provider URLs and Trino in non-local environments.
- Keep policy and rate-limiting enabled outside local debugging.
- Disable audit prompt/response logging where policy requires reduced data retention.

## Reference Files

- `config/default.yaml`
- `config/development.yaml`
- `config/test.yaml`
- `config/production.yaml`
- `.env.example`
