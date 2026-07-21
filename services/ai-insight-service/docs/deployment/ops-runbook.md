# Operations Runbook

**Service:** FACIS FAP IoT & AI — AI Insight Service
**Audience:** DevOps and platform team
**Version:** 0.1.0
**Date:** 05 April 2026

---

## 1. Service Overview

The AI Insight Service generates LLM-powered insights from FACIS IoT and Smart City data stored in Trino. It exposes three distinct insight types via REST API, enforces request-level governance policies, implements rate limiting, and supports optional Redis caching.

### Ports and Protocols

| Port | Protocol | Purpose | Default Container Port |
|------|----------|---------|------------------------|
| 8080 | HTTP/TCP | REST API, health checks, Swagger UI | 8080 |

### Insight Types

The service produces three insight types, each triggered by a dedicated endpoint:

| Insight Type | Endpoint | Purpose | Input Data |
|--------------|----------|---------|-----------|
| energy-summary | `POST /api/v1/insights/energy-summary` | Energy trend analysis and 24h forecast | Historical energy, weather, PV generation |
| anomaly-report | `POST /api/v1/insights/anomaly-report` | Net-grid outlier detection | Energy consumption, generation, costs |
| city-status | `POST /api/v1/insights/city-status` | Smart City event correlation | Events, streetlight activity, response lags |

---

## 2. Kubernetes Deployment with Helm

### 2.1 Prerequisites

- Kubernetes 1.25+
- Helm 3.x installed
- `kubectl` configured with cluster access
- Container image pushed to registry
- Trino cluster accessible from the cluster with OIDC authentication configured
- LLM chat completions endpoint (e.g., Azure OpenAI, local) accessible
- Redis accessible (if caching enabled)

### 2.2 Build and Push Image

```bash
# Build the production image
docker build -t ghcr.io/eclipse-xfsc/facis-fap-iot-ai/ai-insight-service:0.1.0 .

# Push to container registry
docker push ghcr.io/eclipse-xfsc/facis-fap-iot-ai/ai-insight-service:0.1.0
```

### 2.3 Install the Chart

```bash
cd helm

# Install with defaults (local dev)
helm install facis-ai-insight ./facis-ai-insight -n facis --create-namespace

# Install with overrides for a production cluster
helm install facis-ai-insight ./facis-ai-insight -n facis --create-namespace \
  --set image.tag=0.1.0 \
  --set llm.chatCompletionsUrl=https://your-llm-endpoint/v1/chat/completions \
  --set llm.apiKey=your-api-key \
  --set llm.model=meta-llama/Llama-3.3-70B-Instruct \
  --set trino.host=trino-coordinator.stackable.svc.cluster.local \
  --set trino.port=8443 \
  --set trino.httpScheme=https \
  --set rateLimit.requestsPerMinute=10 \
  --set cache.enabled=true \
  --set cache.redisUrl=redis://redis-master:6379/0

# Install with a values override file
helm install facis-ai-insight ./facis-ai-insight -n facis -f values-cluster.yaml
```

### 2.4 Upgrade and Rollback

```bash
# Upgrade with new values
helm upgrade facis-ai-insight ./facis-ai-insight -n facis \
  --set llm.model=meta-llama/Llama-3.3-70B-Instruct

# Rollback to previous revision
helm rollback facis-ai-insight -n facis

# View release history
helm history facis-ai-insight -n facis
```

### 2.5 Uninstall

```bash
helm uninstall facis-ai-insight -n facis
```

### 2.6 Verify Deployment

```bash
# Check pod status
kubectl get pods -n facis -l app.kubernetes.io/name=ai-insight-service

# View pod logs
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service -f

# Port-forward for local access
kubectl port-forward -n facis svc/facis-ai-insight 8080:8080

# Test health endpoint
curl http://localhost:8080/api/v1/health
```

### 2.7 Cluster Deployment Example

For the FACIS Stackable cluster, create a `values-cluster.yaml`:

```yaml
image:
  tag: "0.1.0"

llm:
  chatCompletionsUrl: "https://your-llm-endpoint/v1/chat/completions"
  apiKey: "your-api-key"
  model: "meta-llama/Llama-3.3-70B-Instruct"
  requireHttps: true

trino:
  host: trino-coordinator.stackable.svc.cluster.local
  port: "8443"
  httpScheme: https
  verify: /app/certs/trino-ca.crt
  targetSchema: gold

policy:
  enabled: true
  requiredRoles: ["ai_insight_consumer"]

rateLimit:
  enabled: true
  requestsPerMinute: 10

cache:
  enabled: true
  redisUrl: "redis://redis-master:6379/0"
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
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi

trinoCA:
  create: true
  crt: |
    -----BEGIN CERTIFICATE-----
    ... base64-encoded Trino CA certificate ...
    -----END CERTIFICATE-----

extraVolumes:
  - name: trino-certs
    secret:
      secretName: ai-insight-trino-ca

extraVolumeMounts:
  - name: trino-certs
    mountPath: /app/certs
    readOnly: true
```

```bash
helm install facis-ai-insight ./facis-ai-insight -n facis -f values-cluster.yaml
```

---

## 3. Local Development

> **TDR §9.1.1:** Docker Compose is not part of any FACIS deliverable. The
> previous `dev/docker-compose.yml` path has been removed to align with the
> TDR. Local development runs the service directly:
>
> ```bash
> cd services/ai-insight-service
> cp .env.example .env
> pip install -e ".[dev]"
> python -m src.main
> ```
>
> Production runs on Kubernetes (Helm chart at `helm/`) and ORCE flows
> (`orce/`). See `../guides/setup.md` for the full local-development
> workflow and section 4 below for Helm value reference.

---

## 4. Helm Values Reference

### 4.1 Image Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image.repository` | string | `ghcr.io/eclipse-xfsc/facis-fap-iot-ai/ai-insight-service` | Container registry/repo |
| `image.tag` | string | Chart appVersion | Image tag |
| `image.pullPolicy` | string | `IfNotPresent` | `Always`, `IfNotPresent`, `Never` |
| `imagePullSecrets` | list | `[]` | Registry pull secrets |

### 4.2 LLM Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `llm.chatCompletionsUrl` | string | `""` | OpenAI-compatible chat completions endpoint (required) |
| `llm.apiKey` | string | `""` | LLM provider API key (required) |
| `llm.model` | string | `meta-llama/Llama-3.3-70B-Instruct` | Model identifier |
| `llm.timeoutSeconds` | int | `30` | Request timeout |
| `llm.maxRetries` | int | `3` | Retry attempts on transient errors |
| `llm.retryBaseDelaySecs` | float | `0.5` | Exponential backoff base delay |
| `llm.retryMaxDelaySecs` | float | `8.0` | Exponential backoff maximum delay |
| `llm.requireHttps` | bool | `true` | Enforce HTTPS on completions URL |

### 4.3 Trino Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `trino.host` | string | `trino` | Trino coordinator hostname |
| `trino.port` | string | `8443` | Trino coordinator port |
| `trino.httpScheme` | string | `https` | `http` or `https` |
| `trino.verify` | string | `/app/certs/trino-ca.crt` | CA certificate path or boolean |
| `trino.user` | string | `trino` | Trino session user |
| `trino.catalog` | string | `hive` | Trino catalog name |
| `trino.targetSchema` | string | `gold` | Target schema for insight queries |
| `trino.tableNetGridHourly` | string | `net_grid_hourly` | Net-grid base table |
| `trino.tableEventImpactDaily` | string | `event_impact_daily` | Event impact source table |
| `trino.tableStreetlightZoneHourly` | string | `streetlight_zone_hourly` | Streetlight activity table |
| `trino.tableWeatherHourly` | string | `weather_hourly` | Weather data table |
| `trino.tableEnergyCostDaily` | string | `energy_cost_daily` | Energy cost table |
| `trino.tablePvSelfConsumptionDaily` | string | `pv_self_consumption_daily` | PV self-consumption table |

### 4.4 Policy Enforcement

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `policy.enabled` | bool | `true` | Enable request-level policy checks |
| `policy.agreementHeader` | string | `x-agreement-id` | Agreement ID header name |
| `policy.assetHeader` | string | `x-asset-id` | Asset ID header name |
| `policy.roleHeader` | string | `x-user-roles` | Roles header name |

### 4.5 Rate Limiting

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `rateLimit.enabled` | bool | `true` | Enable per-client throttling |
| `rateLimit.requestsPerMinute` | int | `10` | Max requests/minute per agreement |

### 4.6 Redis Cache

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cache.enabled` | bool | `false` | Enable response caching |
| `cache.redisUrl` | string | `""` | Redis connection URL |
| `cache.ttlSeconds` | int | `300` | Cache entry TTL |
| `cache.keyPrefix` | string | `ai-insight:cache:v1` | Cache key prefix |
| `cache.connectTimeoutSeconds` | float | `1.0` | Redis connection timeout |

### 4.7 Audit Logging

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audit.enabled` | bool | `true` | Enable audit logging |
| `audit.logPrompts` | bool | `true` | Log LLM prompts |
| `audit.logResponses` | bool | `true` | Log LLM responses |

### 4.8 Prompt Templates

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `promptTemplates.enabled` | bool | `true` | Load templates from disk |
| `promptTemplates.path` | string | `/app/config/prompts` | Template mount path |
| `promptTemplates.create` | bool | `true` | Create ConfigMap from values |
| `promptTemplates.templates` | map | (see values.yaml) | Template file contents |

### 4.9 Service and Ports

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `http.port` | int | `8080` | HTTP container port |
| `service.type` | string | `ClusterIP` | K8s Service type |
| `service.httpPort` | int | `8080` | Service HTTP port |

### 4.10 Resource Requests and Limits

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `resources.requests.cpu` | string | `100m` | CPU request |
| `resources.requests.memory` | string | `256Mi` | Memory request |
| `resources.limits.cpu` | string | `500m` | CPU limit |
| `resources.limits.memory` | string | `512Mi` | Memory limit |

### 4.11 Security Context

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `podSecurityContext.runAsNonRoot` | bool | `true` | Enforce non-root |
| `podSecurityContext.runAsUser` | int | `1000` | UID |
| `podSecurityContext.runAsGroup` | int | `1000` | GID |
| `podSecurityContext.fsGroup` | int | `1000` | Filesystem group |
| `securityContext.readOnlyRootFilesystem` | bool | `true` | Read-only root FS |
| `securityContext.allowPrivilegeEscalation` | bool | `false` | No escalation |
| `securityContext.capabilities.drop` | list | `[ALL]` | Dropped capabilities |

### 4.12 Additional Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `logging.level` | string | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |
| `replicaCount` | int | `1` | Pod replicas (1 recommended) |
| `serviceAccount.create` | bool | `true` | Create ServiceAccount |
| `serviceAccount.automountServiceAccountToken` | bool | `false` | No API token mount |
| `ingress.enabled` | bool | `false` | Enable Ingress resource |
| `extraEnv` | list | `[]` | Additional environment variables |
| `extraVolumes` | list | `[]` | Additional volumes |
| `extraVolumeMounts` | list | `[]` | Additional volume mounts |
| `nodeSelector` | object | `{}` | Node selector labels |
| `tolerations` | list | `[]` | Pod tolerations |
| `affinity` | object | `{}` | Pod affinity rules |

---

## 5. Health and Monitoring Endpoints

### 5.1 Health Check

Used by Docker HEALTHCHECK, Kubernetes liveness/readiness probes, and load balancers.

```bash
curl http://localhost:8080/api/v1/health
```

Response (HTTP 200):

```json
{
  "status": "healthy",
  "service": "ai-insight-service",
  "version": "0.1.0",
  "timestamp": "2026-04-05T14:30:00.123Z"
}
```

Probe configuration (Kubernetes):

- **Liveness probe**: GET `/api/v1/health`, initial delay 10s, period 30s, timeout 3s, failure threshold 3
- **Readiness probe**: GET `/api/v1/health`, initial delay 5s, period 10s, timeout 3s, failure threshold 3

### 5.2 API Documentation

| Endpoint | Purpose |
|----------|---------|
| `GET /docs` | Swagger UI (interactive) |
| `GET /redoc` | ReDoc (readable) |
| `GET /api/openapi.json` | OpenAPI 3.0 specification |

### 5.3 Insight Endpoints

```bash
# Energy summary and 24h forecast
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC"
  }'

# Net-grid outlier analysis
curl -X POST http://localhost:8080/api/v1/insights/anomaly-report \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC"
  }'

# Smart City event correlation
curl -X POST http://localhost:8080/api/v1/insights/city-status \
  -H "Content-Type: application/json" \
  -H "x-agreement-id: agreement-001" \
  -H "x-asset-id: asset-001" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{
    "start_ts": "2026-04-01T00:00:00Z",
    "end_ts": "2026-04-05T00:00:00Z",
    "timezone": "UTC"
  }'
```

### 5.4 Get Latest Insights (Cached)

```bash
# Retrieve all cached insights (or None if none cached yet)
curl http://localhost:8080/api/v1/insights/latest \
  -H "x-agreement-id: agreement-001"
```

Response:

```json
{
  "latest": {
    "energy-summary": {
      "cached_at": "2026-04-05T14:30:00Z",
      "output": { "insight_type": "energy-summary", ... }
    },
    "anomaly-report": null,
    "city-status": null
  }
}
```

### 5.5 Monitoring Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Service alive | `curl /api/v1/health` | `{"status": "healthy"}` |
| Trino reachable | Service logs or manually via Python | No connection errors |
| LLM endpoint reachable | Service logs or curl to endpoint | 200 or 401 response |
| Policy enforcement active | Request without required headers returns 403 | Governance enforced |
| Rate limiting active | 11+ rapid requests from same agreement-id | 429 on 11th request |
| Redis connection | Service logs on startup | `Connected to Redis` or disabled |

---

## 6. Logging Configuration

### 6.1 Log Format

The service uses structured JSON logging (default) or text format. Format is controlled by the `LOG_FORMAT` environment variable:

| Format | Use Case | Environment Variable |
|--------|----------|---------------------|
| `json` (default) | Production — machine-readable JSON lines for log aggregators | `LOG_FORMAT=json` |
| `text` | Development — human-readable timestamps, levels, and messages | `LOG_FORMAT=text` |

### 6.2 Log Levels

| Level | Use Case | Environment Variable |
|-------|----------|---------------------|
| `DEBUG` | Development — full trace including request/response details | `LOG_LEVEL=DEBUG` or `AI_INSIGHT_LOGGING__LEVEL=DEBUG` |
| `INFO` | Normal operations — startup, connections, request summaries (default) | `LOG_LEVEL=INFO` or `AI_INSIGHT_LOGGING__LEVEL=INFO` |
| `WARNING` | Production baseline — only unexpected conditions | `LOG_LEVEL=WARNING` or `AI_INSIGHT_LOGGING__LEVEL=WARNING` |
| `ERROR` | Alerts — only failures requiring attention | `LOG_LEVEL=ERROR` or `AI_INSIGHT_LOGGING__LEVEL=ERROR` |
| `CRITICAL` | Fatal — service cannot continue | `LOG_LEVEL=CRITICAL` or `AI_INSIGHT_LOGGING__LEVEL=CRITICAL` |

### 6.3 Log Format Examples

JSON format (production):
```json
{"timestamp": "2026-04-05T14:30:00+0000", "level": "INFO", "logger": "src.api", "message": "Received energy-summary request", "service": "ai-insight-service"}
```

Text format (development):
```
2026-04-05T14:30:00+0000  INFO      src.api  Received energy-summary request
```

### 6.4 Sensitive Data Redaction

API keys, passwords, tokens, and authorization headers are automatically redacted before emission. Pattern examples:
- `api_key=abc123` → `api_key=***REDACTED***`
- `"token": "xyz"` → `"token": "***REDACTED***"`

### 6.5 Configuration Methods

Configuration is applied with this priority (highest first):

1. **Environment variable**: `LOG_LEVEL=DEBUG` (for root logger) or `AI_INSIGHT_LOGGING__LEVEL=DEBUG` (for service)
2. **YAML file**: `logging.level: DEBUG` in `config/default.yaml` or environment overlay
3. **Built-in default**: `INFO`

### 6.6 Viewing Logs

```bash
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service -f
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service --since=5m
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service --previous  # Crashed pod
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service --tail=100 -f
```

---

## 7. Common Troubleshooting Scenarios

### 7.1 Service Fails to Start

**Symptom:** Pod in `CrashLoopBackOff` or Docker container exits immediately.

**Check logs:**
```bash
kubectl logs -n facis <pod-name> --previous
```

**Common causes:**

| Cause | Log message | Fix |
|-------|-------------|-----|
| LLM endpoint unreachable | `Failed to initialize OpenAICompatibleClient` or connection timeout | Verify `llm.chatCompletionsUrl` is correct and accessible. Check network policy and firewall. |
| Trino host unreachable | `Failed to connect to Trino` or DNS resolution failure | Verify `trino.host` and `trino.port`. Check DNS resolution with `nslookup`. |
| Invalid LLM API key | Service logs or 401 on first LLM call | Verify `llm.apiKey` is correct and non-empty. |
| Invalid Trino CA certificate | `SSLError: certificate verify failed` | Verify `trinoCA.crt` contains valid PEM certificate. Re-extract from Kubernetes secret if needed. |
| Redis connection failure (if cache enabled) | `Failed to connect to Redis` | Verify `cache.redisUrl` is correct. Check Redis pod is running. |
| Permission denied | `PermissionError: /app/...` | Verify `readOnlyRootFilesystem` has `/tmp` emptyDir mounted. |
| Invalid config YAML | `ValidationError` or `yaml.scanner.ScannerError` | Check ConfigMap or `config/default.yaml` syntax. Validate JSON in environment variables. |

### 7.2 LLM Connection Failures

**Symptom:** Insight requests return 500 with "LLM service unavailable" or timeout errors.

**Diagnosis:**
```bash
# Test LLM endpoint manually
curl -X POST https://your-llm-endpoint/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "meta-llama/Llama-3.3-70B-Instruct", "messages": [{"role": "user", "content": "test"}]}'

# Check service logs for retry attempts
kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service 2>&1 | grep -i "llm\|retry\|timeout"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| LLM endpoint down or unreachable | Test endpoint with curl. Check network connectivity. |
| API key invalid or expired | Verify credentials in Secret. Regenerate if needed. |
| Model identifier wrong | Check model name in Helm values matches provider's API. |
| Timeout too short | Increase `llm.timeoutSeconds` (default 30) if LLM is slow. |
| Max retries exhausted | LLM returned non-retryable error (e.g., 401). Fix credentials. |

### 7.3 Trino Authentication Failures

**Symptom:** Insight requests return 500 with "Trino authentication failed" or 401 errors.

**Diagnosis:**
```bash
# Check OIDC token endpoint (if using OIDC)
curl -X POST https://keycloak-url/token \
  -d "grant_type=password&username=user&password=pass&client_id=client&client_secret=secret"

# Verify Trino OIDC is configured
kubectl exec -n stackable <trino-pod> -- \
  curl -s http://localhost:8080/v1/info | grep -i oidc
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| OIDC token URL misconfigured | Verify token endpoint URL matches Keycloak realm configuration. |
| Client credentials wrong | Check `oidc_client_id` and `oidc_client_secret` in environment or YAML. |
| User credentials wrong | Verify Keycloak user exists and password is correct. |
| OIDC scope mismatch | Default scope is `openid`. Check if Trino requires additional scopes like `profile`. |
| Trino CA certificate invalid | If using HTTPS, verify `trinoCA.crt` is valid and up-to-date. |

### 7.4 Policy 403 Errors

**Symptom:** Requests return 403 with "Access denied by policy" message.

**Diagnosis:**
```bash
# Test request with required headers
curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
  -H "x-agreement-id: test-agreement" \
  -H "x-asset-id: test-asset" \
  -H "x-user-roles: ai_insight_consumer" \
  -d '{"start_ts": "2026-04-01T00:00:00Z", "end_ts": "2026-04-05T00:00:00Z"}'
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Missing required role header | Include `x-user-roles: ai_insight_consumer` (or your configured role). |
| Role not in required list | Verify user roles match `policy.requiredRoles` in Helm values. |
| Policy enforcement enabled but headers missing | If policy is enabled, all three headers (agreement, asset, roles) are required. |
| Role header format wrong | Roles are comma-separated: `x-user-roles: role1,role2`. |

### 7.5 Rate Limit 429 Errors

**Symptom:** Every Nth request returns 429 with "Rate limit exceeded" message.

**Diagnosis:**
```bash
# Verify rate limit config
kubectl exec -n facis <pod-name> -- \
  env | grep RATE_LIMIT

# Send rapid requests to trigger limit (if limit is 10 requests/minute)
for i in {1..15}; do
  curl -X POST http://localhost:8080/api/v1/insights/energy-summary \
    -H "x-agreement-id: test" \
    -d '{...}' &
done
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Client exceeds configured request rate | Increase `rateLimit.requestsPerMinute` in Helm values. Default is 10. |
| Multiple clients share same agreement-id | Use unique agreement-ids for rate-limit isolation. |
| Rate limit disabled for testing | Set `rateLimit.enabled: false` in Helm values. |

### 7.6 Redis Connection Issues

**Symptom:** Cache not working; logs show `Failed to connect to Redis` or cache hits are always misses.

**Diagnosis:**
```bash
# Check Redis is running and healthy
kubectl get pods -n facis -l app=redis

# Test Redis connection (in-cluster)
kubectl exec -n facis -it deploy/redis -- redis-cli ping
# Expected: PONG

# Check cache keys
kubectl exec -n facis -it deploy/redis -- redis-cli KEYS "ai-insight:*"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Redis not running | Check K8s pod status: `kubectl get pods -n facis -l app=redis`. |
| Redis URL misconfigured | Verify `cache.redisUrl` format: `redis://host:port/db`. Include password if needed. |
| Redis disabled | If caching is not needed, set `cache.enabled: false` in Helm values. |
| Connection timeout | Increase `cache.connectTimeoutSeconds` (default 1.0) if Redis is slow. |
| Wrong Redis database | Verify database number in URL (default is 0): `redis://redis:6379/0`. |

### 7.7 Configuration Not Taking Effect

**Symptom:** Changed Helm values but service behaves the same.

**Diagnosis:**
```bash
# Check actual environment in the pod
kubectl exec -n facis <pod-name> -- env | grep AI_INSIGHT_

# Check mounted ConfigMap (if using prompt templates)
kubectl exec -n facis <pod-name> -- cat /app/config/prompts/*

# Verify Helm values
helm get values facis-ai-insight -n facis
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Pod not restarted after upgrade | Helm automatically rolls out new pods on `helm upgrade`. If not, manually delete pod: `kubectl delete pod <pod> -n facis`. |
| Env var overrides YAML | Environment variables take precedence over Helm values. Check `extraEnv` and base env in Deployment. |
| Typo in env var name | Must use `AI_INSIGHT_` prefix with `__` (double underscore) for nesting: `AI_INSIGHT_TRINO__HOST`, not `AI_INSIGHT_TRINO_HOST`. |
| ConfigMap not reloaded | If prompt templates changed, restart the pod for the new ConfigMap to be mounted. |

---

## 8. Resource Recommendations

### 8.1 Baseline (Default Configuration)

With default settings (1 replica, Redis caching enabled):

| Resource | Request | Limit | Notes |
|----------|---------|-------|-------|
| CPU | 100m | 500m | ~80m steady state during insight generation |
| Memory | 256Mi | 512Mi | ~200Mi RSS during LLM calls |

### 8.2 High-Throughput Deployment

At 60+ requests/minute with caching enabled:

| Resource | Request | Limit | Notes |
|----------|---------|-------|-------|
| CPU | 250m | 1000m | Increased due to LLM processing parallelism |
| Memory | 256Mi | 512Mi | Memory usage unchanged; Redis offloads cache |

### 8.3 Supporting Services

Resource recommendations for co-deployed services:

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------|------------|-----------|----------------|--------------|
| Redis (single instance) | 50m | 200m | 64Mi | 256Mi |
| Trino coordinator | 2000m | 4000m | 4Gi | 8Gi |
| Keycloak (OIDC) | 500m | 1000m | 512Mi | 1Gi |

### 8.4 Storage

| Volume | Size | Purpose |
|--------|------|---------|
| /tmp emptyDir (service) | 64Mi | Temporary files (Python caches) |
| Redis data | 100Mi | Cache storage (depends on TTL and request rate) |

---

## 9. Quick Reference Card

```
SERVICE ENDPOINTS
  Health:           GET  /api/v1/health
  Docs:             GET  /docs
  OpenAPI:          GET  /api/openapi.json
  Energy Summary:   POST /api/v1/insights/energy-summary
  Anomaly Report:   POST /api/v1/insights/anomaly-report
  City Status:      POST /api/v1/insights/city-status
  Latest Insights:  GET  /api/v1/insights/latest

REQUIRED REQUEST HEADERS (if policy enabled)
  x-agreement-id:   agreement identifier (required)
  x-asset-id:       asset identifier (required)
  x-user-roles:     comma-separated roles (required, must include ai_insight_consumer)

ENVIRONMENT VARIABLES (AI_INSIGHT_ prefix, __ nesting)
  AI_INSIGHT_HTTP__HOST=0.0.0.0
  AI_INSIGHT_HTTP__PORT=8080
  AI_INSIGHT_LLM__API_KEY=your-api-key
  AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL=https://...
  AI_INSIGHT_LLM__MODEL=meta-llama/Llama-3.3-70B-Instruct
  AI_INSIGHT_TRINO__HOST=trino
  AI_INSIGHT_TRINO__PORT=8443
  AI_INSIGHT_TRINO__HTTP_SCHEME=https
  AI_INSIGHT_TRINO__VERIFY=/app/certs/trino-ca.crt
  AI_INSIGHT_POLICY__ENABLED=true
  AI_INSIGHT_RATE_LIMIT__ENABLED=true
  AI_INSIGHT_RATE_LIMIT__REQUESTS_PER_MINUTE=10
  AI_INSIGHT_CACHE__ENABLED=true
  AI_INSIGHT_CACHE__REDIS_URL=redis://redis:6379/0
  AI_INSIGHT_LOGGING__LEVEL=INFO

HELM INSTALL
  helm install facis-ai-insight ./helm/facis-ai-insight -n facis --create-namespace

LOCAL DEV (no Docker Compose — TDR §9.1.1)
  cd services/ai-insight-service && cp .env.example .env && python -m src.main

TROUBLESHOOTING
  kubectl logs -n facis -l app.kubernetes.io/name=ai-insight-service -f
  kubectl describe pod -n facis <pod>
  curl http://localhost:8080/api/v1/health
  kubectl exec -n facis -it deploy/redis -- redis-cli KEYS "ai-insight:*"
```

---

(c) ATLAS IoT Lab GmbH -- FACIS FAP IoT & AI Demonstrator
Licensed under Apache License 2.0
