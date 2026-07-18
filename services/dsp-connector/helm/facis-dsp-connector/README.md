# facis-dsp-connector Helm chart

Eclipse Dataspace Protocol connector for the FACIS FAP IoT & AI platform.

## What this chart renders

The DSP control plane is owned by the ORCE pod via Node-RED flows under
`services/dsp-connector/orce/flows/`.

- `ConfigMap/<fullname>-orce-flows` — bundles the flow JSON files from
  `files/orce-flows/`. Source of truth: `services/dsp-connector/orce/flows/`.
  Run `./sync-flows.sh` from this directory before `helm install/upgrade`.
- `ConfigMap/<fullname>-orce-datasets` — wraps `files/orce-config/datasets.json`
  for the ORCE pod to mount at `/data/dsp-config/datasets.json` (read-only
  catalogue source).
- `Secret/<fullname>-dsp-secrets` — DSP_HMAC_SECRET, DSP_DATA_API_BASE_URL,
  DSP_DEFAULT_TTL_SECONDS, DSP_KAFKA_BOOTSTRAP, plus the NF-1 identity
  values under `dsp.iam.*`. Consumed by the ORCE pod via `envFrom`.
- `PersistentVolumeClaim/facis-dsp-state` — backs `/data/dsp-state/` on the
  ORCE pod for `transfers.json` + `negotiations.json`.
- `StatefulSet/<fullname>-mongo` + `Service/<fullname>-mongo` — self-contained
  MongoDB instance backing the Identity Hub (`credentials` collection of
  issued/self-issued VCs, see `facis-dsp-iam-hub.json`). Unlike the
  prerequisites below, this is entirely within this chart — no cross-chart
  wiring needed. Disable with `dsp.iam.mongo.enabled=false`.
- `Job/<fullname>-orce-flow-deploy` — post-install/upgrade hook. Fetches the
  ORCE pod's live flow set, merges this chart's tabs into it by node id
  (never a full-replace — see the Job script's own comments), and POSTs the
  merged set back with `Node-RED-Deployment-Type: nodes`.

## ORCE chart prerequisites (cross-chart, deploy-time)

The ORCE Helm chart (separate repo) must be configured to:

1. Reference the secrets and config rendered by this chart:
   ```yaml
   # In the ORCE chart values
   extraEnvFrom:
     - secretRef:
         name: facis-dsp-connector-dsp-secrets
   ```

2. Mount the state PVC and datasets ConfigMap:
   ```yaml
   extraVolumes:
     - name: dsp-state
       persistentVolumeClaim:
         claimName: facis-dsp-state
     - name: dsp-datasets
       configMap:
         name: facis-dsp-connector-orce-datasets
   extraVolumeMounts:
     - name: dsp-state
       mountPath: /data/dsp-state
     - name: dsp-datasets
       mountPath: /data/dsp-config
       readOnly: true
   ```

3. Reference the pre-created private-key Secret as `DSP_CONNECTOR_KEY` — this
   connector's own signing key for did:web + Participant VC self-issuance
   (see `services/dsp-connector/orce/flows/facis-dsp-iam-issuance.json`).
   The Secret's data key is `privateJwk`, not `DSP_CONNECTOR_KEY`, so this
   needs a single renamed env var rather than a bulk `extraEnvFrom` — the
   same shape this chart's own `orce-flow-deploy-job.yaml` already uses to
   rename its `token` key to `ORCE_ADMIN_TOKEN`:
   ```yaml
   # In the ORCE chart values
   extraEnv:
     - name: DSP_CONNECTOR_KEY
       valueFrom:
         secretKeyRef:
           name: facis-dsp-connector-identity-key   # matches dsp.iam.keySecret
           key: privateJwk
   ```

   Like `facis-orce-admin` (see "ORCE Admin API token" below), this Secret
   is deliberately **not** rendered by this chart — pre-create it before
   `helm install`:
   ```sh
   kubectl create secret generic facis-dsp-connector-identity-key \
     --namespace facis \
     --from-literal=privateJwk='{"kty":"EC","crv":"P-256","d":"...","x":"...","y":"...","alg":"ES256"}'
   ```

4. Stay at `replicas: 1`. The state files are NOT multi-replica safe.

## Deploy order

```sh
# 1. Sync flows + datasets into the chart's files/ directory
cd services/dsp-connector/helm/facis-dsp-connector
./sync-flows.sh

# 2. Install/upgrade this chart — renders Secret, ConfigMaps, PVC.
#    Hook Job is queued but won't run until pod sees mounts (see step 3).
helm upgrade --install facis-dsp-connector . \
  --namespace facis \
  --set dsp.hmacSecret=$(openssl rand -hex 32)

# 3. Upgrade the ORCE chart with the envFrom + volume references above.
#    The ORCE pod restarts and picks up DSP_HMAC_SECRET + /data mounts.
helm upgrade orce <orce-chart-path> --reuse-values \
  -f orce-extra-dsp-values.yaml

# 4. Helm post-install Job pushes flows to the ORCE Admin API.
#    Watch with: kubectl logs -n facis job/<release>-facis-dsp-connector-orce-flow-deploy
```

## ORCE Admin API token

The post-install Job needs a Bearer token in the Secret `facis-orce-admin`
(key `token`). Create once:

```sh
kubectl create secret generic facis-orce-admin \
  --namespace facis \
  --from-literal=token="<token issued by ORCE Admin API>"
```

## Endpoint paths

| Concern | Path |
|---------|------|
| Health  | `GET /api/v1/dsp/health` |
| Metrics | `GET /dsp/metrics` |
| Catalogue | `POST /dsp/catalogue/request` |
| Negotiations | `POST/GET /dsp/negotiations...` |
| Transfers | `POST/GET /dsp/transfers...` |

Namespaced under `/dsp` (rather than the bare `/api/v1/health` and
`/metrics` a standalone service would use) because the shared ORCE pod also
serves those bare paths for the Simulation flow — namespacing prevents route
collision.
