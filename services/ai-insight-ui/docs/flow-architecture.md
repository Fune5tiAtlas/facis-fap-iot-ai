# AI Insight UI — Flow Architecture

## Overview

The AI Insight Dashboard is a Vue 3 SPA served by UIBUILDER from inside the
ORCE pod. All backend communication flows over a single UIBUILDER WebSocket
channel using the FAP General Guideline §9 message contract; HTTP routes
exist only for the simulation snapshot endpoints, the AI Insight backend's
`/api/v1/insights/*`, the operator-facing `/api/v1/_internal/*`, and the
standard FAP deploy endpoint at `/api/v1/aiInsight/deploy`.

The architecture follows FAP General Guideline §10 (root dispatcher +
responsibility-based subflows) and §11 (one inbound handler + one outbound
command on the frontend).

## High-level topology

```
Browser (Vue 3 SPA at https://fap-iotai.facis.cloud/orce/aiInsight/)
   │
   │  HTTP GET /orce/aiInsight/*       ← UIBUILDER httpNode middleware (assets)
   │  WebSocket /orce/aiInsight/socket.io/   ← single bidirectional channel
   ▼
ORCE pod (Node-RED + UIBUILDER) — root dispatcher tab
   │
   ▼
[uibuilder in] ─→ [fn_normalize] ─→ [fn_validate] ─→ [switch by msg._req.action]
                                                          │
                                                          ▼ responsibility subflows:
                                                            • ping
                                                            • bootstrap.session
                                                            • alerts.*
                                                            • data-sources.*
                                                            • provenance.*
                                                            • integrations.*
                                                            • schemas.*
                                                            • admin.*
                                                            • smart-city.*
                                                            • data-products.*
                                                            • analytics.*
                                                            • insight.request   (legacy AI Assistant)
                                                            • llm.freeform      (legacy LLM Router)
                                                            • trino.query       (legacy Trino client)
                                                          │
                                                          ▼ each subflow writes msg._result = { ok, data?, errors? }
[link-from-response] ─→ [fn_build_response] ─→ [merge-session-send] ─→ [uibuilder out]
                                                                              │
                                                          ▼ broadcast events (no _socketId):
                                                            alerts.new (from fn_alerts_writer)
                                                            kpi.update (from trino tab)
[link-from-broadcast] ─────────────────────────────────────→ [merge-session-send] ─→ [uibuilder out]
```

## Tabs and subflows

### Frontend-facing tabs (`flows/tabs/`)

| Tab | File | Responsibility |
|---|---|---|
| Dispatcher | `0-Dispatcher.json` | Root dispatcher: normalize, validate, switch-by-action, build §9 response, merge-and-send. Owns the single `aiInsightUibuilder` node. |
| AI Insight Proxy | `1-AI-Insight-Proxy.json` | Routes `insight.request` smart-prompt actions to the AI Insight backend (`/api/v1/insights/*`). Dual-shape adapter accepts both FAP `_req.payload` and legacy `data.recordDetails`. |
| LLM Router | `2-LLM-Router.json` | Multi-provider LLM (OpenAI / Claude / Custom). Fetches Trino context, builds prompt, calls provider, normalises response. |
| Trino Query | `3-Trino-Query.json` | Direct Trino client used by the AI Assistant for KPI snapshots and ad-hoc queries. |
| Session Context | `4-Session-Context.json` | Per-`_socketId` session lifecycle (connect / disconnect / ready), conversation history (cap 20), bootstrap subflow, internal `/api/v1/_internal/connections` endpoint, 5-minute watchdog pruning sessions older than 1h. |

### Backend subflows (`orce/flows/`)

| File | Action namespace | Backing data source |
|---|---|---|
| `ping.json` | `ping` | None — synthetic round-trip used by smoke tests (FAP §18 step 4) |
| `alerts.json` | `alerts.list` / `alerts.detail` / `alerts.acknowledge` | `global.alerts` ring buffer (500 entries) populated by the catch node. Also broadcasts `alerts.new` events on every new entry. |
| `data-sources.json` | `data-sources.list` | `global.latest_meters` / `latest_pv` / `latest_weather` / `latest_price` / `latest_consumers` snapshots populated by the simulation feeds tab |
| `provenance.json` | `provenance.transfers` / `provenance.insights` | `global.transfers` (DSP) / `global.ai_insight_outputs` (AI Insight Service) |
| `integrations.json` | `integrations.health` | Health probes against ORCE itself, AI Insight, Trino, NiFi, Kafka |
| `schemas.json` | `schemas.list` / `schemas.describe` | Trino `information_schema.tables` / `.columns` |
| `admin.json` | `admin.users` / `admin.roles` / `admin.access` | Keycloak Admin API (token in `payload.authToken`, validated against `realm_access.roles ⊇ {admin}`) |
| `smart-city.json` | `smart-city.zones.list` / `.zones.detail` / `.streetlights.list` / `.traffic.summary` / `.events.recent` + 11 HTTP endpoints | `gold.streetlight_zone_hourly`, `gold.traffic_pattern_hourly`, `gold.event_impact_daily`, `gold.weather_hourly` |
| `data-products.json` | `data-products.list` / `.energy.list` / `.city.list` / `.detail` | `gold.information_schema.tables` (catalogue) + per-product `LIMIT 5` from the underlying gold table (sample) |
| `analytics.json` | `analytics.trends` / `.correlations` / `.anomalies` / `.recommendations` + 3 HTTP `/history` endpoints | `gold.net_grid_hourly`, `gold.pv_performance_hourly`, `gold.weather_hourly`, `gold.anomaly_candidates`, `gold.ai_insight_outputs` |
| `deploy.json` | HTTP `POST /backendtest/aiInsight` | Receives a built-Vue zip from CI; extracts to `/data/uibuilder/aiInsight/src`, applies asset-path rewrite. Auth: `Authorization: Bearer ${FACIS_DEPLOY_TOKEN}` |

## Message contract (FAP §9)

### Command (browser → ORCE)

```json
{
  "type": "command",
  "action": "alerts.list",
  "sessionId": "...",
  "step": "...",
  "requestId": "uuid",
  "payload": {},
  "meta": { "clientTs": 1735000000, "source": "dashboard" }
}
```

### Result (ORCE → browser, correlated by `requestId`)

```json
{
  "type": "result",
  "ok": true,
  "action": "alerts.list",
  "sessionId": "...",
  "requestId": "same-uuid",
  "next": { "step": "..." },
  "data": { "alerts": [...], "count": 12, "metadata": { "source": "global.alerts" } },
  "ui": null,
  "errors": null
}
```

### Event (ORCE → browser, broadcast / push)

```json
{
  "type": "event",
  "event": "alerts.new",
  "data": { "alert": { "id": "...", "severity": "warning", "..." : "..." } }
}
```

### Error levels (FAP §12)

| Level | Returned via | Frontend behaviour |
|---|---|---|
| Field | `errors.fields = { fieldName: 'reason' }` | inline highlight |
| Action | `errors.action = 'message'` | banner, stay on current step |
| Integration | `errors.integration = { service, message }` | retry / support path |
| System | `errors.system = 'safe-message'` | global error, recovery option |

## Frontend wiring (FAP §11)

```
main.ts:
  initAuth()
    .then(async () => {
       await useUiBuilderStore().init()           // boot UIBUILDER
       registerInboundHandler(reduceResult, reduceEvent)  // single inbound handler
       if (connected) submit('bootstrap.session', {})     // refresh-recovery
       app.mount('#app')
    })

services/transport.ts:
  submit(action, payload, opts?) → Promise<ResultResponse>
  registerInboundHandler(reduceResult, reduceEvent)

services/state.ts:
  useAppStore exposes state = { sessionId, step, model, ui, errors }
  (5-block model per FAP §8)

services/reducers.ts:
  reduceResult(msg) — only writer to state on results
  reduceEvent(msg)  — only writer to state on events
```

## Operational endpoints (HTTP, kept on purpose)

| Path | Purpose |
|---|---|
| `/api/v1/aiInsight/deploy` (POST) | Standard FAP zip-POST deploy mechanism — accepts a Vite-built bundle, extracts to `/data/uibuilder/aiInsight/src`, rewrites `/assets/` paths. |
| `/orce/api/v1/_internal/connections` (GET) | Operator endpoint reporting live UIBUILDER connection count + per-socket session metadata. |
| `/orce/api/v1/health` | ORCE liveness. |
| `/orce/api/v1/streetlights` / `/traffic` / `/events` / `/city-weather` (and per-id `/current` / `/history`) | Smart City HTTP shape consumed by the restored Vue views via `services/api.ts` simGet helpers. Backed by the same Trino queries as the FAP `smart-city.*` actions. |
| `/orce/api/v1/meters/:id/history` / `/pv/:id/history` / `/weather/:id/history` | Analytics history endpoints (Trino-backed). |
| `/orce/api/v1/insights/latest` / `/energy-summary` / `/anomaly-report` / `/city-status` | Served by the separate `services/ai-insight-service/orce/flows/` (out of this PR's scope). |

## Reference

- **FAP General Guideline**: `guidelines and examples/FAP_UI_General_Guideline_Reference_Aligned.md`
- **Architecture decision**: `docs/architecture-decisions/ADR-001-pure-uibuilder-fap-aligned.md`
- **Operator scripts**: `scripts/README.md` (deploy, smoke tests, drift checks, FAP-token CI gate)
