# FACIS FAP IoT-AI Deployment Walkthrough

> **Single authoritative guide for deploying FACIS FAP IoT-AI from zero to running.**
> Every command is copy-pasteable. Validation gates confirm success at each step.
> For the acceptance testing team — follow this exactly as written.

**Last updated:** 2026-02-06  
**Target audience:** QA team, DevOps engineers, system integrators  
**Kubernetes minimum:** 1.25+  
**Helm minimum:** 3.0+

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Create Namespace and Image Pull Secret](#step-1-create-namespace-and-image-pull-secret)
3. [Step 2: Deploy Simulation Service](#step-2-deploy-simulation-service)
4. [Step 3: Deploy AI Insight Service](#step-3-deploy-ai-insight-service)
5. [Step 4: Deploy AI Insight UI](#step-4-deploy-ai-insight-ui)
6. [Step 5: ORCE Integration](#step-5-orce-integration)
7. [Step 6: End-to-End Verification](#step-6-end-to-end-verification)
8. [Upgrading](#upgrading)
9. [Uninstalling](#uninstalling)
10. [Rollback](#rollback)
11. [Appendices](#appendices)

---

## Prerequisites

Before starting, verify your environment has the required tools, cluster access, and credentials.

### Environment Checklist

| Requirement | Verify Command | Expected Output |
|---|---|---|
| **kubectl** installed | `kubectl version --client --short` | `v1.25.0` or higher |
| **Helm** installed | `helm version --short` | `v3.0.0` or higher |
| **Cluster access** | `kubectl cluster-info` | Cluster endpoint visible |
| **Default namespace context** | `kubectl config current-context` | Shows cluster name |
| **Docker registry auth** | `docker login ghcr.io` | Login successful (if private) |

### Cluster Requirements

| Resource | Minimum | Notes |
|---|---|---|
| **Kubernetes version** | 1.25+ | Verify with `kubectl version --short` |
| **Nodes available** | 3 | `kubectl get nodes` must list 3+ Ready nodes |
| **Free CPU** | 2 cores | Simulation (500m) + AI Insight (500m) + UI (ConfigMaps only) |
| **Free memory** | 1.5 GB | Simulation (512Mi) + AI Insight (512Mi) + buffers |
| **StorageClass** | Not required | All services are stateless |

### Required Secrets & Credentials

You will need the following before proceeding. Obtain from your DevOps team or API provider:

| Credential | Description | Example |
|---|---|---|
| **LLM API endpoint** | OpenAI-compatible chat completions URL | `https://api.openai.com/v1/chat/completions` |
| **LLM API key** | API key for the LLM service | `sk-proj-xxxxx` |
| **Trino CA certificate** | PEM-encoded CA certificate (if TLS enabled) | `-----BEGIN CERTIFICATE-----...` |
| **MQTT broker hostname** | MQTT broker accessible from cluster | `mqtt.your-cluster:1883` |
| **Kafka bootstrap servers** | Kafka broker addresses | `kafka-0:9092,kafka-1:9092,kafka-2:9092` |

### Pre-Flight Validation

Run these commands to confirm readiness. All should succeed before proceeding.

```bash
# Verify cluster connectivity
kubectl get nodes
# Expected: 3+ nodes with STATUS=Ready

# Verify Helm can access the cluster
helm repo list
# Expected: helm can reach your cluster

# Verify MQTT is reachable (skip if testing locally)
# kubectl run -it --rm debug --image=busybox --restart=Never -- \
#   nc -zv mqtt.your-cluster 1883

# Verify Kafka is reachable (skip if testing locally)
# kubectl run -it --rm debug --image=busybox --restart=Never -- \
#   nc -zv kafka-0.your-cluster 9092
```

---

## Step 1: Create Namespace and Image Pull Secret

Create the `facis` namespace to isolate FACIS services from other workloads.

### 1.1 Create the Namespace

```bash
kubectl create namespace facis
```

**Validation:** Confirm namespace exists

```bash
kubectl get namespace facis
# Expected output:
# NAME   STATUS   AGE
# facis  Active   10s
```

### 1.2 Create Image Pull Secret (If Using Private Registry)

The FACIS Docker images are hosted on GitHub Container Registry (GHCR). If your cluster cannot access public GHCR, create an image pull secret:

```bash
# Substitute your GHCR credentials
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=<your-github-username> \
  --docker-password=<your-github-personal-access-token> \
  --docker-email=<your-email> \
  -n facis
```

**Validation:** Confirm secret exists

```bash
kubectl get secret ghcr-secret -n facis
# Expected output:
# NAME           TYPE                             DATA   AGE
# ghcr-secret    kubernetes.io/dockercfg          1      5s
```

### 1.3 Store Credentials for Later Use

You will need these values in Step 3. Save them to a temporary file:

```bash
# Create a temporary values override file for later
cat > /tmp/facis-values-override.yaml << 'EOF'
# AI Insight LLM credentials (fill in Step 3)
llm:
  chatCompletionsUrl: ""  # TODO: set in Step 3
  apiKey: ""              # TODO: set in Step 3

# Trino CA certificate (fill in Step 3)
trinoCA:
  crt: ""                 # TODO: set in Step 3

# Image pull secret (if using private registry)
imagePullSecrets: []      # TODO: add [{"name": "ghcr-secret"}] if needed
EOF
```

**Next:** Proceed to [Step 2: Deploy Simulation Service](#step-2-deploy-simulation-service)

---

## Step 2: Deploy Simulation Service

The Simulation Service generates deterministic IoT telemetry (energy meters, PV systems, weather, prices, consumers) and publishes to MQTT, Kafka, and ORCE via webhooks.

### 2.1 Helm Install Command

Replace the bracketed values with your infrastructure details:

```bash
helm install facis-simulation \
  services/simulation/helm/facis-simulation/ \
  --namespace facis \
  --set simulation.seed=12345 \
  --set simulation.speedFactor=1.0 \
  --set mqtt.host=[MQTT_BROKER_HOSTNAME] \
  --set mqtt.port=1883 \
  --set kafka.enabled=true \
  --set kafka.bootstrapServers=[KAFKA_BOOTSTRAP_SERVERS] \
  --set kafka.securityProtocol=PLAINTEXT \
  --set orce.enabled=false \
  --set replicaCount=1
```

**Example with real values:**

```bash
helm install facis-simulation \
  services/simulation/helm/facis-simulation/ \
  --namespace facis \
  --set simulation.seed=12345 \
  --set simulation.speedFactor=1.0 \
  --set mqtt.host=mqtt-broker \
  --set mqtt.port=1883 \
  --set kafka.enabled=true \
  --set kafka.bootstrapServers=kafka-0:9092,kafka-1:9092,kafka-2:9092 \
  --set kafka.securityProtocol=PLAINTEXT \
  --set orce.enabled=false \
  --set replicaCount=1
```

### 2.2 Validate Deployment

**Check pod status (wait for Running):**

```bash
kubectl get pods -n facis -l app.kubernetes.io/name=facis-simulation
# Expected output after ~30s:
# NAME                                       READY   STATUS    RESTARTS   AGE
# facis-simulation-xxxxxxxxxx-xxxxx          1/1     Running   0          15s
```

Wait for `STATUS=Running` before proceeding. If stuck on `Pending` or `CrashLoopBackOff`, check logs:

```bash
kubectl logs -n facis -l app.kubernetes.io/name=facis-simulation --tail=50
```

### 2.3 Test Health Endpoint

Create a port-forward to the pod and test the health endpoint:

```bash
# Terminal 1: Start port-forward (keep running)
POD=$(kubectl get pods -n facis -l app.kubernetes.io/name=facis-simulation -o jsonpath="{.items[0].metadata.name}")
kubectl port-forward -n facis $POD 8080:8080

# Terminal 2: Test the endpoint
sleep 3 && curl -v http://localhost:8080/api/v1/health
```

**Expected response:**

```json
{
  "status": "healthy",
  "service": "facis-simulation-service",
  "version": "1.0.0",
  "timestamp": "2026-02-06T10:45:32Z"
}
```

### 2.4 Verify Configuration

Check that the ConfigMap was created with correct values:

```bash
kubectl get configmap -n facis | grep facis-simulation

# View the actual configuration
kubectl get configmap facis-simulation-config -n facis -o jsonpath='{.data.default\.yaml}'
```

**Expected keys in output:**
- `simulation.seed: 12345`
- `mqtt.host: [MQTT_BROKER_HOSTNAME]`
- `kafka.bootstrap_servers: [KAFKA_BOOTSTRAP_SERVERS]`

**Next:** Proceed to [Step 3: Deploy AI Insight Service](#step-3-deploy-ai-insight-service)

---

## Step 3: Deploy AI Insight Service

The AI Insight Service provides natural-language analysis of telemetry by querying Trino and orchestrating LLM completions with structured prompts, policy enforcement, and rate limiting.

### 3.1 Prepare Secrets

#### 3.1.1 Create the LLM Credentials Secret

```bash
# Set environment variables (substitute real values)
export LLM_CHAT_COMPLETIONS_URL="https://api.openai.com/v1/chat/completions"
export LLM_API_KEY="sk-proj-your-key-here"

# Create the Secret
kubectl create secret generic facis-ai-insight-llm-secret \
  --from-literal=llm_chat_completions_url="$LLM_CHAT_COMPLETIONS_URL" \
  --from-literal=llm_api_key="$LLM_API_KEY" \
  -n facis
```

**Validation:**

```bash
kubectl get secret facis-ai-insight-llm-secret -n facis
# Expected output:
# NAME                              TYPE     DATA   AGE
# facis-ai-insight-llm-secret       Opaque   2      5s
```

#### 3.1.2 Create the Trino CA Certificate Secret (if TLS enabled)

If Trino uses HTTPS (port 8443), you need the CA certificate:

```bash
# Save the PEM certificate to a file first
cat > /tmp/trino-ca.crt << 'EOF'
-----BEGIN CERTIFICATE-----
[YOUR_PEM_CERTIFICATE_CONTENT_HERE]
-----END CERTIFICATE-----
EOF

# Create the Secret
kubectl create secret generic facis-ai-insight-trino-ca \
  --from-file=ca.crt=/tmp/trino-ca.crt \
  -n facis

# Cleanup
rm /tmp/trino-ca.crt
```

**Validation:**

```bash
kubectl get secret facis-ai-insight-trino-ca -n facis
# Expected output:
# NAME                           TYPE     DATA   AGE
# facis-ai-insight-trino-ca      Opaque   1      5s
```

### 3.2 Helm Install Command

```bash
helm install facis-ai-insight \
  services/ai-insight-service/helm/facis-ai-insight/ \
  --namespace facis \
  --set llm.chatCompletionsUrl="$LLM_CHAT_COMPLETIONS_URL" \
  --set llm.apiKey="$LLM_API_KEY" \
  --set llm.model=meta-llama/Llama-3.3-70B-Instruct \
  --set trino.host=[TRINO_COORDINATOR_HOST] \
  --set trino.port=8443 \
  --set trino.httpScheme=https \
  --set trino.user=trino \
  --set trinoCA.create=true \
  --set rateLimit.enabled=true \
  --set rateLimit.requestsPerMinute=10 \
  --set policy.enabled=true \
  --set audit.enabled=true \
  --set replicaCount=1
```

**Example with real values:**

```bash
helm install facis-ai-insight \
  services/ai-insight-service/helm/facis-ai-insight/ \
  --namespace facis \
  --set llm.chatCompletionsUrl="https://openai.inference.de-txl.ionos.com/v1/chat/completions" \
  --set llm.apiKey="$IONOS_TOKEN" \
  --set llm.model=meta-llama/Llama-3.3-70B-Instruct \
  --set trino.host=trino-coordinator.stackable.svc.cluster.local \
  --set trino.port=8443 \
  --set trino.httpScheme=https \
  --set trino.user=trino \
  --set trinoCA.create=true \
  --set rateLimit.enabled=true \
  --set rateLimit.requestsPerMinute=10 \
  --set policy.enabled=true \
  --set audit.enabled=true \
  --set replicaCount=1
```

### 3.3 Validate Deployment

**Check pod status:**

```bash
kubectl get pods -n facis -l app.kubernetes.io/name=facis-ai-insight
# Expected output after ~30s:
# NAME                                      READY   STATUS    RESTARTS   AGE
# facis-ai-insight-xxxxxxxxxx-xxxxx         1/1     Running   0          15s
```

Wait for `STATUS=Running`. If stuck in `CrashLoopBackOff`, check logs:

```bash
kubectl logs -n facis -l app.kubernetes.io/name=facis-ai-insight --tail=50
```

### 3.4 Test Health Endpoint

```bash
# Terminal 1: Start port-forward
POD=$(kubectl get pods -n facis -l app.kubernetes.io/name=facis-ai-insight -o jsonpath="{.items[0].metadata.name}")
kubectl port-forward -n facis $POD 8080:8080

# Terminal 2: Test the endpoint
sleep 3 && curl -v http://localhost:8080/api/v1/health
```

**Expected response:**

```json
{
  "status": "ok",
  "service": "ai-insight-service"
}
```

### 3.5 Verify Configuration

Check ConfigMaps and Secrets:

```bash
kubectl get configmap -n facis | grep facis-ai-insight
kubectl get secret -n facis | grep facis-ai-insight

# View Trino connection settings in ConfigMap
kubectl get configmap facis-ai-insight-config -n facis -o jsonpath='{.data.cluster\.yaml}'
```

**Expected keys in output:**
- `trino.host: [TRINO_COORDINATOR_HOST]`
- `trino.port: 8443`
- `trino.http_scheme: https`
- `llm.model: meta-llama/Llama-3.3-70B-Instruct`
- `policy.enabled: true`
- `rate_limit.requests_per_minute: 10`

**Next:** Proceed to [Step 4: Deploy AI Insight UI](#step-4-deploy-ai-insight-ui)

---

## Step 4: Deploy AI Insight UI

The AI Insight UI is a Vue.js dashboard deployed as Node-RED flows and UIBUILDER static files inside the existing ORCE deployment. This step creates ConfigMaps and Secrets only — no Deployment is created.

### 4.1 Prerequisites for UI Deployment

**You must have ORCE already deployed in the `facis` namespace.** Verify:

```bash
kubectl get deployment orce -n facis
# Expected: ORCE deployment exists

kubectl get svc orce -n facis
# Expected: ORCE service exists
```

If ORCE is not deployed, work with your DevOps team to deploy it first using the Stackable ORCE Operator.

### 4.2 Helm Install Command

```bash
helm install facis-ai-insight-ui \
  services/ai-insight-ui/helm/facis-ai-insight-ui/ \
  --namespace facis \
  --set llmSecret.create=true \
  --set llmSecret.openaiApiKey="$LLM_API_KEY" \
  --set llmSecret.anthropicApiKey="" \
  --set llmSecret.customLlmKey="" \
  --set llm.openaiModel="gpt-4.1-mini" \
  --set aiInsight.serviceUrl="http://ai-insight-service:8080" \
  --set trino.host="trino-coordinator.stackable.svc.cluster.local" \
  --set trino.port=8080 \
  --set trino.catalog="iceberg" \
  --set trino.schema="facis" \
  --set orce.deploymentName="orce" \
  --set orce.serviceName="orce" \
  --set orce.port=1880
```

**Example with real values:**

```bash
helm install facis-ai-insight-ui \
  services/ai-insight-ui/helm/facis-ai-insight-ui/ \
  --namespace facis \
  --set llmSecret.create=true \
  --set llmSecret.openaiApiKey="sk-proj-your-key" \
  --set llm.openaiModel="gpt-4.1-mini" \
  --set aiInsight.serviceUrl="http://ai-insight-service:8080" \
  --set trino.host="trino-coordinator.stackable.svc.cluster.local" \
  --set trino.port=8080 \
  --set trino.catalog="iceberg" \
  --set trino.schema="facis" \
  --set orce.deploymentName="orce"
```

### 4.3 Validate ConfigMaps and Secrets

**Check that ConfigMaps exist:**

```bash
kubectl get configmap -n facis | grep ai-insight-ui
# Expected output includes:
# ai-insight-ui-files     (UIBUILDER static files)
# ai-insight-ui-flows     (Node-RED flows)
```

**Check that the LLM Secret was created:**

```bash
kubectl get secret -n facis | grep orce-llm-secrets
# Expected output:
# orce-llm-secrets        Opaque   3      10s
```

**Verify flows ConfigMap is not empty:**

```bash
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | head -c 100
# Expected: JSON array starts with '['
```

**Next:** Proceed to [Step 5: ORCE Integration](#step-5-orce-integration)

---

## Step 5: ORCE Integration

This step imports the AI Insight flows into ORCE and mounts the UI static files into the ORCE pod.

### 5.1 Import Flows into ORCE

There are two options. **Option A (via kubectl exec) is recommended** as it requires no additional network access.

#### Option A: Import via kubectl exec (Recommended)

```bash
# Get the ORCE pod name
ORCE_POD=$(kubectl get pods -n facis -l app=orce -o jsonpath='{.items[0].metadata.name}')

# Get the flows JSON from the ConfigMap and import into ORCE
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | \
  kubectl exec -i -n facis $ORCE_POD -- \
    curl -s -X POST http://localhost:1880/flows \
         -H 'Content-Type: application/json' \
         -H 'Node-RED-Deployment-Type: full' \
         -d @-

# Expected: HTTP 200 response (no error output)
```

**Validation:**

```bash
# Check ORCE logs for successful import
kubectl logs -n facis $ORCE_POD --tail=20 | grep -i "flows"
# Look for "flows deployed" or similar confirmation
```

#### Option B: Import via port-forward

If you need to debug the import, use this approach:

```bash
# Terminal 1: Start port-forward
kubectl port-forward -n facis svc/orce 1880:1880 &

# Terminal 2: Wait a moment and import flows
sleep 2
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | \
  curl -s -X POST http://localhost:1880/flows \
       -H 'Content-Type: application/json' \
       -H 'Node-RED-Deployment-Type: full' \
       -d @-

# Expected: HTTP 200 with empty response body

# Stop port-forward
kill %1
```

### 5.2 Mount UI Static Files into ORCE

Edit the ORCE Deployment to add the UI files ConfigMap as a mount:

```bash
kubectl edit deployment orce -n facis
```

Add the following to the `spec.template.spec.volumes` section:

```yaml
volumes:
  # ... existing volumes ...
  - name: ai-insight-ui-files
    configMap:
      name: ai-insight-ui-files
```

Add the following to the `spec.template.spec.containers[0].volumeMounts` section (inside the ORCE container):

```yaml
volumeMounts:
  # ... existing volume mounts ...
  - name: ai-insight-ui-files
    mountPath: /data/uibuilder/ai-insight/src
    readOnly: true
```

**Save the file** (exit editor with `:wq`).

**Validation:** ORCE pod will restart automatically

```bash
# Watch the pod restart
kubectl get pods -n facis -l app=orce -w
# Expected: Old pod terminates, new pod starts and reaches Running status
```

### 5.3 Inject Environment Variables into ORCE

The UI needs access to the LLM API key and AI Insight backend URL. Patch the ORCE Deployment with environment variables:

```bash
kubectl patch deployment orce -n facis \
  --type=json -p='[
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "AI_INSIGHT_BASE_URL",
        "value": "http://ai-insight-service:8080"
      }
    },
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "FACIS_OPENAI_API_KEY",
        "valueFrom": {
          "secretKeyRef": {
            "name": "orce-llm-secrets",
            "key": "openai-api-key"
          }
        }
      }
    },
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "FACIS_OPENAI_MODEL",
        "value": "gpt-4.1-mini"
      }
    },
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "FACIS_TRINO_HOST",
        "value": "trino-coordinator.stackable.svc.cluster.local"
      }
    },
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "FACIS_TRINO_PORT",
        "value": "8080"
      }
    },
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "FACIS_TRINO_CATALOG",
        "value": "iceberg"
      }
    },
    {
      "op": "add",
      "path": "/spec/template/spec/containers/0/env/-",
      "value": {
        "name": "FACIS_TRINO_SCHEMA",
        "value": "facis"
      }
    }
  ]'
```

**Validation:** ORCE pod restarts with new environment variables

```bash
# Check pod restarted
kubectl get pods -n facis -l app=orce
# Expected: Pod age shows recent restart

# Verify environment variables are set
kubectl get pod $(kubectl get pods -n facis -l app=orce -o jsonpath='{.items[0].metadata.name}') \
  -n facis -o jsonpath='{.spec.containers[0].env[*].name}' | grep -i "FACIS\|AI_INSIGHT"
# Expected: FACIS_* and AI_INSIGHT_BASE_URL present
```

### 5.4 Verify ORCE Integration

**Access ORCE editor:**

```bash
# Terminal 1: Port-forward to ORCE
kubectl port-forward -n facis svc/orce 1880:1880 &

# Terminal 2: Open browser to ORCE
sleep 2 && open http://localhost:1880/
# Or: echo "Open http://localhost:1880/ in your browser"
```

**In the ORCE editor:**
- Verify the flows are imported (check the left sidebar for imported nodes)
- Look for any red error indicators on nodes
- Check the debug console (right sidebar) for any error messages

**Next:** Proceed to [Step 6: End-to-End Verification](#step-6-end-to-end-verification)

---

## Step 6: End-to-End Verification

Validate that all three services are running and can communicate with each other.

### 6.1 Verify All Pods Are Running

```bash
kubectl get pods -n facis
```

**Expected output:**

```
NAME                                      READY   STATUS    RESTARTS   AGE
facis-simulation-xxxxxxxxxx-xxxxx         1/1     Running   0          3m
facis-ai-insight-xxxxxxxxxx-xxxxx         1/1     Running   0          2m
orce-xxxxxxxxxx-xxxxx                     1/1     Running   0          1m
```

All three should show `STATUS=Running` and `READY=1/1`.

### 6.2 Test Simulation Service

```bash
# Port-forward to simulation
POD=$(kubectl get pods -n facis -l app.kubernetes.io/name=facis-simulation -o jsonpath="{.items[0].metadata.name}")
kubectl port-forward -n facis $POD 8081:8080 &

sleep 2

# Test health endpoint
curl -s http://localhost:8081/api/v1/health | jq .

# Test status endpoint (includes simulation state)
curl -s http://localhost:8081/api/v1/status | jq .

# Clean up
kill %1
```

**Expected health response:**

```json
{
  "status": "healthy",
  "service": "facis-simulation-service",
  "version": "1.0.0"
}
```

### 6.3 Test AI Insight Service

```bash
# Port-forward to AI Insight
POD=$(kubectl get pods -n facis -l app.kubernetes.io/name=facis-ai-insight -o jsonpath="{.items[0].metadata.name}")
kubectl port-forward -n facis $POD 8082:8080 &

sleep 2

# Test health endpoint
curl -s http://localhost:8082/api/v1/health | jq .

# Test rate limit headers (if rate limiting is enabled)
curl -i -H "x-agreement-id: test-agreement" \
        -H "x-asset-id: test-asset" \
        http://localhost:8082/api/v1/health

# Clean up
kill %1
```

**Expected health response:**

```json
{
  "status": "ok",
  "service": "ai-insight-service"
}
```

### 6.4 Test Inter-Service Connectivity

Test that AI Insight can reach Trino (verify from inside the pod):

```bash
kubectl exec -it -n facis \
  $(kubectl get pods -n facis -l app.kubernetes.io/name=facis-ai-insight -o jsonpath="{.items[0].metadata.name}") \
  -- bash -c 'curl -v https://trino-coordinator.stackable.svc.cluster.local:8443'

# Expected: Connection attempt (may fail with certificate error, which is OK)
# The important part is that the hostname resolves and connects
```

### 6.5 Verify Simulation is Publishing to Kafka

Check that the simulation pod can connect to Kafka:

```bash
# Get simulation pod logs
kubectl logs -n facis $(kubectl get pods -n facis -l app.kubernetes.io/name=facis-simulation -o jsonpath="{.items[0].metadata.name}") --tail=30

# Look for messages like:
# - "Kafka client initialized"
# - "Publishing to topic: simulation_events"
# - No "Connection refused" or "Authentication failed" errors
```

### 6.6 Dashboard Access

Access the AI Insight dashboard inside ORCE:

```bash
# Port-forward to ORCE
kubectl port-forward -n facis svc/orce 1880:1880 &

sleep 2

# Open dashboard
open http://localhost:1880/ai-insight/
# Or: echo "Open http://localhost:1880/ai-insight/ in your browser"

# Check browser console for JavaScript errors
# Verify the dashboard loads and shows no red error messages
```

### 6.7 Full Deployment Checklist

- [ ] All 3 pods running: `kubectl get pods -n facis`
- [ ] Simulation health endpoint responds
- [ ] AI Insight health endpoint responds
- [ ] ORCE editor loads and shows imported flows
- [ ] ORCE dashboard loads at `/ai-insight/`
- [ ] Simulation logs show Kafka publishing
- [ ] No error messages in ORCE logs: `kubectl logs -n facis -l app=orce`

**Deployment complete!** All services are running and integrated.

---

## Upgrading

### Upgrading Simulation Service

```bash
# Get current version
helm list -n facis | grep facis-simulation

# Update to a new version (e.g., 1.0.1)
helm upgrade facis-simulation \
  services/simulation/helm/facis-simulation/ \
  --namespace facis \
  --set simulation.seed=12345 \
  --set simulation.speedFactor=1.0 \
  --set mqtt.host=[MQTT_BROKER_HOSTNAME] \
  --set kafka.bootstrapServers=[KAFKA_BOOTSTRAP_SERVERS]

# Wait for rollout to complete
kubectl rollout status deployment/facis-simulation -n facis

# Verify
kubectl get pods -n facis -l app.kubernetes.io/name=facis-simulation
```

### Upgrading AI Insight Service

```bash
# Update LLM credentials if needed
kubectl patch secret facis-ai-insight-llm-secret \
  --type merge \
  -p '{"stringData":{"llm_api_key":"new-key"}}' \
  -n facis

# Upgrade chart
helm upgrade facis-ai-insight \
  services/ai-insight-service/helm/facis-ai-insight/ \
  --namespace facis \
  --set llm.chatCompletionsUrl="https://api.openai.com/v1/chat/completions" \
  --set llm.apiKey="$LLM_API_KEY" \
  --set trino.host=[TRINO_COORDINATOR_HOST]

# Wait for rollout to complete
kubectl rollout status deployment/facis-ai-insight -n facis

# Verify
kubectl get pods -n facis -l app.kubernetes.io/name=facis-ai-insight
```

### Upgrading AI Insight UI

```bash
# Update LLM secret if needed
kubectl patch secret orce-llm-secrets \
  --type merge \
  -p '{"stringData":{"openai-api-key":"new-key"}}' \
  -n facis

# Upgrade chart (ConfigMaps only)
helm upgrade facis-ai-insight-ui \
  services/ai-insight-ui/helm/facis-ai-insight-ui/ \
  --namespace facis \
  --set llmSecret.openaiApiKey="$LLM_API_KEY"

# Re-import flows (if flows ConfigMap changed)
ORCE_POD=$(kubectl get pods -n facis -l app=orce -o jsonpath='{.items[0].metadata.name}')
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | \
  kubectl exec -i -n facis $ORCE_POD -- \
    curl -s -X POST http://localhost:1880/flows \
         -H 'Content-Type: application/json' \
         -H 'Node-RED-Deployment-Type: full' \
         -d @-

# ORCE pod will restart due to ConfigMap change
kubectl get pods -n facis -l app=orce -w
```

---

## Uninstalling

Remove all FACIS services in reverse order:

```bash
# Step 1: Uninstall UI
helm uninstall facis-ai-insight-ui -n facis

# Step 2: Uninstall AI Insight
helm uninstall facis-ai-insight -n facis

# Step 3: Uninstall Simulation
helm uninstall facis-simulation -n facis

# Step 4: Delete secrets
kubectl delete secret facis-ai-insight-llm-secret -n facis
kubectl delete secret facis-ai-insight-trino-ca -n facis
kubectl delete secret orce-llm-secrets -n facis

# Step 5: Delete namespace (optional)
kubectl delete namespace facis
```

**Validation:**

```bash
kubectl get all -n facis
# Expected: No FACIS resources remain (or namespace does not exist)
```

---

## Rollback

If an upgrade fails, rollback to the previous release:

```bash
# List release history
helm history facis-simulation -n facis
helm history facis-ai-insight -n facis
helm history facis-ai-insight-ui -n facis

# Rollback simulation to previous release
helm rollback facis-simulation -n facis

# Rollback AI Insight to specific revision (e.g., revision 1)
helm rollback facis-ai-insight 1 -n facis

# Wait for rollout to complete
kubectl rollout status deployment/facis-simulation -n facis
kubectl rollout status deployment/facis-ai-insight -n facis

# Verify pods are running
kubectl get pods -n facis
```

---

## Appendices

### Appendix A: Trino Port Reference

The AI Insight Service connects to Trino using the port specified in Helm values. Here are the common configurations:

| Configuration | Port | Usage | Notes |
|---|---|---|---|
| **Helm `trino.port`** | `8443` | External/cluster access | HTTPS by default, requires CA cert |
| **Service config** | `8443` | ConfigMap overlay | Matches Helm values |
| **Internal Trino default** | `8080` | In-cluster access (no TLS) | Only within cluster, unencrypted |
| **For Stackable Trino** | `8443` | External TLS endpoint | Use with CA certificate from secret |

**For local development (no TLS):**
```yaml
trino:
  host: trino
  port: 8080
  httpScheme: http
  verify: ""  # Skip TLS verification
```

**For production (TLS):**
```yaml
trino:
  host: trino-coordinator.stackable.svc.cluster.local
  port: 8443
  httpScheme: https
  verify: /app/certs/trino-ca.crt  # Path inside container
```

### Appendix B: Environment Variable Quick Reference

#### Simulation Service Env Vars (SIMULATOR_ prefix, __ nesting)

| Env Var | Default | Type | Notes |
|---|---|---|---|
| `SIMULATOR_SIMULATION__SEED` | `12345` | int | Reproducibility: same seed = same output |
| `SIMULATOR_SIMULATION__INTERVAL_MINUTES` | `1` | int | Minutes between telemetry readings |
| `SIMULATOR_SIMULATION__SPEED_FACTOR` | `1.0` | float | 1.0=real-time, 60.0=1 hour per minute |
| `SIMULATOR_SIMULATION__MODE` | `normal` | str | Options: `normal`, `event` (anomalies) |
| `SIMULATOR_MQTT__HOST` | `facis-mqtt` | str | MQTT broker hostname |
| `SIMULATOR_MQTT__PORT` | `1883` | int | MQTT broker port |
| `SIMULATOR_KAFKA__ENABLED` | `true` | bool | Enable Kafka publishing |
| `SIMULATOR_KAFKA__BOOTSTRAP_SERVERS` | `kafka:9092` | str | Comma-separated list |
| `SIMULATOR_KAFKA__SECURITY_PROTOCOL` | `PLAINTEXT` | str | Options: `PLAINTEXT`, `SSL` |
| `SIMULATOR_ORCE__ENABLED` | `false` | bool | Enable ORCE webhook |
| `SIMULATOR_ORCE__URL` | `http://facis-orce:1880` | str | ORCE base URL |
| `SIMULATOR_HTTP__PORT` | `8080` | int | HTTP API port |
| `SIMULATOR_LOGGING__LEVEL` | `INFO` | str | Options: `DEBUG`, `INFO`, `WARNING`, `ERROR` |

#### AI Insight Service Env Vars (AI_INSIGHT_ prefix, __ nesting)

| Env Var | Default | Type | Notes |
|---|---|---|---|
| `FACIS_ENV` | `cluster` | str | Environment marker; affects config loader |
| `AI_INSIGHT_HTTP__HOST` | `0.0.0.0` | str | HTTP bind address |
| `AI_INSIGHT_HTTP__PORT` | `8080` | int | HTTP listen port |
| `AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL` | — | str | **Required**; stored in Secret |
| `AI_INSIGHT_LLM__API_KEY` | — | str | **Required**; stored in Secret |
| `AI_INSIGHT_LLM__MODEL` | `meta-llama/Llama-3.3-70B-Instruct` | str | Model identifier sent to LLM |
| `AI_INSIGHT_LLM__TIMEOUT_SECONDS` | `30` | int | Request timeout |
| `AI_INSIGHT_LLM__REQUIRE_HTTPS` | `true` | bool | Enforce HTTPS on completions URL |
| `AI_INSIGHT_TRINO__HOST` | `trino` | str | Trino coordinator hostname |
| `AI_INSIGHT_TRINO__PORT` | `8443` | int | Trino port |
| `AI_INSIGHT_TRINO__HTTP_SCHEME` | `https` | str | Options: `http`, `https` |
| `AI_INSIGHT_TRINO__USER` | `trino` | str | Trino username |
| `AI_INSIGHT_TRINO__VERIFY` | `/app/certs/trino-ca.crt` | str | Path to CA cert (empty to skip) |
| `AI_INSIGHT_POLICY__ENABLED` | `true` | bool | Enable ABAC policy enforcement |
| `AI_INSIGHT_RATE_LIMIT__ENABLED` | `true` | bool | Enable per-client rate limiting |
| `AI_INSIGHT_RATE_LIMIT__REQUESTS_PER_MINUTE` | `10` | int | Max requests per minute |
| `AI_INSIGHT_AUDIT__ENABLED` | `true` | bool | Enable audit logging |
| `AI_INSIGHT_LOGGING__LEVEL` | `INFO` | str | Options: `DEBUG`, `INFO`, `WARNING`, `ERROR` |

**Accessing these in your code:**
```python
import os

# Example: read simulation seed
seed = int(os.getenv("SIMULATOR_SIMULATION__SEED", "12345"))

# Example: read LLM model
model = os.getenv("AI_INSIGHT_LLM__MODEL", "meta-llama/Llama-3.3-70B-Instruct")
```

### Appendix C: Troubleshooting Common Issues

#### Issue: ImagePullBackOff

**Symptom:** Pod stuck in `ImagePullBackOff` state

**Cause:** Kubernetes cannot pull the container image from GHCR

**Solution:**
```bash
# Check the error details
kubectl describe pod <pod-name> -n facis

# If private registry:
# Create image pull secret (see Step 1.2)
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=<username> \
  --docker-password=<token> \
  -n facis

# Add to Helm values and reinstall
helm upgrade <release> <chart> --namespace facis \
  --set imagePullSecrets[0].name=ghcr-secret
```

#### Issue: CrashLoopBackOff

**Symptom:** Pod crashes and restarts repeatedly

**Cause:** Application error, missing configuration, or invalid credentials

**Solution:**
```bash
# Check logs
kubectl logs -n facis <pod-name> --previous
kubectl logs -n facis <pod-name> --tail=100

# Common causes:
# 1. Missing LLM credentials (AI Insight)
# 2. Kafka broker unreachable (Simulation)
# 3. Trino CA certificate invalid (AI Insight)
# 4. Configuration error in values

# Verify secrets exist and are readable
kubectl get secret -n facis
kubectl get configmap -n facis

# Check ConfigMap content
kubectl get configmap facis-ai-insight-config -n facis -o jsonpath='{.data}' | jq .
```

#### Issue: Connection Refused to Kafka / MQTT

**Symptom:** Simulation logs show "Connection refused" errors

**Cause:** Kafka/MQTT hostname or port is incorrect, or broker is not running

**Solution:**
```bash
# Verify broker is reachable from inside the cluster
kubectl run -it --rm debug --image=busybox --restart=Never -- \
  nc -zv <broker-hostname> <port>

# Check Helm values match actual broker addresses
helm get values facis-simulation -n facis | grep -A5 mqtt
helm get values facis-simulation -n facis | grep -A5 kafka

# If incorrect, upgrade with correct values
helm upgrade facis-simulation services/simulation/helm/facis-simulation/ \
  --namespace facis \
  --set mqtt.host=<correct-broker> \
  --set kafka.bootstrapServers=<correct-servers>
```

#### Issue: Trino TLS Verification Failed

**Symptom:** AI Insight logs show "certificate verification failed"

**Cause:** Trino CA certificate is missing, invalid, or incorrect

**Solution:**
```bash
# Verify CA certificate Secret exists and is not empty
kubectl get secret facis-ai-insight-trino-ca -n facis -o jsonpath='{.data.ca\.crt}' | base64 -d | head -5

# If invalid, recreate the Secret:
kubectl delete secret facis-ai-insight-trino-ca -n facis

# Obtain the correct certificate and create secret
cat > /tmp/trino-ca.crt << 'EOF'
-----BEGIN CERTIFICATE-----
[CORRECT_CERTIFICATE_CONTENT]
-----END CERTIFICATE-----
EOF

kubectl create secret generic facis-ai-insight-trino-ca \
  --from-file=ca.crt=/tmp/trino-ca.crt \
  -n facis

# Restart AI Insight pod to pick up new certificate
kubectl rollout restart deployment/facis-ai-insight -n facis
```

#### Issue: AI Insight Returns 429 (Too Many Requests)

**Symptom:** Requests return HTTP 429 error

**Cause:** Rate limit exceeded (default: 10 requests/minute per client)

**Solution:**
```bash
# Check rate limit setting
helm get values facis-ai-insight -n facis | grep -A2 rateLimit

# Increase rate limit if needed
helm upgrade facis-ai-insight \
  services/ai-insight-service/helm/facis-ai-insight/ \
  --namespace facis \
  --set rateLimit.requestsPerMinute=60

# Or disable rate limiting (not recommended for production)
helm upgrade facis-ai-insight \
  services/ai-insight-service/helm/facis-ai-insight/ \
  --namespace facis \
  --set rateLimit.enabled=false
```

#### Issue: ORCE Flows Don't Import

**Symptom:** Flow import command returns error or flows don't appear in ORCE editor

**Cause:** ORCE admin API is unreachable, or flows JSON is invalid

**Solution:**
```bash
# Verify ORCE is running and responsive
kubectl get pod -n facis -l app=orce

# Check flows ConfigMap is not empty
kubectl get configmap ai-insight-ui-flows -n facis -o jsonpath='{.data.flows\.json}' | jq . | head -20

# Verify ORCE admin API is accessible
kubectl port-forward -n facis svc/orce 1880:1880 &
sleep 2
curl http://localhost:1880/flows
# Expected: Valid JSON array of flows
kill %1

# If flows ConfigMap is empty or placeholder, check chart values:
helm get values facis-ai-insight-ui -n facis | grep -A5 flows
```

#### Issue: Dashboard Loads but Shows Blank Page

**Symptom:** ORCE dashboard at `/ai-insight/` loads but shows no content

**Cause:** UI static files not mounted or JavaScript errors

**Solution:**
```bash
# Verify UI files are mounted in ORCE pod
kubectl get deployment orce -n facis -o jsonpath='{.spec.template.spec.volumes[*].name}'
# Expected: includes "ai-insight-ui-files"

# Check UI files ConfigMap is not empty
kubectl get configmap ai-insight-ui-files -n facis -o jsonpath='{.data.index\.html}' | head -20

# Check browser console for JavaScript errors (F12 → Console tab)
# Check ORCE logs for any error messages
kubectl logs -n facis -l app=orce --tail=50 | grep -i error

# Verify ORCE environment variables are set
kubectl get deployment orce -n facis -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' | grep -i FACIS
# Expected: FACIS_* and AI_INSIGHT_* variables present
```

### Appendix D: Health Check Commands

Quick reference for verifying each service:

```bash
# Simulation Service
POD=$(kubectl get pods -n facis -l app.kubernetes.io/name=facis-simulation -o jsonpath="{.items[0].metadata.name}")
kubectl port-forward -n facis $POD 8081:8080 &
sleep 2 && curl -s http://localhost:8081/api/v1/health | jq .
kill %1

# AI Insight Service
POD=$(kubectl get pods -n facis -l app.kubernetes.io/name=facis-ai-insight -o jsonpath="{.items[0].metadata.name}")
kubectl port-forward -n facis $POD 8082:8080 &
sleep 2 && curl -s http://localhost:8082/api/v1/health | jq .
kill %1

# ORCE Editor
kubectl port-forward -n facis svc/orce 1880:1880 &
sleep 2 && open http://localhost:1880/
# or: echo "Open http://localhost:1880/ in your browser"
kill %1

# ORCE Dashboard
kubectl port-forward -n facis svc/orce 1880:1880 &
sleep 2 && open http://localhost:1880/ai-insight/
kill %1
```

### Appendix E: Required Network Access Summary

For deployment to succeed, ensure these endpoints are accessible from cluster nodes:

| Endpoint | Port | Protocol | Required By | Notes |
|---|---|---|---|---|
| `ghcr.io` | 443 | HTTPS | kubelet | Pull container images |
| MQTT broker | 1883 | TCP | Simulation | Publish telemetry |
| Kafka brokers | 9092 | TCP | Simulation | Publish to topics |
| Trino coordinator | 8443 | HTTPS | AI Insight | Query data lake |
| OpenAI API | 443 | HTTPS | AI Insight | LLM completions |
| ORCE service | 1880 | HTTP | UI integration | Admin API for flow import |

---

## Document Version History

| Date | Version | Changes |
|---|---|---|
| 2026-02-06 | 1.0 | Initial comprehensive deployment walkthrough |

---

**Questions or issues?** Contact the FACIS platform team or refer to individual service documentation in `/services/*/docs/`.
