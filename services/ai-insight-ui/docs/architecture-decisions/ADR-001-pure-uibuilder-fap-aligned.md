# ADR-001: Pure UIBUILDER architecture, aligned to the FAP General Guideline

- **Status:** Accepted
- **Date:** 2026-05-04
- **Drivers:** Hossein's PR review of `feature/orce-native-simulation-runtime` (sections A.1, A.3, B.1, C.1, C.2, C.3); FAP General Guideline standard.
- **Reference:** `guidelines and examples/FAP_UI_General_Guideline_Reference_Aligned.md`

## Context

The reviewer flagged that the AI Insight UI deliverable presented a **design
contradiction**: the 6 Phase-5 features (alerts, data-sources, provenance,
integrations, schemas, admin) were implemented as plain HTTP REST endpoints
(`http in` → `function` → `http response` chains), while the surrounding
flows still wired up UIBUILDER router/topic infrastructure
(`route-outbound`, `link-to-insight-proxy`, `link-to-trino-query`,
`link-to-llm-router`, `link-from-response`, `merge-session-send`) that the
SPA never exercised. UIBUILDER itself was non-functional at runtime —
`window.uibuilder` was `undefined` because the client lib was never loaded
into `index.html`, so the existing AI Assistant view silently fell back to
mock mode.

The reviewer offered three resolutions: pure UIBUILDER, pure REST with the
router infrastructure removed, or an explicitly justified hybrid. They also
gated approval on UIBUILDER becoming "properly initialised" with at least
event-driven data (alerts) pushed rather than polled.

## Decision

Adopt **pure UIBUILDER** as the integration model. Every inbound and outbound
application message between the SPA and ORCE flows over a single UIBUILDER
WebSocket channel, conforming to the request/response/event envelopes
defined in **FAP General Guideline §9**. The ORCE side is organised as a
**root dispatcher + responsibility-based subflows** per §10. The Vue side
uses **one inbound handler + one outbound command + structured reducers**
per §11. State follows the five-block model (`session / step / model / ui /
errors`) per §8.

HTTP routes for SPA application data are decommissioned. The only HTTP
surfaces that survive on the SPA's served origin are:

- The deploy endpoint (`POST /orce/backendtest/aiInsight`) for the standard
  FAP zip-bundle deploy mechanism (pattern from `guidelines and examples/flows.json`).
- Operator-facing internals at `/orce/api/v1/_internal/*` (e.g. the live
  connection-count endpoint introduced in Phase 4).
- Service health probes for the data-plane services (DSP, SFTP,
  ai-insight-service) — independent of the SPA.

## Drivers

1. **Resolves the design contradiction at the root** (reviewer concern A.3,
   C.3). With one channel, the router is the only inbound channel — no
   longer cosmetic.
2. **Aligns with the FAP General Guideline** end-to-end. §22 ("closing
   guidance") describes exactly this combination: custom Vue frontend + one
   UIBUILDER bridge + ORCE backend orchestration + one stable message
   contract + centralised tokens.
3. **Push-native for alerts** (reviewer C.1). Alerts emitted by the
   `fn_alerts_writer` ring buffer are broadcast on UIBUILDER topic
   `alerts.new` to all connected clients, eliminating polling.
4. **Single mental model**. Engineers and reviewers do not have to know "is
   this feature REST or UIBUILDER?" — the answer is always UIBUILDER.

## Trade-offs

- **WebSocket-only.** No plain HTTP fallback for the SPA. If UIBUILDER's
  WebSocket fails to upgrade, the SPA cannot make application requests.
  Mitigated by: (a) the UIBUILDER store's defensive mock-mode fallback,
  (b) the deploy mechanism is independent (HTTP), so updates can still ship
  even if WebSockets are blocked; (c) Hossein's standard FAP environment
  has WebSockets allowed.
- **Auth in payload, not headers.** Admin actions need a Keycloak Bearer
  token. Over UIBUILDER, the token travels as `payload.authToken` rather
  than an `Authorization` header. Server-side validation (Keycloak userinfo
  call) is identical; only the input source changes.
- **Debugging via UIBUILDER inspector**, not browser DevTools Network tab.
  Engineers used to watching `/api/v1/*` requests in DevTools have to learn
  to watch the UIBUILDER socket in the inspector instead. Documented in
  `flow-architecture.md`.
- **Larger initial WebSocket payload** for the bootstrap action than the
  equivalent HTTP fetches (because all initial view-model data flows through
  one connection). Acceptable given typical bootstrap is a few KB and the
  WebSocket is reused for all subsequent traffic.

## Consequences

- The `services/ai-insight-ui/ui/app/src/services/api.ts` file is replaced
  by `transport.ts` + `contract.ts` over Phase 3. The legacy `simGet`,
  `aiGet`, `aiPost`, `authedGet` helpers are deleted.
- The 6 Phase-5 ORCE flow files (`alerts.json`, etc.) lose their
  `http in`/`http response` nodes and gain `link in`/`link out` plus
  switch-by-action.
- The dispatcher `0-Dispatcher.json` becomes the sole inbound channel for
  application data; the existing `0-UI.json` is replaced by it.
- Operator-facing endpoints (deploy, `_internal/connections`) remain HTTP.
- Documentation (`flow-architecture.md`) is rewritten to describe the
  dispatcher topology and action catalogue.

## Verification

End-to-end verification is run after each PR lands and comprehensively after
PR-7, including the FAP General Guideline §19 final checklist.
