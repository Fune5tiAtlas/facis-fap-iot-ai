# `infrastructure/` — Cluster-Scoped Patches and Operational Resources

This directory holds Kubernetes resources that don't fit cleanly inside a
single Helm chart — strategic-merge patches against the shared ORCE
deployment, the platform Ingress, the Prometheus alert rules, and the
operational CronJobs that monitor cross-cluster concerns (Stackable mTLS
cert expiry, broker NodePort drift).

These resources are applied **out of band** of `helm install`. A fresh
cluster needs them in addition to whatever the per-service charts deploy.

## Layout

```
infrastructure/
├── README.md                          (this file)
├── ingress/
│   └── facis-ingress.yaml             nginx Ingress: /orce, /ai, /dsp, /api/v1
├── monitoring/
│   ├── values-kube-prometheus.yaml    kube-prometheus-stack values
│   └── alerts/
│       └── facis-alerts.yaml          PrometheusRule (FACIS alerts)
└── orce/
    ├── init-deps-patch.yaml           initContainer: npm deps + rdkafka SSL
    ├── kafka-certs-patch.yaml         volume mount: /etc/kafka-certs
    ├── kafka-broker-watcher-cronjob.yaml   NodePort drift detection
    └── kafka-cert-expiry-cronjob.yaml      mTLS cert expiry monitoring
```

## When to put a resource here vs in a Helm chart

Use a Helm chart when the resource is owned by a single service and its
lifecycle is tied to a release. Use this directory when:

- The resource targets a *shared* runtime (e.g., the ORCE pod is referenced
  by simulation, DSP, and SFTP all at once).
- The resource is a *patch* on an existing third-party deployment we don't
  fully manage.
- The resource is a *cluster-wide* concern (Ingress, alerts, monitoring).
- Lifecycle is "apply once, then forget" — not tied to a service version.

## Quick start (fresh cluster)

These steps are the same on any IONOS cluster, in this order:

```bash
export KUBECONFIG=k8s/K8s-cluster-IONOS-cloud.yaml

# 1. Namespaces
kubectl create namespace orce      --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace facis     --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace ingress-nginx --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace monitoring    --dry-run=client -o yaml | kubectl apply -f -

# 2. ORCE-side prerequisite Secrets (out-of-band, never committed)
kubectl create secret generic facis-orce-admin -n orce \
  --from-literal=token="$(< /path/to/orce-admin-token.txt)"

kubectl create secret generic facis-kafka-certs -n orce \
  --from-file=ca.crt=/path/to/ca.crt \
  --from-file=tls.crt=/path/to/tls.crt \
  --from-file=tls.key=/path/to/tls.key

# 3. ConfigMaps consumed by the ORCE patches
kubectl create configmap facis-orce-rdkafka-patch -n orce \
  --from-file=rdkafka-patch.js=services/simulation/orce/rdkafka-patch.js

kubectl create configmap facis-watch-kafka-brokers-script -n orce \
  --from-file=discover.sh=services/simulation/orce/scripts/discover-kafka-brokers.sh \
  --from-file=watch.sh=services/simulation/orce/scripts/watch-kafka-brokers.sh

# 4. ORCE Deployment patches (idempotent)
kubectl patch deployment orce -n orce \
  --type=strategic --patch-file=infrastructure/orce/init-deps-patch.yaml
kubectl patch deployment orce -n orce \
  --type=strategic --patch-file=infrastructure/orce/kafka-certs-patch.yaml

# 5. CronJobs
kubectl apply -f infrastructure/orce/kafka-broker-watcher-cronjob.yaml
kubectl apply -f infrastructure/orce/kafka-cert-expiry-cronjob.yaml

# 6. Ingress (after nginx-ingress controller is installed)
kubectl apply -f infrastructure/ingress/facis-ingress.yaml

# 7. Monitoring (PrometheusRule — assumes kube-prometheus-stack is up)
kubectl apply -f infrastructure/monitoring/alerts/facis-alerts.yaml
```

## File-by-file walkthrough

### `orce/init-deps-patch.yaml`

Strategic-merge patch that adds an `init-deps` initContainer to the ORCE
Deployment. The container:

1. Detects which npm packages required by the FACIS flows
   (`node-red-contrib-modbus`, `node-red-contrib-rdkafka`,
   `ssh2-sftp-client`, `csv-parse`, `seedrandom`) are missing from the
   persistent `/data/node_modules` and installs them.
2. Detects whether `librdkafka.so.1` was built with OpenSSL — if not (the
   shipped image's stock contrib was built without it) — it `apk add
   openssl-dev build-base linux-headers zlib-dev`, removes
   `node-red-contrib-rdkafka` and `node-rdkafka`, and reinstalls. The
   build links cleanly against `libssl.so.3` / `libcrypto.so.3`. We
   intentionally do NOT install `cyrus-sasl-dev` — the runtime container
   has no `libsasl2` and the FACIS Kafka cluster uses mTLS only.
3. Overlays the FACIS `rdkafka-patch.js` (which adds `securityProtocol`,
   `ssl*Location`, and `metadata.max.age.ms` config support) over the
   stock `rdkafka.js`.

Inputs: `ConfigMap/facis-orce-rdkafka-patch` with key `rdkafka-patch.js`.

Idempotent: re-applying or restarting the pod is a no-op when packages
are already present, the librdkafka has SSL, and the patch is byte-equal.

### `orce/kafka-certs-patch.yaml`

Mounts `Secret/facis-kafka-certs` at `/etc/kafka-certs/` (read-only).
The path is referenced by the `kafka-broker` config node in
`services/simulation/orce/flows/facis-simulation-kafka.json` for
`sslCaLocation`, `sslCertLocation`, `sslKeyLocation`.

Note: Stackable's secret-operator issues short-lived client certs (~3
months in the current case). When `tls.crt` approaches expiry, both the
`Credentials and configs/credentials.txt` source AND the Secret here need
refreshing. See `services/simulation/docs/orce-runtime/operations-runbook.md`
for the rotation procedure.

### `orce/kafka-broker-watcher-cronjob.yaml`

Defence-in-depth against Stackable broker NodePort drift. Runs every
15 minutes, uses `kcat -L` against the stable bootstrap to discover
current broker addresses, and patches just the `kafka-broker-config`
node's `broker` field (never a full-flow replace — see the "Adding or
replacing flow tabs" section below for why that distinction matters) if
drift is stable across two consecutive cycles. The primary recovery is
client-side (rdkafka's `metadata.max.age.ms=30000`); this cron handles the
rare cases where the broker list is so stale that even bootstrap-driven
metadata can't recover.

**Two containers, not one** — no single small image conveniently bundles
`kcat` with a real HTTP client; `edenhill/kcat:1.7.1` has neither `curl`,
a POST-capable `wget`, nor `python3`:
- `discover` (init container, `edenhill/kcat`, pinned by digest): runs
  `kcat -L`, writes the result to a shared `emptyDir`.
- `watcher` (main container, `badouralix/curl-jq`, pinned by digest — the
  same image already used by the dsp-connector chart's
  `orce-flow-deploy-job` for the same reason): reads the discovery output
  and does all ORCE Admin API + JSON work with `curl`/`jq`.

Inputs: `Secret/facis-kafka-certs`, `Secret/facis-orce-admin`, and
`ConfigMap/facis-watch-kafka-brokers-script` with TWO keys —
`discover.sh` (from `services/simulation/orce/scripts/discover-kafka-brokers.sh`)
and `watch.sh` (from `services/simulation/orce/scripts/watch-kafka-brokers.sh`).

### `orce/kafka-cert-expiry-cronjob.yaml`

Daily cron that reads `/etc/kafka-certs/tls.crt`, computes
days-until-expiry, and pushes `facis_kafka_cert_days_until_expiry` to the
in-cluster Prometheus pushgateway. Always emits a structured-JSON log
line. Alert rules in `monitoring/alerts/facis-alerts.yaml` fire at 14d
(warning) and 7d (critical).

### `ingress/facis-ingress.yaml`

Single nginx Ingress on host `fap-iotai.facis.cloud` exposing `/orce`,
`/ai`, `/dsp`, and `/api/v1` (the simulation REST snapshot API). TLS via
`facis-wild` Secret (managed by the FACIS team — see
`services/simulation/docs/orce-runtime/operations-runbook.md`).

### `monitoring/`

`values-kube-prometheus.yaml` — values for the `kube-prometheus-stack`
chart deployment. `alerts/facis-alerts.yaml` — `PrometheusRule` resource
with all FACIS alerts including the cert-expiry alerts wired to the
cron's pushed metric.

## Conventions

- **Inline documentation in YAML headers.** Every file in this directory
  starts with a `# ===` banner explaining what the file does, what
  inputs it expects, and how to apply / roll back. We don't have a wiki;
  the file is the doc.
- **Idempotent apply.** Re-applying any file in this directory must be
  safe. If it isn't, fix the file. Patches must check before mutating
  (e.g., the init-deps script greps before installing).
- **No secrets in source.** TLS certs, bearer tokens, and admin keys are
  always created out-of-band via `kubectl create secret`. The YAML files
  here only reference secrets by name.
- **Roll-forward-only.** When something needs changing, edit the source
  file and re-apply. Don't `kubectl edit` against a live cluster.

## Adding or replacing flow tabs without a clean redeploy

**Use `Node-RED-Deployment-Type: nodes`, never `full`.** `full` replaces
the ENTIRE flow set on this shared pod with exactly what's in the POST
body, so any bug in the client-side merge logic (dropping a node by
mistake, a stale snapshot, a race with someone else's concurrent deploy)
silently wipes every other service's tabs in one shot. `nodes` mode merges
by node id **server-side** — you still POST a complete, correctly-merged
set (Node-RED doesn't accept a partial diff), but a client-side mistake
here is contained to whatever ids you actually got wrong, not "everything."

```bash
TOKEN=$(kubectl get secret facis-orce-admin -n orce -o jsonpath='{.data.token}' | base64 -d)
URL=https://fap-iotai.facis.cloud/orce

# 1. Snapshot current flows
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/flows" > /tmp/orce-current.json

# 2. Replace specific tabs (preserve the rest)
python3 - <<'PY'
import json
current = json.load(open('/tmp/orce-current.json'))
new_tabs_files = {
    'tab-feeds':         'services/simulation/orce/flows/facis-simulation-feeds.json',
    'tab-kafka-adapter': 'services/simulation/orce/flows/facis-simulation-kafka.json',
}
new_blobs = {tid: json.load(open(p)) for tid, p in new_tabs_files.items()}
drop = set(new_tabs_files)
kept = [n for n in current if n.get('id') not in drop and n.get('z') not in drop]
merged = kept[:]
for blob in new_blobs.values(): merged += blob
json.dump(merged, open('/tmp/orce-merged.json','w'))
PY

# 3. POST the merge — `nodes`, not `full`
curl -sS -X POST "$URL/flows" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Node-RED-Deployment-Type: nodes" \
  --data @/tmp/orce-merged.json
```

This is the merge pattern the watcher cron and the dsp-connector chart's
own flow-deploy Job both use, and what we recommend for ad-hoc updates
that don't warrant a full helm upgrade.

**A single node-id patch (e.g. fixing one config node's field) doesn't
need step 2's full tab-replace logic at all** — just mutate the one node
in place in the snapshot from step 1 and POST that same snapshot back
with `nodes` mode. `jq` makes this a one-liner if it's on your PATH (the
`badouralix/curl-jq` image always has it); if not, sed works too as long
as the target id string is unique in the file and the JSON has no nested
`{`/`}` inside the node object you're patching:
```bash
jq --arg id "some-node-id" --arg val "new-value" \
   'map(if .id == $id then .someField = $val else . end)' \
   /tmp/orce-current.json > /tmp/orce-merged.json
```

## Known gotchas

**There is no tracked Helm release for `dsp-connector`.** `helm list -n
orce` returns nothing for it — the `Secret`/Mongo `StatefulSet`/etc. that
exist were applied some other way (`helm template | kubectl apply`, or
direct `kubectl cp` merges like the pattern above), not `helm install`.
Before assuming `helm upgrade facis-dsp-connector .` will work, check
`helm list -n orce` first — it currently won't, and needs `helm install`
or continuing the ad-hoc `kubectl apply`/flow-merge approach instead.

**`${VAR}`-style placeholders in flow-JSON config-node fields (e.g.
`mongodb4-client`'s `uri: "${DSP_MONGO_URI}"`) are only ever substituted
by Helm's ConfigMap templating (`orce-flows-configmap.yaml`) — never at
Node-RED runtime.** Function nodes read env vars live via `env.get(...)`;
plain config-node fields don't have that mechanism and just carry the
literal string through if the deploy path bypasses Helm's ConfigMap
render step (as every `kubectl cp`-based ad-hoc deploy in this doc does).
Check for this class of drift (`grep '"\${[A-Z_]*}"'` across a live flow
dump) after any ad-hoc deploy of a flow that has one of these fields.

**Ingress changes are a separate Kubernetes resource from flow deploys.**
Applying updated flow JSON (however you do it) does not apply
`infrastructure/ingress/facis-ingress.yaml` — a route added there needs
its own `kubectl apply -f infrastructure/ingress/facis-ingress.yaml`, or
the flow behind the new path is unreachable (404 from nginx, not from
Node-RED) with no obvious signal pointing at the missing Ingress rule.

**Landing Kafka data into Trino/Iceberg via NiFi must use `PutSQL` (JDBC),
never a single-shot `InvokeHTTP` POST to `/v1/statement`.** Trino's
statement REST API is asynchronous — one POST only *queues* the query; a
client must follow the response's `nextUri` chain to actually drive it to
completion. `InvokeHTTP` configured for a single POST with all
relationships auto-terminated (the pattern
`infrastructure/lakehouse/setup_nifi.py`'s `create_ingestion_flow()`
currently builds) queues every
statement and then silently drops it — flowfiles flow through cleanly
(`in == out` at every hop, zero errors) while nothing ever actually lands
in the table, with no bulletin and no error — just zero rows. The working
pattern for all 9 pre-existing sim topics uses a `PutSQL` processor
against a shared `DBCPConnectionPool` controller service instead.
`create_ingestion_flow()` should be updated to build `PutSQL` to match;
until then, any `--add-topic` run needs its processor manually swapped
the same way (stop both ends of the connection, delete it and the
`InvokeHTTP` processor, create a `PutSQL` processor pointed at the same
JDBC pool with `database-session-autocommit: true`, reconnect, restart).

**Trino has two different passwords for two different purposes — do not
conflate them.** The Python provisioning scripts (`setup_lakehouse.py`,
`setup_nifi.py`) authenticate via Keycloak OIDC (`FACIS_OIDC_USERNAME`
etc.). `dsp-tx-trino-fn` and NiFi's `PutSQL`/`InvokeHTTP` processors
authenticate via HTTP Basic auth against a *different* credential pair
stored in `Secret/trino-users` on the Stackable cluster (user `admin`) —
check that secret directly rather than assuming a password from another
credential store, which may be carrying the OIDC password instead and
will fail Basic auth in ways that differ by endpoint.

**Docker Hub tags aren't immutable — pin unattended jobs by digest.**
`edenhill/kcat:1.7.1` silently lost `curl`/`python3` upstream at some
point after this cluster's node cached an older pull of that same tag; a
fresh pull got different content for the identical tag. Any image used by
a CronJob or Job that isn't re-validated on every run should be pinned by
digest (`image@sha256:...`), matching the existing convention in
`services/dsp-connector/helm/.../values.yaml`'s `jobImage`.

**A pod restart is needed after any Secret content change that backs an
already-established connection** (Kafka mTLS cert, `DSP_KAFKA_BOOTSTRAP`,
etc.) — Kubernetes updates the mounted file on disk within ~60-90s
automatically, but an already-running rdkafka producer/consumer (or any
client that reads config once at startup) keeps using whatever it loaded
at connection time and won't pick up the new file without reconnecting.

## Roll-forward / roll-back of patches

Each patch file documents `kubectl patch ... --type=json -p='[{"op":"remove",...}]'`
inline. The Deployment patches are safe to remove on a running cluster —
ORCE will continue running with whatever's currently in the PVC. Only
the rdkafka SSL patch and library rebuild are stateful; reverting the
init-deps patch leaves them in place until the PVC is reseeded.
