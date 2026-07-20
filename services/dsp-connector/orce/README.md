# DSP Connector — ORCE Native Runtime

This directory contains the ORCE Node-RED flows that implement the DSP
connector's control plane on the shared ORCE pod.

## Layout

```
orce/
  flows/
    facis-dsp-state.json        — bootstrap & persist transfers/negotiations
    facis-dsp-health.json       — GET /api/v1/dsp/health, GET /dsp/metrics
    facis-dsp-catalogue.json    — POST /dsp/catalogue/request
    facis-dsp-negotiations.json — POST/GET /dsp/negotiations, terminate
    facis-dsp-transfers.json    — full transfer FSM + access provisioning
    facis-dsp-errors.json       — catch-all error handler
    facis-dsp-iam-verify.json   — NF-1 shared VP/VC verifier (link-call)
    facis-dsp-iam-issuance.json — did.json, OID4VCI issuer, Participant VC self-issuance
    facis-dsp-iam-hub.json      — Identity Hub query API (Mongo-backed)
    facis-dsp-data.json         — GET /api/data/:assetId (NF-2 provider-side data serving)
    facis-dsp-consumer.json     — POST /dsp/ingest (NF-2 consumer-side Bronze ingest)
  config/
    datasets.json               — static FACIS_DATASETS mirror (mounted as ConfigMap)
  tests/
    flows/                      — node --test specs
    fixtures/iam/               — golden VP/VC keys + vectors
    harness/run-node.js         — real flow-execution test harness (see Tests below)
    e2e/                         — manual, live-cluster-only scripts (not run by `node --test`)
    package.json
  README.md (this file)
```

## State storage

The flow uses two PVC-backed JSON files under `/data/dsp-state/`:
- `transfers.json` — the transfer-process map keyed by `tp-...` id
- `negotiations.json` — the negotiation map keyed by `neg-...` id

The catalogue is a read-only ConfigMap mount at `/data/dsp-config/datasets.json`.

**Single-replica only**: the file-based state is not multi-replica safe.
The ORCE pod must run with `replicas: 1`. Postgres backing is out of scope
for this migration.

## Endpoint paths

To avoid colliding with the Simulation flow's `/api/v1/health` and `/metrics`
on the shared ORCE pod, DSP endpoints are namespaced:

| Concern | Path |
|---------|------|
| Health  | `GET /api/v1/dsp/health` |
| Metrics | `GET /dsp/metrics`       |
| Catalogue | `POST /dsp/catalogue/request` |
| Transfers | `POST/GET /dsp/transfers...`  |
| Negotiations | `POST/GET /dsp/negotiations...` |

## Tests

```sh
cd services/dsp-connector/orce
npm install --include=dev
node --test tests/flows
```

Most specs re-implement each function-node body inline and exercise it under
`node:test`. **Invariant**: keep the spec helpers in sync with the function-node
`func` strings in the corresponding flow JSON — this convention has a known
weakness (a real flow-JSON edit can drift from its hand-copied spec without
any test failing) documented in `tests/harness/run-node.js`'s header.

`tests/flows/iam-revocation-harness.spec.js` uses a different pattern:
`tests/harness/run-node.js` executes a `type:"function"` node's `func`
string read directly from the flow JSON at test-run time, in a `vm`
sandbox built to match Node-RED's real function-node sandbox (same
restricted globals, same `libs` resolution against real npm packages).
There is no hand-copied mirror to drift — the test always exercises
whatever is actually committed. Scope, honestly: it runs one function node
in isolation per call (fixture `msg` in, captured `node.send()`/return
value out); it does not boot a real Node-RED runtime or walk `http
in`/`link call`/wire chains automatically. New flow logic with meaningful
branching is a good candidate for this pattern instead of a new
hand-mirrored spec file; porting the existing hand-mirrored specs is a
separate, larger follow-up, not done as part of adding this.

## Deploy

The chart's `sync-flows.sh` copies these files into
`helm/facis-dsp-connector/files/orce-flows/` (and `orce-config/`) before
`helm install/upgrade`. The post-install Job fetches the ORCE pod's live
flow set, merges these tabs into it by node id, and POSTs the merged set
back to the ORCE Admin API at `${orceAdminUrl}/flows` with
`Node-RED-Deployment-Type: nodes` — never a full-replace, which would wipe
every other service's tabs on the shared pod.

See `helm/facis-dsp-connector/README.md` for the full deploy procedure and
the ORCE-chart prerequisites (envFrom secrets, volume mounts).

## NF-2: Data Lake HTTP Ingest

`facis-dsp-data.json` (provider) serves real Trino-backed data at
`GET /api/data/:assetId`, replacing the `ai-insight-service` Python stub at
the same literal path. That Python route
(`services/ai-insight-service/src/api/rest/routes/dsp.py`'s `data_router`)
is left in place but is dead code: the live Ingress never routed
`/api/data` to it (only to the ORCE `Service`), and the `dataApiBaseUrl`
default it depended on (`ai-insight.facis.cloud`) has no DNS record or
Ingress rule either. Deleting the Python route/HMAC modules is a separate,
explicitly out-of-scope cleanup — `hmac_signing.py`/`hmac_middleware.py`
are also used by the still-live `POST /api/v1/dsp/create-pull-url` route,
which this plan does not touch.

`facis-dsp-consumer.json` (consumer) drives an already-negotiated transfer,
follows its access object, and lands the result in `bronze.dsp_ingest` via
a new `dsp.ingest.raw` Kafka topic (see
`services/simulation/scripts/setup_lakehouse.py` /
`setup_nifi.py`'s `--add-bronze-table` / `--add-topic` flags). It does not
drive contract negotiation itself and does not attach a VP to its own
outbound calls to the provider — both are known, explicitly scoped-out
follow-ups (`DSP_IAM_ENFORCE=warn` in the live deployment does not require
one today).

**Topic creation assumption**: `--add-topic` only provisions the NiFi
consumer flow for `dsp.ingest.raw`; nothing in this plan creates the Kafka
topic itself. As with the existing `sftp.ingest.raw` topic (the sibling
`sftp-ingestion-service`'s Bronze topic, also never explicitly provisioned
anywhere in this repo), `dsp.ingest.raw` is expected to auto-create on
first produce — if the live broker has `auto.create.topics.enable`
disabled (the production recommendation per
`services/simulation/docs/deployment/infrastructure-prerequisites.md`
§3.2, which the 9 `sim.*` topics follow but `sftp.ingest.raw` does not),
pre-create it manually before running `--add-topic`.

`provisionHttpPull()`'s signed URLs include a literal `+` in `expiresAt`
(e.g. `...123000+00:00`), unescaped in the query string. Verified against
this stack's actual Express version (4.22.1, pinned via the `qs`
dependency also present in `services/simulation/orce/node_modules`, which
Node-RED's `http in` node's underlying Express app uses for `req.query` in
its default `extended` mode): an unescaped `+` **does** decode to a space
by the time `dsp-data-verify-fn` reads it off `msg.req.query.expiresAt`
(confirmed with a real `express()` app hitting `req.query`, not just
`qs.parse()` in isolation — same `application/x-www-form-urlencoded`
convention as Node's own `querystring`/`URLSearchParams`). `dsp-data-verify-fn`
now normalizes `expiresAt`/`from`/`to` back from space to `+` immediately
after reading `msg.req.query`, before HMAC reconstruction — see its
`unspacePlus()` helper. Remaining, narrower risk: a client that presents
the provider-issued pull URL to `GET /api/data/:assetId` via something
other than Node-RED/Express's own decoding (e.g. re-parses the URL through
a library that leaves a literal `+` alone, or double-decodes it) would
still see a signature mismatch — `tests/e2e/dsp-ingest-e2e.js` exercises
the real path end-to-end and will fail loudly (signature mismatch) if that
happens for the specific client/server pair it uses.

**Kafka broker config caveat**: the consumer flow's `rdkafka out` node
reuses `${SFTP_KAFKA_BROKERS}`, an env var rendered by the *sibling*
`sftp-ingestion-service` Helm chart's Secret, not by this chart's own
`orce-secret.yaml`. Whether that var is actually visible inside the
dsp-connector's flows at runtime depends on the shared `orce` chart's
Deployment `envFrom` list (tracked outside this repo, per the existing
comment convention in `orce-secret.yaml`). Step 3 of the checklist below
verifies it's present before the E2E script runs — if `SFTP_KAFKA_BROKERS`
is missing, add a `secretRef` for it to the `orce` Deployment's `envFrom`
list — otherwise the E2E script fails confusingly at the Kafka-produce step
with no obvious cause.

### Live deploy checklist (requires live cluster access — not automated)

```bash
export KUBECONFIG=k8s/K8s-cluster-IONOS-cloud.yaml

# 1. Provision Bronze + NiFi (additive, does not touch the 9 live sim flows)
cd services/simulation
python scripts/setup_lakehouse.py --env-file .env.cluster --add-bronze-table dsp.ingest.raw
python scripts/setup_nifi.py --env-file .env.cluster --add-topic dsp.ingest.raw

# 2. Apply the updated Ingress
kubectl apply -f infrastructure/ingress/facis-ingress.yaml

# 3. Verify SFTP_KAFKA_BROKERS / DSP_INGEST_TOPIC are visible to the ORCE pod
#    (see the caveat above — add the envFrom entry if missing before continuing)
kubectl exec -n orce deploy/orce -- env | grep -E 'SFTP_KAFKA_BROKERS|DSP_INGEST_TOPIC'

# 4. Upgrade the dsp-connector Helm release (deploys the two new flow tabs
#    via the existing atomic POST /flows merge-by-id job)
cd services/dsp-connector/helm/facis-dsp-connector
helm upgrade facis-dsp-connector . -n orce \
  --set dsp.trino.password=<the live trino-users password>

# 5. Run the live E2E script
cd ../../orce/tests
node e2e/dsp-ingest-e2e.js --env-file .env.cluster
```

## NF-3: Kafka Data-Plane Provisioning (FR-DP-002)

`facis-dsp-transfers.json`'s kafka-streaming path is real: `dsp-tx-create`
builds an honest access object (real stable bootstrap, sanitized single-`tp-`
topic name, `sasl: null`, an explicit `accessNote`) and routes to the new
`dsp-tx-kafka-admin` function node, which creates the topic via `node-rdkafka`'s
`AdminClient` over the connector's own mTLS certs (`/etc/kafka-certs/`) before
the 202 response is sent. `dsp-tx-terminate` deletes the topic (fire-and-forget
via the same node); `dsp-tx-suspend` deliberately does not — it is a reversible
pause. `node-rdkafka` is already on the pod as `node-red-contrib-rdkafka`'s
dependency (see `infrastructure/orce/init-deps-patch.yaml`); no init-deps change
is needed.

What's real: topic creation/deletion on the live broker, the bootstrap address,
the FSM hooks, the no-credential access object. Known limitations, stated
honestly:

- **No per-topic authorization.** The cluster has no ACL authorizer and is
  mTLS-only; any certificate the Stackable CA trusts can read any topic.
  Enabling SASL/SCRAM or ACLs is cluster-side infrastructure requiring
  client/PMO sign-off — a documented decision-gate item, not built here.
- **No credential delivery, by design.** Delivering this connector's own key
  would allow full impersonation across every topic it touches (including
  internal SFTP/DSP-consumer production traffic). Counterparty mTLS trust is
  arranged out-of-band with the data space operator.
- **Suspend is state-only** at the data plane (nothing to revoke in-band).
- **`expiresAt` is advisory** — no reaper deletes expired topics; terminate is
  the cleanup path.
- **A provisioning failure that occurs after the broker already committed the
  topic is recoverable** — the resulting `ERROR`-state transfer keeps its
  `access.topic`, and `ERROR`→`TERMINATED` is now a legal transition, so a
  `terminate` on it deletes the orphaned topic (previously this was a dead end:
  the topic existed on the broker with no recorded name and no cleanup path).
- **Kafka-streaming transfers stay `STARTED`** (never `COMPLETED`) so
  suspend/terminate remain reachable; `facis_dsp_transfer_completions_total`
  counts successful provisioning for this format.
- `dsp-tx-kafka-admin` itself is not unit-testable (native `node-rdkafka` +
  live broker); the pure logic around it is harness-tested
  (`kafka-access-harness.spec.js`, `kafka-terminate-harness.spec.js`) and the
  AdminClient behavior is verified by `tests/e2e/dsp-kafka-transfer-e2e.js`.

### Live verification (requires live cluster access — not automated)

```bash
export KUBECONFIG=k8s/K8s-cluster-IONOS-cloud.yaml

# 1. Deploy the updated flows + the fixed DSP_KAFKA_BOOTSTRAP default
cd services/dsp-connector/helm/facis-dsp-connector
helm upgrade facis-dsp-connector . -n orce \
  --set dsp.trino.password=<the live trino-users password>

# 2. Confirm the pod sees the new bootstrap and has node-rdkafka
kubectl exec -n orce deploy/orce -- env | grep DSP_KAFKA_BOOTSTRAP
kubectl exec -n orce deploy/orce -- ls /data/node_modules/node-rdkafka/lib/admin.js

# 3. Put the mTLS PEMs where the E2E script expects them (from
#    `Credentials and configs/credentials.txt`) and run it
mkdir -p /tmp/facis-kafka-certs   # ca.crt, tls.crt, tls.key
cd ../../orce/tests
node e2e/dsp-kafka-transfer-e2e.js --env-file .env.cluster
```
