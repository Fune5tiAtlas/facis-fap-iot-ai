# AI Insight UI — ORCE-native Operations Runbook

**Service:** FACIS AI Insight UI (Vue 3 SPA)
**Audience:** Platform / DevOps
**Deployment model:** Vue SPA served by `node-red-contrib-uibuilder` inside the
existing ORCE pod. **No standalone Deployment, Service, or Nginx sidecar.**
**Production URL:** `https://fap-iotai.facis.cloud/aiInsight/`
**Status:** live on the IONOS cluster as of 2026-04-29

> This runbook replaces the older `ops-runbook.md` for the IONOS / ORCE-native
> deployment. The standalone-Nginx flow described there is retained only for
> local development.

---

## 1. Architecture at a glance

```
Browser
  │
  └─▶ Ingress (nginx) on fap-iotai.facis.cloud
        ├─ /aiInsight                     → ORCE :1880  (uibuilder serves the SPA)
        ├─ /api/v1/*                      → ORCE :1880  (sim REST + AI Insight + Phase-5 backends)
        ├─ /orce, /api/ai, /openapi.json,
        │  /docs, /redoc, /dsp            → ORCE :1880
        ├─ /dynamicsrc                    → ORCE :1880  (editor-theme fonts/icons)
        └─ /orce/dynamicsrc/(.*)          → ORCE :1880  (path-rewrite to /dynamicsrc/$1)

ORCE pod (orce/orce):
  flows:
    - AI Insight UI (uibuilder, url=aiInsight)
    - 3× AI Insight backend tabs (energy/anomaly/city + helpers)
    - Phase-5 backends: alerts, data-sources, provenance, integrations,
      schemas, admin (Keycloak proxy)
    - Simulation REST (meters / pv / weather / loads / prices / status)
    - DSP (catalogue / negotiations / transfers / state / health)
    - Sim Engine + Tick + Feeds + Modbus + Kafka + MQTT + Observability

  init containers (in order):
    - init-data    — first-boot seed of /data PVC from /data/. (no-op after first run)
    - init-deps    — npm-installs node-red-contrib-{modbus,rdkafka,...} into /data
                     and applies SSL patch to rdkafka.js (idempotent)
    - init-ai-ui   — extracts ConfigMap/ai-insight-ui-bundle (gzip tarball)
                     onto /data/uibuilder/aiInsight/src/ (sha256 marker for
                     idempotence; only re-extracts when bundle changes)

  external dependencies:
    - Keycloak  (identity.facis.cloud)             — auth + admin API
    - Trino     (212.132.83.150:8443, Stackable)   — gold-layer reads
    - OpenAI    (api.openai.com)                   — LLM completions
    - Kafka     (Stackable, mTLS, multiple NodePorts)
```

---

## 2. Prerequisites

- `kubectl` access to the IONOS cluster (`k8s/K8s-cluster-IONOS-cloud.yaml`)
- The ORCE namespace (`orce`) is the deployment target
- Two Kubernetes Secrets, already in `orce` ns (do not delete):
  - `facis-ai-insight-secrets` — LLM key, Trino OIDC creds, Keycloak admin
    creds, OpenAI key, etc.
  - `facis-dsp-secrets` — DSP HMAC, sim env vars
  - `facis-kafka-certs` — Stackable mTLS cert bundle
- Inbound DNS: `fap-iotai.facis.cloud` → `185.48.118.251`
- Wildcard TLS secret `facis-wild` in `orce` ns

---

## 3. Deploying the SPA bundle

The Vue SPA is shipped as a single gzipped tarball in a `ConfigMap`'s
`binaryData`. The `init-ai-ui` initContainer extracts it onto the persistent
volume each time the bundle's sha256 changes; idempotent otherwise.

### 3.1 Build the SPA

```bash
cd services/ai-insight-ui/ui/app
npm ci && npm run build
# Output: dist/ ~700 KB total, with /aiInsight/ baked into asset URLs.
```

`vite.config.ts` sets `base: process.env.BASE_PATH || '/aiInsight/'`.
Override at build time only if mounting under a different sub-path.

### 3.2 Pack and upload the ConfigMap

```bash
# Pack with deterministic owner/group so re-creating from unchanged source
# yields the same sha256 (no spurious init container re-extracts).
tar --owner=0 --group=0 -czf /tmp/aiInsight-bundle.tar.gz \
  -C services/ai-insight-ui/ui/app/dist .
SHA=$(shasum -a 256 /tmp/aiInsight-bundle.tar.gz | cut -d' ' -f1)

# `kubectl apply` rejects binary ConfigMaps because it tries to stuff the whole
# object into a `last-applied-configuration` annotation (256KiB cap). Use
# delete-then-create.
kubectl delete configmap ai-insight-ui-bundle -n orce --ignore-not-found
kubectl create configmap ai-insight-ui-bundle -n orce \
  --from-file=bundle.tar.gz=/tmp/aiInsight-bundle.tar.gz
kubectl annotate configmap ai-insight-ui-bundle -n orce \
  facis.cloud/bundle-sha256="$SHA" --overwrite
```

ConfigMap binaryData has a 1 MiB hard cap; the current bundle is ~707 KB
gzipped (~2.8 MB uncompressed). Watch the cap if you add big assets.

### 3.3 Apply the init container patch (one-time per cluster)

```bash
kubectl patch deployment orce -n orce \
  --type=strategic --patch-file=infrastructure/orce/init-ai-ui-patch.yaml
```

This is a strategic-merge patch that adds:
- A `volumes:` entry `ai-ui-bundle` mounting the ConfigMap
- An `initContainers:` entry `init-ai-ui` that extracts on every boot only
  when the sha differs from `/data/uibuilder/aiInsight/src/.bundle.sha256`

### 3.4 Roll the pod

```bash
kubectl rollout restart deployment/orce -n orce
kubectl rollout status deployment/orce -n orce --timeout=180s
kubectl logs -n orce deploy/orce -c init-ai-ui
# Expect: "[init-ai-ui] bundle already up to date" OR
#         "[init-ai-ui] extracting bundle (old=… new=…)" then "done"
```

---

## 4. Deploying ORCE flows (Admin API)

The flow JSON lives in `services/ai-insight-ui/orce/flows/` (UI-backend
flows) and `services/ai-insight-ui/flows/tabs/` (UI proxy + LLM router +
session). Deploy via the Node-RED Admin API rather than `flows.json`
swap, so other tabs (DSP, simulation, AI Insight) aren't disturbed.

```bash
TOKEN=$(cat /tmp/facis-rollback/orce-admin-token.txt)
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://fap-iotai.facis.cloud/orce/flows > /tmp/curr-flows.json

python3 <<'PY'
import json, glob
existing = json.load(open('/tmp/curr-flows.json'))
ours = {'tab_aiui_alerts','tab_aiui_data_sources','tab_aiui_provenance',
        'tab_aiui_integrations','tab_aiui_schemas','tab_aiui_admin'}
filtered = [n for n in existing if n.get('z') not in ours and n.get('id') not in ours]
new = []
for f in sorted(glob.glob('services/ai-insight-ui/orce/flows/*.json')):
    new.extend(json.load(open(f)))
json.dump(filtered + new, open('/tmp/orce-flows-new.json','w'))
PY

curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Node-RED-Deployment-Type: full" \
  --data @/tmp/orce-flows-new.json \
  https://fap-iotai.facis.cloud/orce/flows
# Expect HTTP 204
```

---

## 5. Keycloak client setup

The `facis-ai-insight` client must list the production redirect URI plus
web origin. Run idempotently on each cluster:

```bash
KEYCLOAK_ADMIN_USER=admin \
KEYCLOAK_ADMIN_PASSWORD='<master-realm-admin>' \
  bash infrastructure/keycloak/configure-ai-insight-client.sh
# Adds https://fap-iotai.facis.cloud/aiInsight/* to redirectUris and
# https://fap-iotai.facis.cloud to webOrigins. No-op on second run.
```

Optional but recommended: **assign the `admin` realm role to the user
that should access /admin/users etc.** The Phase-5 `tab_aiui_admin` flow
verifies the caller's JWT via Keycloak `/userinfo` and requires
`realm_access.roles ⊇ ['admin']`.

---

## 6. Critical environment variables

Stored in `Secret/facis-ai-insight-secrets` (mounted via `envFrom`):

| Key                                     | Purpose                                         |
|-----------------------------------------|-------------------------------------------------|
| `AI_INSIGHT_LLM__API_KEY`               | OpenAI API key (use a project-scoped key)       |
| `AI_INSIGHT_LLM__MODEL`                 | `meta-llama/Llama-3.3-70B-Instruct` (or alternate)                   |
| `AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL`  | `https://api.openai.com/v1/chat/completions`    |
| `AI_INSIGHT_TRINO__HOST`                | `212.132.83.150`                                |
| `AI_INSIGHT_TRINO__USER`                | **MUST equal the OIDC username** (else `Access Denied: cannot impersonate`). For us = `test`. |
| `AI_INSIGHT_TRINO__OIDC_USERNAME`       | `test`                                          |
| `AI_INSIGHT_TRINO__OIDC_VERIFY`         | `false` (Alpine image lacks Stackable CA chain) |
| `AI_INSIGHT_TRINO__CATALOG`             | `fap-iotai-stackable`                           |
| `AI_INSIGHT_TRINO__TARGET_SCHEMA`       | `gold`                                          |
| `KEYCLOAK_ADMIN_USER` / `_PASSWORD` / `_URL` / `_REALM` | for `tab_aiui_admin` flow's Keycloak proxy. Must be a master-realm admin. |

Stored in `Secret/facis-dsp-secrets`:
- `DSP_HMAC_SECRET`
- `SPEED_FACTOR` (sim acceleration; `60` runs 1 real-min = 1 sim-hour)
- (other sim env vars)

To rotate the OpenAI key:

```bash
NEW=$(printf '<new-key>' | base64)
kubectl patch secret facis-ai-insight-secrets -n orce --type=merge \
  -p "{\"data\":{\"AI_INSIGHT_LLM__API_KEY\":\"$NEW\"}}"
kubectl rollout restart deployment/orce -n orce
```

---

## 7. Smoke tests

```bash
# SPA
curl -sS -o /dev/null -w "GET /aiInsight/                       %{http_code}\n" \
  https://fap-iotai.facis.cloud/aiInsight/

# Phase-5 backends (no auth except admin)
for p in alerts data-sources provenance/transfers integrations/health \
         insights/latest schemas; do
  RC=$(curl -sS -o /dev/null -w '%{http_code}' \
    "https://fap-iotai.facis.cloud/api/v1/$p")
  printf "  GET /api/v1/%-30s %s\n" "$p" "$RC"
done

# Admin proxy without auth → 401
curl -sS -o /dev/null -w 'GET /api/v1/admin/users (no auth)        %{http_code}\n' \
  https://fap-iotai.facis.cloud/api/v1/admin/users

# AI Insight POST (today's window, includes seeded gold-layer rows)
T=$(date -u +%Y-%m-%d)
curl -sS -X POST -H 'Content-Type: application/json' \
  -H 'x-agreement-id: facis-ui' -H 'x-asset-id: facis-platform' \
  -H 'x-user-roles: ai_insight_consumer' \
  -d "{\"start_ts\":\"${T}T00:00:00Z\",\"end_ts\":\"${T}T23:59:59Z\",\"timezone\":\"UTC\"}" \
  https://fap-iotai.facis.cloud/api/v1/insights/energy-summary | jq '.summary'
```

---

## 8. Decommission notes

These have been replaced by the ORCE-native deployment and should NOT be
deployed:

- `Deployment/ai-insight-service` (Python FastAPI backend) — 0/1 replicas;
  delete with `kubectl delete deploy/ai-insight-service svc/ai-insight-service`
  in the appropriate namespace once the migration is signed off.
- `services/ai-insight-ui/Dockerfile` (standalone Nginx variant) — local
  dev only. Header comment marks the intent.

---

## 9. Common operations

### Update the SPA bundle only (no flow changes)

```bash
cd services/ai-insight-ui/ui/app && npm run build && cd ../../../..
tar --owner=0 --group=0 -czf /tmp/aiInsight-bundle.tar.gz \
  -C services/ai-insight-ui/ui/app/dist .
kubectl delete cm ai-insight-ui-bundle -n orce
kubectl create cm ai-insight-ui-bundle -n orce \
  --from-file=bundle.tar.gz=/tmp/aiInsight-bundle.tar.gz
SHA=$(shasum -a 256 /tmp/aiInsight-bundle.tar.gz | cut -d' ' -f1)
kubectl annotate cm ai-insight-ui-bundle -n orce \
  facis.cloud/bundle-sha256="$SHA" --overwrite
kubectl rollout restart deployment/orce -n orce
```

### Update an ORCE flow (one tab) without disturbing others

POST to `/orce/flows` with full set as in §4 — Node-RED has no per-tab
PATCH; you must always replace the whole array.

### See what's running

```bash
kubectl get pod -n orce -l app=orce
kubectl exec -n orce deploy/orce -c orce -- sh -c \
  'ls /data/uibuilder/aiInsight/src/ ; cat /data/uibuilder/aiInsight/src/.bundle.sha256'
kubectl get cm ai-insight-ui-bundle -n orce \
  -o jsonpath='{.metadata.annotations.facis\.cloud/bundle-sha256}'
# These two SHAs should match.
```

### Roll back a bad bundle deploy

```bash
# /tmp/facis-rollback/ has timestamped backups of every flows POST + bundle
ls /tmp/facis-rollback/
# Pick a bundle; redo §3.2 with the old tarball.
```

---

## 10. Known limitations

- **No `/history` endpoints in the simulation REST flow** — the Smart
  Energy "Overview/AssetDetail/Context" views show only current-state
  KPIs; the sub-tab strip omits "AI Insights" entirely (deleted because
  it depended on history). The Analytics section's Trends / Correlations
  / Anomalies / Recommendations sub-tabs were also deleted for the same
  reason.
- **No smart-city feeds** — the simulation doesn't emit streetlights,
  traffic, events, or city-weather. Smart City was removed from the
  sidebar entirely; AI city-status content is reachable via the AI
  Assistant chat and Analytics → Overview.
- **Trino TLS is not verified** by the AI Insight backend (Stackable's
  CA isn't bundled in the ORCE image). `AI_INSIGHT_TRINO__OIDC_VERIFY=false`
  is the documented opt-out.
- **NiFi Lakehouse Ingestion is paused** awaiting the Trino JDBC driver
  on the Stackable cluster.

---

## 11. Editor theme assets — the `httpStatic` + `httpAdminMiddleware` patch

Background: the customised Node-RED editor at `/orce/#` ships an unmodifiable
`red.min.js` (read-only at `/opt/maestro/MBE/packages/node_modules/@node-red/
editor-client/public/red/red.min.js`) plus theme assets (`guided-script.js`,
`guided-style.css`) that reference editor fonts and node icons under
`dynamicsrc/...`. Two URL shapes arrive at the cluster:

  - **Relative** — `red.min.js` constructs URLs as
    `${window.location.origin + window.location.pathname}dynamicsrc/...`,
    which under the editor URL `/orce/` resolves to `/orce/dynamicsrc/*`.
  - **Absolute** — `guided-style.css` uses `url("/dynamicsrc/font/...")`,
    which always lands at root `/dynamicsrc/*`.

Both are now handled inside Node-RED itself, with no ingress-layer rewrite:

  - `/data/settings.js` is patched at pod boot (by the
    `init-orce-settings` initContainer in
    `infrastructure/orce/init-orce-settings-patch.yaml`) to:
      * **Expand** the existing `httpStatic: '/data'` into an array
        also serving `/opt/maestro/MBE/.node-red/dynamicsrc` at URL
        `/dynamicsrc/*` — this catches the absolute references.
      * **Add** an `httpAdminMiddleware` that serves the same filesystem
        path when a request hits the admin tree at `/orce/dynamicsrc/*`
        (which arrives as `req.path === '/dynamicsrc/...'` because
        `httpAdminRoot` is `/orce/`) — this catches the relative
        references.
  - The patch is idempotent (detects an existing `FACIS:dynamicsrc-patch`
    marker comment in `settings.js`) and atomic (writes
    `settings.js.new` and renames over the original).

Reviewer Hossein flagged the prior Ingress workaround
(`facis-ingress-dynamicsrc-rewrite.yaml`) in the PR review (§B.2 / C.4)
as a path-prefix rewrite that "should not be necessary if the integration
is done correctly". Phase 1 of the cleanup landed the settings.js patch
alongside the Ingress; Phase 2 (commit `<TBD>`) deleted the Ingress YAML
and the cluster Ingress object. Verified end-to-end: the editor renders
with all custom fonts and node icons via Node-RED's static-serving hooks
alone.

**Verification snippet** (from a fresh cluster session, post-removal):

```bash
curl -sS -o /dev/null -w "via /orce/dynamicsrc/: HTTP %{http_code}\n" \
  https://fap-iotai.facis.cloud/orce/dynamicsrc/font/Manrope-Bold.woff
curl -sS -o /dev/null -w "via /dynamicsrc/:      HTTP %{http_code}\n" \
  https://fap-iotai.facis.cloud/dynamicsrc/font/Manrope-Bold.woff
# expect: HTTP 200 on both
kubectl get ingress -n orce | grep dynamicsrc
# expect: empty
```

**Not used by the SPA.** Confirmed during the Phase 2 verification:
`services/ai-insight-ui/ui/app/index.html` contains no `dynamicsrc`
reference; `vite.config.ts` uses `base='/orce/aiInsight/'` and only emits
absolute Vite-resolved paths into the bundle. The SPA at
`/orce/aiInsight/` is unaffected by either the patch or the Ingress
removal.

---

## 12. Reference: file locations

| Path | Purpose |
|---|---|
| `infrastructure/orce/init-ai-ui-patch.yaml`              | Strategic-merge patch adding init-ai-ui container |
| `infrastructure/orce/init-deps-patch.yaml`               | npm install + rdkafka SSL patch initContainer |
| `infrastructure/orce/init-orce-settings-patch.yaml`      | Patches `/data/settings.js` with `httpStatic` + `httpAdminMiddleware` for `/dynamicsrc/*` (replaces the prior path-rewrite Ingress) |
| `infrastructure/ingress/facis-ingress.yaml`              | Main Ingress |
| `infrastructure/keycloak/configure-ai-insight-client.sh` | Idempotent Keycloak client setup |
| `services/ai-insight-ui/ui/app/`                         | Vue 3 SPA source |
| `services/ai-insight-ui/orce/flows/`                     | 6 Phase-5 backend flow JSONs |
| `services/ai-insight-ui/flows/tabs/`                     | UI proxy + LLM router + session-context flows |
| `services/ai-insight-ui/helm/facis-ai-insight-ui/`       | Helm chart (rendered ConfigMaps; superseded by manual ConfigMap creation in this runbook) |
