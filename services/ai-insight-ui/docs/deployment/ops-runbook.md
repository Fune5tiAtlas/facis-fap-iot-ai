# Operations Runbook

> **⚠ Superseded for production by [`orce-native-runbook.md`](./orce-native-runbook.md) (2026-04-29).**
>
> The IONOS production deployment is now ORCE-native: the Vue SPA runs
> inside the existing ORCE pod via `node-red-contrib-uibuilder`. There is
> no standalone Deployment / Service / Nginx sidecar in production. The
> `kubectl cp` workflow described in §3 below has been replaced by an
> init-container that extracts a ConfigMap-bundled gzipped tarball.
>
> Keep this runbook for: local development, the standalone-Nginx variant
> of the Helm chart, and historical reference of the original deployment
> design.

**Service:** FACIS FAP IoT & AI — AI Insight UI
**Audience:** DevOps and platform team
**Version:** 0.1.0
**Date:** 05 April 2026

---

## 1. Service Overview

The AI Insight UI is a Vue.js single-page application (SPA) that provides an AI-powered dashboard for interactive exploration of FACIS Smart City and Energy data. It does NOT create its own Kubernetes Deployment; instead, it deploys as ConfigMaps and Secrets that patch into the existing ORCE (Node-RED orchestration engine) pod. The UI communicates with ORCE via UIBUILDER message protocol to route requests to three backend services:

1. **AI Insight Service** (FastAPI, port 8080) — Structured analytics with LLM-powered insights
2. **Trino** (port 8080 or 8443) — Gold Layer SQL queries for dashboard context
3. **LLM providers** (OpenAI, Anthropic, or custom) — Freeform natural language responses

### Architecture

```
Browser (Vue 3 SPA)
    ↓ uibuilder.send()
ORCE / Node-RED (existing deployment)
    ├─ Tab 0: UI routing (UIBUILDER node)
    ├─ Tab 1: AI Insight Service proxy
    ├─ Tab 2: LLM Router (OpenAI / Claude / Custom)
    ├─ Tab 3: Trino Gold Layer queries
    └─ Tab 4: Session context management
```

### Ports and Access

| Component | Port | Protocol | Purpose | Location |
|-----------|------|----------|---------|----------|
| ORCE (Node-RED UI) | 1880 | HTTP | Flow editor, admin API | Pod 1880 |
| AI Insight UI | 80 (via Nginx) | HTTP | Vue SPA static files | Pod sidecar or separate service |
| AI Insight Service | 8080 | HTTP | Backend analytics API | Cluster internal |
| Trino | 8080/8443 | HTTP/HTTPS | SQL query engine | External cluster |
| OpenAI API | 443 | HTTPS | LLM provider | External |
| Anthropic API | 443 | HTTPS | LLM provider | External |

### Generated Helm Charts and ConfigMaps

This service uses a ConfigMap-only Helm chart. No Pod/Deployment/Service is created — only configuration injected into ORCE:

| Resource | Name | Purpose |
|----------|------|---------|
| ConfigMap | `ai-insight-ui-flows` | Node-RED flow definitions (40 nodes, 5 tabs) |
| ConfigMap | `ai-insight-ui-files` | Built Vue SPA assets (index.html, JS, CSS) |
| Secret | `orce-llm-secrets` | OpenAI and Anthropic API keys |

---

## 2. Kubernetes Deployment with Helm

### 2.1 Prerequisites

- Kubernetes 1.25+
- Helm 3.x installed
- Existing ORCE deployment running in the target namespace
- Node.js 20+ and npm (for building the Vue SPA)
- LLM API keys (OpenAI, Anthropic, or custom provider)
- AI Insight Service deployed and accessible at `http://ai-insight-service:8080`

### 2.2 Build the Vue SPA

The build script transpiles the Vue 3 app and packages assets for the Helm chart:

```bash
cd ai-insight-ui
./scripts/build-and-package.sh
```

Options:
- `--skip-install` — Skip npm ci, use existing node_modules (faster for CI/CD)

Output:
- Built SPA: `ui/app/dist/`
- Helm chart files: `helm/facis-ai-insight-ui/files/ui/`

### 2.3 Create LLM Secrets

Create a Secret containing API keys before deploying:

```bash
# Create the Secret with your API keys
kubectl create secret generic orce-llm-secrets \
  --from-literal=openai-api-key=sk-<YOUR_KEY> \
  --from-literal=anthropic-api-key=sk-ant-<YOUR_KEY> \
  -n facis

# Or update an existing Secret
kubectl edit secret orce-llm-secrets -n facis
```

### 2.4 Install or Upgrade the Helm Chart

```bash
cd ai-insight-ui

# Install with defaults (local development)
helm install facis-ai-insight helm/facis-ai-insight-ui -n facis --create-namespace

# Install with custom values
helm install facis-ai-insight helm/facis-ai-insight-ui -n facis \
  --set orce.serviceName=orce \
  --set llm.openaiModel=gpt-4.1-mini \
  --set llm.anthropicModel=claude-sonnet-4-20250514 \
  --set aiInsight.serviceUrl=http://ai-insight-service:8080 \
  --set keycloak.enabled=true \
  --set keycloak.realmUrl=https://keycloak.example.com/realms/facis

# Upgrade an existing release
helm upgrade facis-ai-insight helm/facis-ai-insight-ui -n facis

# Use a values file for cluster deployments
helm upgrade facis-ai-insight helm/facis-ai-insight-ui -n facis \
  -f helm/values-cluster.yaml
```

### 2.5 Patch ORCE Deployment with LLM Environment Variables

The Helm chart creates the ConfigMaps and Secret. You must manually add LLM environment variables to the ORCE deployment. The chart provides a patch template in NOTES.txt after installation:

```bash
# After helm install, view the patch instructions
helm get notes facis-ai-insight -n facis

# Apply environment variables to ORCE deployment
kubectl patch deployment orce -n facis --type=json -p='[
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "AI_INSIGHT_BASE_URL", "value": "http://ai-insight-service:8080"}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "FACIS_OPENAI_API_KEY", "valueFrom": {"secretKeyRef": {"name": "orce-llm-secrets", "key": "openai-api-key"}}}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "FACIS_OPENAI_MODEL", "value": "gpt-4.1-mini"}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "FACIS_ANTHROPIC_API_KEY", "valueFrom": {"secretKeyRef": {"name": "orce-llm-secrets", "key": "anthropic-api-key"}}}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "FACIS_ANTHROPIC_MODEL", "value": "claude-sonnet-4-20250514"}}
]'
```

Or edit the ORCE deployment YAML directly and add to the env section (recommended for clarity).

### 2.6 Import Flows into ORCE

The Helm chart creates a ConfigMap with the flow definitions. Import them into ORCE via the admin API:

```bash
# Extract the flows from the ConfigMap
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' > /tmp/flows.json

# Import via ORCE admin API
kubectl port-forward svc/orce 1880:1880 -n facis &
curl -X POST http://localhost:1880/flows \
  -H 'Content-Type: application/json' \
  -d @/tmp/flows.json

# Or import manually via the Node-RED UI: Menu → Import → flows.json
```

### 2.7 Copy UI Files to ORCE UIBUILDER Directory

The UIBUILDER node in ORCE serves static files from `/data/uibuilder/<appName>/src/`. Copy the built Vue SPA files:

```bash
# Get the ORCE pod name
ORCE_POD=$(kubectl get pod -n facis -l app=orce -o jsonpath='{.items[0].metadata.name}')

# Copy UI files from the built output
kubectl cp ui/app/dist/ $ORCE_POD:/data/uibuilder/aiInsight/src/ -n facis

# Verify the files are in place
kubectl exec -n facis $ORCE_POD -- ls -la /data/uibuilder/aiInsight/src/
```

### 2.8 Uninstall

```bash
helm uninstall facis-ai-insight -n facis
```

### 2.9 Verify Deployment

```bash
# Check ConfigMaps were created
kubectl get configmap -n facis | grep ai-insight

# Check Secret was created
kubectl get secret -n facis | grep orce-llm-secrets

# Check ORCE pod is running
kubectl get pods -n facis -l app=orce

# Port-forward to ORCE
kubectl port-forward -n facis svc/orce 1880:1880

# Access the UI
open http://localhost:1880/aiInsight/

# View ORCE logs for flow errors
kubectl logs -n facis -l app=orce -f | grep -i "error\|flow"
```

---

## 3. Local Development

### 3.1 Prerequisites

- Node.js 20+, npm
- ORCE (Node-RED) running with UIBUILDER node installed
- AI Insight Service accessible at `http://localhost:8080`
- LLM API keys set in environment variables

### 3.2 Install Dependencies

```bash
cd ui/app
npm ci
```

### 3.3 Start the Development Server

```bash
npm run dev
```

Output:
```
Local:        http://localhost:5173/
```

The development server uses Vite with hot module replacement (HMR).

### 3.4 Import Flows into Local ORCE

Copy flows into Node-RED via the admin API or editor:

```bash
# API method
curl -X POST http://localhost:1880/flows \
  -H 'Content-Type: application/json' \
  -d @flows/flows.full.json

# Manual method: Node-RED UI → Menu → Import → flows.full.json
```

### 3.5 Set Up UIBUILDER Node

In Node-RED, configure a UIBUILDER node:

1. Create a new flow (if needed)
2. Add UIBUILDER node to canvas
3. Set properties:
   - **URL**: `aiInsight`
   - **Instance Name**: `aiInsight`
4. Click "Create Instance" — this creates `/data/uibuilder/aiInsight/`
5. Build and copy source files: `npm --prefix ui/app run build && cp -r ui/app/dist/* /data/uibuilder/aiInsight/src/`
6. Deploy and access: `http://localhost:1880/aiInsight/`

### 3.6 Configure Environment Variables

Set these in your shell or `.env.local` file (if using dotenv plugin):

```bash
export AI_INSIGHT_BASE_URL=http://localhost:8080
export FACIS_OPENAI_API_KEY=sk-<your-key>
export FACIS_OPENAI_MODEL=gpt-4.1-mini
export FACIS_ANTHROPIC_API_KEY=sk-ant-<your-key>
export FACIS_ANTHROPIC_MODEL=claude-sonnet-4-20250514
export FACIS_KEYCLOAK_URL=https://keycloak.example.com/realms/facis/protocol/openid-connect/token
```

The ORCE flow tabs read these variables when processing requests.

---

## 4. Helm Values Reference

### 4.1 ORCE Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `orce.deploymentName` | string | `orce` | Existing ORCE Deployment name |
| `orce.serviceName` | string | `orce` | ORCE Service name |
| `orce.port` | int | `1880` | ORCE Node-RED admin API port |
| `orce.adminUrl` | string | `http://orce:1880` | ORCE cluster-internal URL |

### 4.2 Flows ConfigMap

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `flows.configMapName` | string | `ai-insight-ui-flows` | ConfigMap name for flow definitions |
| `flows.filePath` | string | `files/flows.full.json` | Path to flows.json in chart |
| `flows.inlineContent` | string | `""` | Inline flow JSON (overrides filePath) |

### 4.3 UI Files ConfigMap

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `uiFiles.configMapName` | string | `ai-insight-ui-files` | ConfigMap name for UIBUILDER assets |
| `uiFiles.dirPath` | string | `files/ui` | Built SPA directory in chart |
| `uiFiles.inline.indexHtml` | string | `""` | Inline index.html (overrides dirPath) |

### 4.4 LLM Secret

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `llmSecret.create` | bool | `true` | Create orce-llm-secrets Secret |
| `llmSecret.name` | string | `orce-llm-secrets` | Secret name |
| `llmSecret.openaiApiKey` | string | `""` | OpenAI API key (set via --set or -f) |
| `llmSecret.anthropicApiKey` | string | `""` | Anthropic API key |
| `llmSecret.customLlmKey` | string | `""` | Custom LLM API key (optional) |
| `llmSecret.annotations` | object | `{}` | Secret annotations |

### 4.5 LLM Models

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `llm.openaiModel` | string | `gpt-4.1-mini` | OpenAI model identifier |
| `llm.anthropicModel` | string | `claude-sonnet-4-20250514` | Anthropic model identifier |
| `llm.customLlmUrl` | string | `""` | Custom LLM endpoint (empty = disabled) |
| `llm.customLlmModel` | string | `custom` | Custom LLM model name |

### 4.6 Backend Services

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `aiInsight.serviceUrl` | string | `http://ai-insight-service:8080` | AI Insight backend URL |
| `trino.host` | string | `trino.stackable.svc.cluster.local` | Trino coordinator hostname |
| `trino.port` | int | `8080` | Trino HTTP port |
| `trino.catalog` | string | `iceberg` | Trino catalog |
| `trino.schema` | string | `facis` | Trino schema (database) |

### 4.7 Keycloak / OIDC

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `keycloak.enabled` | bool | `false` | Enable Keycloak OIDC integration |
| `keycloak.realmUrl` | string | `""` | Keycloak realm URL |
| `keycloak.clientId` | string | `facis-ai-insight` | OIDC client ID |
| `keycloak.clientSecret` | string | `""` | OIDC client secret |

### 4.8 Extra Labels and Annotations

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `extraLabels` | object | `{}` | Extra labels for all resources |
| `extraAnnotations` | object | `{}` | Extra annotations for all resources |

---

## 5. Build Pipeline

### 5.1 Build Script Overview

The `scripts/build-and-package.sh` script automates the full build pipeline:

```
Step 1: npm ci (install deps)
    ↓
Step 2: npm run build (Vite build, outputs to dist/)
    ↓
Step 3: Copy dist/ to helm/facis-ai-insight-ui/files/ui/
    ↓
Ready for: helm package / helm install / helm upgrade
```

### 5.2 Full Build Example

```bash
cd ai-insight-ui

# Build everything
./scripts/build-and-package.sh

# Build with cached node_modules (faster)
./scripts/build-and-package.sh --skip-install

# Expected output:
# [1/3] Installing npm dependencies...
# [2/3] Building Vue app (vite build)...
#       Build complete. Output size: 245K
# [3/3] Copying dist/* to Helm chart files directory...
#       Copied 47 files to helm/facis-ai-insight-ui/files/ui
#
# Next steps:
#   helm upgrade <release> helm/facis-ai-insight-ui -n <namespace>
```

### 5.3 CI/CD Integration

For automated pipelines, use `--skip-install` and pass assets via `--set-file`:

```bash
#!/bin/bash
set -e

# Build (cache npm dependencies)
cd ai-insight-ui/ui/app
npm ci --prefer-offline
npm run build

# Deploy (pass assets to Helm without bundling them into the chart)
helm upgrade facis-ai-insight ../../helm/facis-ai-insight-ui \
  -n facis \
  --set-file uiFiles.inline.indexHtml=dist/index.html \
  -f ../../helm/values.yaml
```

### 5.4 Build Flags and Options

| Flag | Purpose |
|------|---------|
| `--skip-install` | Skip `npm ci`, use existing node_modules |

### 5.5 Vite Configuration

The Vue app uses Vite for fast dev and optimized production builds. Key config (`ui/app/vite.config.js`):

- **Entry**: `index.html`
- **Output**: `dist/`
- **Environment**: Variables from `.env`, `.env.local` (Node-RED flow tabs read env vars)
- **Proxy** (dev only): `/api/ai` and `/api/sim` routes to backend services

---

## 6. Health and Monitoring

### 6.1 ORCE Admin API Health

ORCE provides a health endpoint that reports the state of deployed flows:

```bash
curl http://localhost:1880/auth/strategy
```

Response (HTTP 200 if ORCE is healthy):

```json
{
  "strategy": "username",
  "version": "3.1.x"
}
```

For a full diagnostics check, use the admin API:

```bash
# List all flows
curl http://localhost:1880/flows

# Check flow status (should contain all 5 tabs deployed)
curl http://localhost:1880/flows | python3 -m json.tool | grep -i "label\|type"
```

### 6.2 UI Health Check

The Nginx SPA serves a health endpoint:

```bash
# If UI is deployed on port 80 (standalone)
curl http://localhost:80/
# Expected: HTML content of index.html (200 OK)

# If accessed via ORCE (usual case)
curl http://localhost:1880/aiInsight/
# Expected: Same HTML + Vue.js loads
```

### 6.3 Backend Service Connectivity

Test connectivity to AI Insight Service and Trino:

```bash
# AI Insight Service (should be accessible from ORCE pod)
kubectl exec -n facis <orce-pod> -- \
  curl -s http://ai-insight-service:8080/health

# Trino (via kubectl proxy)
kubectl port-forward -n facis svc/trino 8080:8080 &
curl http://localhost:8080/ui/

# LLM provider connectivity (from ORCE pod)
kubectl exec -n facis <orce-pod> -- \
  curl -s -I https://api.openai.com/v1/models
```

### 6.4 Monitoring Checklist

| Check | Command | Expected |
|-------|---------|----------|
| ORCE alive | `curl /auth/strategy` | `{"strategy": "username"}` |
| Flows deployed | `curl /flows \| jq length` | `>= 40` (at least 40 nodes) |
| UI loads | Open `http://orce:1880/aiInsight/` | Vue SPA renders, no console errors |
| AI Insight reachable | `curl http://ai-insight-service:8080/health` | `200 OK` |
| Trino reachable | `curl http://trino:8080/ui/` | `200 OK` |
| LLM keys configured | `kubectl get secret orce-llm-secrets -o jsonpath=...` | Both keys present |
| Session context flows | ORCE logs | No "Error" or "undefined" messages |

---

## 7. Troubleshooting

### 7.1 UI Returns 404

**Symptom:** Opening `http://orce:1880/aiInsight/` returns 404 or blank page.

**Diagnosis:**

```bash
# Check if UIBUILDER node is deployed
kubectl exec -n facis <orce-pod> -- ls -la /data/uibuilder/

# Check if aiInsight directory exists
kubectl exec -n facis <orce-pod> -- ls -la /data/uibuilder/aiInsight/src/

# Check ORCE logs for UIBUILDER errors
kubectl logs -n facis <orce-pod> | grep -i "uibuilder\|404"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| UI files not copied to ORCE | `kubectl cp ui/app/dist/* $ORCE_POD:/data/uibuilder/aiInsight/src/ -n facis` |
| UIBUILDER node not deployed in flows | Re-import flows.json, ensure Tab 0 has UIBUILDER node |
| UIBUILDER cache stale | Delete ORCE pod to force restart: `kubectl delete pod <orce-pod> -n facis` |

### 7.2 Flows Not Loading in ORCE

**Symptom:** Imported flows don't appear in Node-RED editor, or API returns empty flows array.

**Diagnosis:**

```bash
# Check ConfigMap exists
kubectl get configmap ai-insight-ui-flows -n facis

# Extract flows and validate JSON
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | \
  python3 -m json.tool | head -20

# Check ORCE admin API
kubectl port-forward svc/orce 1880:1880 -n facis &
curl http://localhost:1880/flows | python3 -m json.tool | jq length
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| flows.json malformed | Validate JSON: `jq < flows/flows.full.json` |
| ConfigMap not created | `kubectl create configmap ai-insight-ui-flows --from-file=flows.json=flows/flows.full.json -n facis` |
| Flows imported but not deployed | Click "Deploy" in Node-RED editor (usually automatic) |
| ORCE restart cleared flows | Flows must be persisted via ConfigMap or PVC; check ORCE deployment mount points |

### 7.3 UI Cannot Reach AI Insight Service

**Symptom:** "Error: Cannot connect to AI Insight" message in UI, or freeform LLM responses fail.

**Diagnosis:**

```bash
# From ORCE pod, test AI Insight connectivity
kubectl exec -n facis <orce-pod> -- \
  curl -v http://ai-insight-service:8080/health

# Check DNS resolution
kubectl exec -n facis <orce-pod> -- nslookup ai-insight-service

# Check Service endpoints
kubectl get endpoints ai-insight-service -n facis

# Check ORCE logs
kubectl logs -n facis <orce-pod> -f | grep -i "ai-insight\|proxy"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Wrong service URL | Verify `AI_INSIGHT_BASE_URL` env var in ORCE pod: `kubectl exec ... env \| grep AI_INSIGHT` |
| AI Insight Service not running | `kubectl get svc ai-insight-service -n facis` — if missing, deploy the AI Insight service |
| Network policy blocking traffic | Allow egress from ORCE to AI Insight; check NetworkPolicy resources |
| Service DNS not resolving | `kubectl exec <orce-pod> -- nslookup ai-insight-service.facis.svc.cluster.local` |

### 7.4 LLM API Key Configuration Errors

**Symptom:** Freeform LLM queries fail with "Unauthorized" or "Invalid API key".

**Diagnosis:**

```bash
# Check if Secret exists
kubectl get secret orce-llm-secrets -n facis

# Check if keys are populated
kubectl get secret orce-llm-secrets -n facis -o jsonpath='{.data.openai-api-key}' | base64 -d

# Check if ORCE pod has env vars mounted
kubectl exec -n facis <orce-pod> -- env | grep -i "openai\|anthropic"

# Check Node-RED logs for LLM errors
kubectl logs -n facis <orce-pod> -f | grep -i "llm\|openai\|anthropic\|401\|403"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Secret not created | `kubectl create secret generic orce-llm-secrets --from-literal=openai-api-key=sk-... -n facis` |
| Env vars not mounted in ORCE | Patch ORCE deployment to include `FACIS_OPENAI_API_KEY` and `FACIS_ANTHROPIC_API_KEY` env vars from Secret |
| Wrong API key | Verify keys are valid: test with curl: `curl -H "Authorization: Bearer $KEY" https://api.openai.com/v1/models` |
| API key format incorrect | OpenAI format: `sk-...`, Anthropic format: `sk-ant-...` |

### 7.5 Keycloak Redirect Issues

**Symptom:** Trino queries fail with "401 Unauthorized" or Keycloak redirects to login page.

**Diagnosis:**

```bash
# Check if Keycloak is enabled
kubectl get secret orce-llm-secrets -n facis -o jsonpath='{.data}' | grep -i keycloak

# Test Keycloak token endpoint
curl -X POST https://keycloak.example.com/realms/facis/protocol/openid-connect/token \
  -d client_id=facis-ai-insight \
  -d client_secret=... \
  -d grant_type=client_credentials

# Check Trino auth headers in flow
kubectl logs -n facis <orce-pod> -f | grep -i "keycloak\|token\|trino"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Keycloak not enabled | Set `keycloak.enabled: true` and provide realm URL in values |
| Wrong Keycloak realm URL | Verify URL matches your Keycloak setup; test with curl above |
| Client ID / secret mismatch | Verify `keycloak.clientId` and `keycloak.clientSecret` match Keycloak registrations |
| Token expiry | Tokens expire in ~5 min; add token refresh logic to Tab 3 (Trino Query) flow tab |

### 7.6 UIBUILDER Not Serving Files

**Symptom:** UIBUILDER serves 404 for CSS, JS, or asset files; only HTML loads.

**Diagnosis:**

```bash
# Check UIBUILDER directory structure
kubectl exec -n facis <orce-pod> -- find /data/uibuilder/aiInsight/ -type f

# Expected structure:
# /data/uibuilder/aiInsight/src/index.html
# /data/uibuilder/aiInsight/src/index.js
# /data/uibuilder/aiInsight/src/index.css
# /data/uibuilder/aiInsight/src/assets/...

# Check if files have correct permissions
kubectl exec -n facis <orce-pod> -- ls -la /data/uibuilder/aiInsight/src/
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Assets not built | Run `npm run build` and copy dist/* to ORCE: `kubectl cp ui/app/dist/* $POD:/data/uibuilder/aiInsight/src/ -n facis` |
| Build output structure wrong | Ensure `dist/` contains `index.html` (root) and `assets/` subdirectory |
| Permissions denied | ORCE user (uid 999 or 1000) must read files: `kubectl exec <orce-pod> -- chmod -R 755 /data/uibuilder/` |

### 7.7 Trino Query Timeouts

**Symptom:** KPI card queries timeout or return "No such table" errors.

**Diagnosis:**

```bash
# Test Trino connectivity
kubectl port-forward -n facis svc/trino 8080:8080 &
curl -X GET http://localhost:8080/ui/api/query \
  -H "Authorization: Basic <base64 user:pass>"

# Check if Gold Layer tables exist
curl -X POST http://trino:8080/v1/statement \
  -H "Authorization: Basic admin:password" \
  -d "SELECT table_name FROM information_schema.tables WHERE table_schema='facis'"

# Check ORCE logs for Trino errors
kubectl logs -n facis <orce-pod> -f | grep -i "trino\|query\|timeout"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Trino not reachable | Verify `trino.host` and `trino.port` in values; test DNS: `kubectl exec <orce-pod> -- nslookup trino` |
| Tables not created | Run lakehouse setup: `python infrastructure/lakehouse/setup_lakehouse.py --env-file .env.cluster` |
| Wrong catalog/schema | Verify `trino.catalog` and `trino.schema` values match actual Trino setup |
| Query timeout too short | Increase timeout in Tab 3 flow (default 30s); adjust complex query complexity |

### 7.8 Socket Connection Failures

**Symptom:** UIBUILDER socket connection fails; WebSocket refuses connection.

**Diagnosis:**

```bash
# Check if UIBUILDER node is accepting connections
kubectl logs -n facis <orce-pod> -f | grep -i "socket\|websocket\|uibuilder"

# Test WebSocket endpoint directly
websocat ws://localhost:1880/socket.io/?EIO=4&transport=websocket

# Check ORCE process is running
kubectl exec -n facis <orce-pod> -- ps aux | grep node-red
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| ORCE not running | `kubectl get pod <orce-pod> -n facis` — if not Running, check events: `kubectl describe pod <orce-pod> -n facis` |
| Port 1880 not exposed | ORCE Service should expose port 1880; verify Service definition |
| WebSocket upgrade blocked | Check for proxy/firewall blocking WebSocket upgrades; ensure X-Forwarded-* headers are set |

---

## 8. Quick Reference Card

```
HELM INSTALL
  helm install facis-ai-insight helm/facis-ai-insight-ui -n facis --create-namespace

HELM UPGRADE (after building Vue app)
  ./scripts/build-and-package.sh
  helm upgrade facis-ai-insight helm/facis-ai-insight-ui -n facis

CREATE SECRETS
  kubectl create secret generic orce-llm-secrets \
    --from-literal=openai-api-key=sk-... \
    --from-literal=anthropic-api-key=sk-ant-... \
    -n facis

PATCH ORCE DEPLOYMENT (with env vars)
  kubectl patch deployment orce -n facis --type=json -p='[
    {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "AI_INSIGHT_BASE_URL", "value": "http://ai-insight-service:8080"}},
    {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "FACIS_OPENAI_API_KEY", "valueFrom": {"secretKeyRef": {"name": "orce-llm-secrets", "key": "openai-api-key"}}}}
  ]'

IMPORT FLOWS
  kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | \
    curl -X POST http://orce:1880/flows -H 'Content-Type: application/json' -d @-

COPY UI FILES
  kubectl cp ui/app/dist/* <ORCE_POD>:/data/uibuilder/aiInsight/src/ -n facis

BUILD & PACKAGE
  ./scripts/build-and-package.sh                   # Build Vue SPA
  ./scripts/build-and-package.sh --skip-install    # Skip npm install

LOCAL DEVELOPMENT
  cd ui/app && npm ci && npm run dev               # Start dev server on :5173
  curl -X POST http://localhost:1880/flows -d @flows/flows.full.json  # Import flows
  npm --prefix ui/app run build                    # Build Vite SPA → ui/app/dist
  cp -r ui/app/dist/* /data/uibuilder/aiInsight/src/  # Copy build to ORCE UIBUILDER

VERIFY DEPLOYMENT
  kubectl get configmap -n facis | grep ai-insight
  kubectl get secret -n facis | grep orce-llm-secrets
  kubectl port-forward svc/orce 1880:1880 -n facis
  open http://localhost:1880/aiInsight/

TROUBLESHOOTING
  kubectl logs -n facis -l app=orce -f
  kubectl describe pod <orce-pod> -n facis
  kubectl exec -n facis <orce-pod> -- curl http://ai-insight-service:8080/health
  kubectl exec -n facis <orce-pod> -- env | grep FACIS_
```

---

(c) ATLAS IoT Lab GmbH -- FACIS FAP IoT & AI Demonstrator
Licensed under Apache License 2.0
