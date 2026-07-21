# Deployment & Operations Guide

**Service:** FACIS FAP IoT & AI — AI Insight Service
**Audience:** DevOps and platform team
**Version:** 0.1.0
**Date:** 05 April 2026

---

## 1. Scope Boundary

This document describes the procedures to deploy and operate the FACIS AI Insight Service. It covers local development, cluster deployment, and end-to-end validation.

### 1.1 Scope Overview

| In-Scope (this guide) | Out-of-Scope (pre-existing infrastructure) |
|---|---|
| AI Insight Service build and deployment | Kubernetes cluster provisioning |
| Local Helm/kind stack | Trino cluster deployment |
| Helm chart installation and configuration | Keycloak identity provider setup |
| Configuration management (environment variables, Secrets, ConfigMaps) | LLM provider setup |
| Health checks and monitoring | Redis cluster provisioning |
| End-to-end validation with curl | TLS root CA creation |

For infrastructure prerequisites (what must be in place before this guide can be followed), see the Project Infrastructure Guide. That document specifies exact Trino configuration, Keycloak realm setup, and network requirements.

---

## 2. Prerequisites

### 2.1 Infrastructure Requirements

Before deploying the AI Insight Service, ensure the following are available:

- **Kubernetes cluster** (1.25+) with `kubectl` configured
- **Helm** (3.x) installed
- **Trino coordinator** accessible from the cluster with:
  - HTTPS enabled
  - OIDC authentication configured
  - Gold schema containing required tables (net_grid_hourly, event_impact_daily, etc.)
  - CA certificate available for TLS verification
- **Keycloak** OIDC provider with:
  - Realm configured
  - FACIS client registered
  - Test user account created
  - Token endpoint accessible
- **LLM chat completions endpoint** (e.g., Azure OpenAI, local) accessible via HTTPS
- **Redis** (optional, for caching) accessible from the cluster

### 2.2 Credentials Checklist

Before starting, gather the following credentials and configuration values:

| Item | Purpose | Where to Find |
|------|---------|---------------|
| LLM API key | Authenticate LLM requests | Your LLM provider (Azure, OpenAI, etc.) |
| LLM chat completions URL | Request endpoint | Your LLM provider console or docs |
| Trino hostname | Connect to query engine | Kubernetes Service FQDN or external IP |
| Trino port | Connect to query engine | Typically 8443 (HTTPS) |
| Trino OIDC token URL | OIDC password-flow exchange | Keycloak realm configuration |
| Trino OIDC client ID | OIDC authentication | Keycloak FACIS client |
| Trino OIDC client secret | OIDC authentication | Keycloak FACIS client |
| Keycloak test user | Credential for OIDC flow | Created in Keycloak admin console |
| Keycloak test password | Credential for OIDC flow | Created in Keycloak admin console |
| Trino CA certificate | TLS verification | Kubernetes secret or file (PEM format) |
| Redis URL (optional) | Cache backend | `redis://host:port/db` or disabled |

---

## 3. Credential Management

### 3.1 Environment File

All sensitive credentials are stored in a `.env` file (excluded from version control via `.gitignore`). Copy the template and fill in values:

```bash
cp .env.example .env
# Edit .env with actual credentials from your infrastructure team
```

The file requires the following variables:

| Variable | Purpose | Example |
|---|---|---|
| `FACIS_ENV` | Environment selector (maps to config overlay) | `development`, `cluster`, `production` |
| `AI_INSIGHT_LLM__API_KEY` | LLM provider API key | Your Azure OpenAI key |
| `AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL` | LLM chat completions endpoint | `https://your-resource.openai.azure.com/...` |
| `AI_INSIGHT_LLM__MODEL` | LLM model identifier | `meta-llama/Llama-3.3-70B-Instruct`, `mistralai/Mistral-Small-24B-Instruct` |
| `AI_INSIGHT_TRINO__HOST` | Trino coordinator hostname | `trino-coordinator.stackable.svc.cluster.local` |
| `AI_INSIGHT_TRINO__PORT` | Trino coordinator port | `8443` |
| `AI_INSIGHT_TRINO__OIDC_TOKEN_URL` | Keycloak token endpoint | `https://keycloak.example.com/realms/facis/protocol/openid-connect/token` |
| `AI_INSIGHT_TRINO__OIDC_CLIENT_ID` | Keycloak OIDC client ID | `ai-insight-service` |
| `AI_INSIGHT_TRINO__OIDC_CLIENT_SECRET` | Keycloak OIDC client secret | Secret from Keycloak console |
| `AI_INSIGHT_TRINO__OIDC_USERNAME` | OIDC password-flow test user | `testuser@facis.local` |
| `AI_INSIGHT_TRINO__OIDC_PASSWORD` | OIDC password-flow test password | Test user password |
| `AI_INSIGHT_CACHE__REDIS_URL` | Redis connection (optional) | `redis://redis-master:6379/0` |

### 3.2 Kubernetes Secrets

For cluster deployment, credentials are stored in Kubernetes Secrets. Create them before installing the Helm chart:

```bash
# Create the namespace
kubectl create namespace facis

# Create LLM credentials Secret
kubectl create secret generic ai-insight-secrets \
  --from-literal=llm_api_key=your-api-key \
  --from-literal=llm_chat_completions_url=https://your-endpoint \
  -n facis

# Create Trino CA certificate Secret (from PEM file)
kubectl create secret generic ai-insight-trino-ca \
  --from-file=ca.crt=/path/to/trino-ca.crt \
  -n facis
```

Verify the Secrets were created:

```bash
kubectl get secrets -n facis
kubectl describe secret ai-insight-secrets -n facis
```

### 3.3 TLS Certificates for Trino

If Trino uses HTTPS (recommended for production), you need the CA certificate that signed Trino's certificate:

```bash
# Extract from Kubernetes (if Trino is in the cluster)
kubectl get secret -n stackable <trino-tls-secret> \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > trino-ca.crt

# Or obtain from your infrastructure team
# Then create the Secret:
kubectl create secret generic ai-insight-trino-ca \
  --from-file=ca.crt=./trino-ca.crt \
  -n facis
```

---

## 4. Local Deployment

### 4.1 Development Setup

Install dependencies for local development:

```bash
# Install the service with dev extras
pip install -e ".[dev]"

# Verify installation
python -c "from src import config; print('OK')"
```

### 4.2 Configure Local Environment

Create a `.env` file for local development:

```bash
cp .env.example .env

# Edit .env with local Trino/LLM endpoints and credentials
nano .env
```

Typical local `.env`:

```
FACIS_ENV=development
AI_INSIGHT_HTTP__HOST=0.0.0.0
AI_INSIGHT_HTTP__PORT=8080
AI_INSIGHT_LLM__API_KEY=your-local-key
AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL=http://localhost:8000/v1/chat/completions
AI_INSIGHT_LLM__MODEL=meta-llama/Llama-3.3-70B-Instruct
AI_INSIGHT_TRINO__HOST=localhost
AI_INSIGHT_TRINO__PORT=8080
AI_INSIGHT_TRINO__HTTP_SCHEME=http
AI_INSIGHT_TRINO__VERIFY=false
AI_INSIGHT_POLICY__ENABLED=false
AI_INSIGHT_RATE_LIMIT__ENABLED=false
AI_INSIGHT_CACHE__ENABLED=false
AI_INSIGHT_LOGGING__LEVEL=INFO
LOG_FORMAT=text
```

### 4.3 Start the Service

```bash
# Run the service locally
python -m src.main

# Expected output:
# 2026-04-05T14:30:00  INFO  src.main  Starting FACIS AI Insight Service
# ...
# Uvicorn running on http://0.0.0.0:8080
```

### 4.4 Verify Health

From another terminal:

```bash
# Health check
curl http://localhost:8080/api/v1/health

# Expected response:
# {"status": "healthy", "service": "ai-insight-service", ...}

# View OpenAPI docs
open http://localhost:8080/docs
```

### 4.5 Stop the Service

```bash
# Press Ctrl+C in the terminal where the service is running
```

---

## 5. Local Development

> **TDR §9.1.1:** Docker Compose is not part of any FACIS deliverable. The
> previous `dev/docker-compose.yml` path has been removed. Local development
> runs the service directly:
>
> ```bash
> cd services/ai-insight-service
> cp .env.example .env
> pip install -e ".[dev]"
> python -m src.main
> ```
>
> See `../guides/setup.md` for the full local setup. Production deployment
> is covered by section 6 below (Kubernetes + Helm).

### 5.1 Test Insight Endpoints (against a running local instance)

```bash
# Energy summary
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: local-test" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC"
  }'
```

---

## 6. Cluster Deployment

### 6.1 Create Kubernetes Namespace and Secrets

```bash
# Create namespace
kubectl create namespace facis

# Create LLM credentials Secret
kubectl create secret generic ai-insight-secrets \
  --from-literal=llm_api_key=$(grep LLM_API_KEY .env | cut -d= -f2) \
  --from-literal=llm_chat_completions_url=$(grep CHAT_COMPLETIONS_URL .env | cut -d= -f2) \
  -n facis

# Create Trino CA certificate Secret
kubectl create secret generic ai-insight-trino-ca \
  --from-file=ca.crt=/path/to/trino-ca.crt \
  -n facis

# Verify Secrets
kubectl get secrets -n facis
```

### 6.2 Create Helm Values File

Create `values-cluster.yaml` with cluster-specific configuration:

```yaml
image:
  repository: ghcr.io/eclipse-xfsc/facis-fap-iot-ai/ai-insight-service
  tag: "0.1.0"

llm:
  model: meta-llama/Llama-3.3-70B-Instruct
  timeoutSeconds: 30
  maxRetries: 3
  requireHttps: true

trino:
  host: trino-coordinator.stackable.svc.cluster.local
  port: "8443"
  httpScheme: https
  verify: /app/certs/trino-ca.crt
  user: trino
  catalog: hive
  targetSchema: gold
  tableNetGridHourly: net_grid_hourly
  tableEventImpactDaily: event_impact_daily
  tableStreetlightZoneHourly: streetlight_zone_hourly
  tableWeatherHourly: weather_hourly
  tableEnergyCostDaily: energy_cost_daily
  tablePvSelfConsumptionDaily: pv_self_consumption_daily

policy:
  enabled: true
  agreementHeader: x-agreement-id
  assetHeader: x-asset-id
  roleHeader: x-user-roles

rateLimit:
  enabled: true
  requestsPerMinute: 10

cache:
  enabled: true
  redisUrl: redis://redis-master:6379/0
  ttlSeconds: 300

audit:
  enabled: true
  logPrompts: true
  logResponses: true

promptTemplates:
  enabled: true
  create: true
  path: /app/config/prompts

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi

trinoCA:
  create: true
  nameOverride: ai-insight-trino-ca

logging:
  level: INFO
```

### 6.3 Install Helm Chart

```bash
cd helm

# Add repository (if using a chart registry)
# helm repo add facis https://your-chart-repo
# helm repo update

# Install the chart
helm install facis-ai-insight ./facis-ai-insight \
  -n facis \
  -f values-cluster.yaml

# Verify installation
helm status facis-ai-insight -n facis

# Check pod status
kubectl get pods -n facis -l app.kubernetes.io/name=ai-insight-service

# View pod logs
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service -f
```

### 6.4 Port-Forward for Local Testing

```bash
# Forward service port to localhost
kubectl port-forward -n facis svc/facis-ai-insight 8080:8080

# In another terminal, test the service
curl http://localhost:8080/api/v1/health
```

### 6.5 Upgrade the Release

To update configuration or upgrade to a new version:

```bash
# Upgrade with new values
helm upgrade facis-ai-insight ./facis-ai-insight \
  -n facis \
  -f values-cluster.yaml \
  --set image.tag=0.1.1

# View release history
helm history facis-ai-insight -n facis

# Rollback if needed
helm rollback facis-ai-insight -n facis 1
```

---

## 7. ORCE Integration

The AI Insight Service can be proxied through ORCE (Node-RED) on the IONOS cluster. ORCE acts as a gateway and can apply additional transformations, logging, or rate limiting before requests reach the AI Insight Service.

### 7.1 ORCE Proxy Configuration

In ORCE's Node-RED flow, create an HTTP request node that forwards requests to the AI Insight Service:

```json
{
  "type": "http request",
  "url": "http://facis-ai-insight:8080/api/v1/insights/{{insightType}}",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "x-agreement-id": "{{agreementId}}",
    "x-asset-id": "{{assetId}}",
    "x-user-roles": "ai_insight_consumer"
  },
  "timeout": 30000
}
```

### 7.2 Testing via ORCE Proxy

```bash
# From a client with ORCE access
curl -X POST http://orce:1880/api/facis/insights/energy-summary \
  -H "Content-Type: application/json" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC"
  }'
```

---

## 8. End-to-End Validation

### 8.1 Health Check

Verify the service is running and healthy:

```bash
curl -v http://localhost:8080/api/v1/health
```

Expected response (200 OK):

```json
{
  "status": "healthy",
  "service": "ai-insight-service",
  "version": "0.1.0",
  "timestamp": "2026-04-05T14:30:00.123Z"
}
```

### 8.2 API Documentation

View the interactive API documentation:

```bash
# Open in browser
open http://localhost:8080/docs

# Or download OpenAPI spec
curl http://localhost:8080/api/openapi.json | python3 -m json.tool
```

### 8.3 Energy Summary Insight

Request an energy trend analysis and forecast:

```bash
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC",
    "include_data": false
  }' | python3 -m json.tool
```

Expected response structure:

```json
{
  "insight_type": "energy-summary",
  "summary": "Energy consumption shows...",
  "key_findings": ["Finding 1", "Finding 2", ...],
  "recommendations": ["Recommendation 1", "Recommendation 2", ...],
  "metadata": {
    "output_id": "uuid",
    "llm_model": "meta-llama/Llama-3.3-70B-Instruct",
    "timestamp": "2026-04-05T14:30:00.123Z",
    "llm_used": true,
    "agreement_id": "agreement-001",
    "asset_id": "asset-001"
  },
  "data": null
}
```

### 8.4 Anomaly Report Insight

Request net-grid outlier analysis:

```bash
curl -X POST http://localhost:8080/api/v1/insights/anomaly-report \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC",
    "robust_z_threshold": 3.5,
    "include_data": false
  }' | python3 -m json.tool
```

Expected: JSON insight with anomaly summary, findings, and recommendations.

### 8.5 City Status Insight

Request Smart City event correlation analysis:

```bash
curl -X POST http://localhost:8080/api/v1/insights/city-status \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC",
    "include_data": false
  }' | python3 -m json.tool
```

Expected: JSON insight with event correlation summary and recommendations.

### 8.6 Get Latest Insights

Retrieve all cached insights from the current session:

```bash
curl http://localhost:8080/api/v1/insights/latest \
  -H "x-agreement-id: agreement-001" | python3 -m json.tool
```

Expected response:

```json
{
  "latest": {
    "energy-summary": {
      "cached_at": "2026-04-05T14:30:00.123Z",
      "output": { "insight_type": "energy-summary", ... }
    },
    "anomaly-report": null,
    "city-status": null
  }
}
```

### 8.7 Policy Enforcement Validation

Test that policy enforcement is working:

```bash
# Request without required headers (should return 403)
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "Content-Type: application/json" \
  -d '{...}'

# Expected: 403 Forbidden with "Access denied by policy"

# Request with wrong role (should return 403)
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: wrong-role" \
  -d '{...}'

# Expected: 403 Forbidden

# Request with correct headers (should return 200 or LLM error)
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{...}'

# Expected: 200 OK with insight JSON
```

### 8.8 Rate Limit Validation

Test that rate limiting works:

```bash
# Script to send 15 rapid requests (assuming limit is 10/minute)
for i in {1..15}; do
  echo "Request $i:"
  curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
    -H "Content-Type: application/json" \
    -H "x-agreement-id: agreement-001" \
    -H "x-asset-id: asset-001" \
    -H "x-user-roles: ai_insight_consumer" \
    -d '{"start_ts": "2026-04-01T00:00:00Z", "end_ts": "2026-04-05T00:00:00Z"}' \
    -w "\nStatus: %{http_code}\n" -s
  sleep 0.1
done
```

Expected: First 10 return 200 or LLM error, 11th onwards return 429 (Rate Limit Exceeded).

---

## 9. Monitoring & Troubleshooting

### 9.1 Health Checks

Perform regular health checks to ensure the service is operational:

```bash
# Service health
curl http://localhost:8080/api/v1/health

# Trino connectivity (check logs)
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service | grep -i trino

# LLM endpoint (check logs on first insight request)
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service | grep -i llm
```

### 9.2 Log Monitoring

View service logs:

```bash
# Live tail
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service -f

# Last 100 lines
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service --tail=100

# Last 5 minutes
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service --since=5m

# From previous pod if crashed
kubectl logs -n facis <pod-name> --previous
```

### 9.3 Common Issues

| Issue | Cause | Resolution |
|---|---|---|
| Health check returns 500 | Trino or LLM unreachable | Verify endpoints in .env or Helm values. Test connectivity manually. |
| Insight requests timeout | LLM response too slow | Increase `llm.timeoutSeconds` in Helm values or .env. Check LLM endpoint load. |
| 403 errors on insight requests | Policy enforcement denying request | Verify required headers are present: `x-agreement-id`, `x-asset-id`, `x-user-roles`. |
| 429 rate limit errors | Request rate exceeded per agreement | Increase `rateLimit.requestsPerMinute` or use different agreement-id. |
| Trino SSL certificate error | Invalid or expired CA certificate | Re-extract Trino CA from Kubernetes secret or obtain fresh certificate. |
| Redis connection failures | Redis not running or URL wrong | Check Redis pod/container is running. Verify `cache.redisUrl` format. |
| Slow cache hits | Redis network latency | Increase `cache.connectTimeoutSeconds`. Check network latency to Redis. |

---

## 10. Cleanup and Shutdown

### 10.1 Kubernetes

```bash
# Uninstall Helm release
helm uninstall facis-ai-insight -n facis

# Delete namespace (removes all resources)
kubectl delete namespace facis

# Delete Secrets if managing manually
kubectl delete secret ai-insight-secrets ai-insight-trino-ca -n facis
```

---

(c) ATLAS IoT Lab GmbH -- FACIS FAP IoT & AI Demonstrator
Licensed under Apache License 2.0
