# Deviation Register — FACIS IoT & AI

This register is the single authoritative record of accepted and pending
deviations of this implementation from the SRS/TDR. Each deviation is recorded
as one entry that states the governing requirement, how the implementation
realizes it, the justification for the divergence, the residual risk together
with its mitigation, and the current approval status. An entry is added here
whenever a realized component fulfills a requirement through a different shape
than the one the requirement's wording implies, so that the divergence is
reviewable in one place rather than being rediscovered from the code.

## Contents

- [D-1 — Data Sink realized as a composite tier (NF-4 / Q-03)](#d-1--data-sink-realized-as-a-composite-tier-nf-4--q-03)
- [D-2 — Single-replica ORCE runtime for DSP connector state (NF-5)](#d-2--single-replica-orce-runtime-for-dsp-connector-state-nf-5)
- [D-3 — Encryption at rest without an external KMS (NF-8)](#d-3--encryption-at-rest-without-an-external-kms-nf-8)
- [D-4 — Kafka-streaming transfers without in-band credentials or per-agreement ACLs (NF-3 / FR-DP-002 / Q-15)](#d-4--kafka-streaming-transfers-without-in-band-credentials-or-per-agreement-acls-nf-3--fr-dp-002--q-15)
- [D-5 — DSP TCK conformance scope: asynchronous state machine and consumer-role tests (NF-7)](#d-5--dsp-tck-conformance-scope-asynchronous-state-machine-and-consumer-role-tests-nf-7)
- [D-6 — Shared ORCE runtime updates via Recreate, not zero-downtime rolling (NF-10 / test 25)](#d-6--shared-orce-runtime-updates-via-recreate-not-zero-downtime-rolling-nf-10--test-25)
- [D-7 — FR-AI-001 AI-retrieval p95 threshold below the Trino-Iceberg query floor (NF-9)](#d-7--fr-ai-001-ai-retrieval-p95-threshold-below-the-trino-iceberg-query-floor-nf-9)
- [Resolved — no deviation required](#resolved--no-deviation-required)

## D-1 — Data Sink realized as a composite tier (NF-4 / Q-03)

**Requirement**: The SRS "Data Sink and Catalogue" requirement calls for a Data
Sink component positioned near the data sources that collects, normalizes,
buffers, and provides queryable access to provider data, and for the Provider
connector's catalogue to be derived from that Data Sink.

**Implementation**: The Data Sink is realized as the named composite tier
**FACIS Data Sink** — defined in
[`architecture/fap-role-mapping.md`](architecture/fap-role-mapping.md) as ORCE
ingest/validation flows, Kafka topics, NiFi ingestion, and the Trino Bronze
layer — rather than as a single standalone deployable. The Provider connector's
catalogue is derived from that composite: per the role-mapping document, the
catalogue flow is the component responsible for deriving the connector
catalogue from the Data Sink's Trino table metadata, surfaced as
`facis-dsp-catalogue.json`. Provider and consumer connector roles are both
demonstrated within one participant deployment, the DSP connector service.

**Justification**: The TDR mandates the ORCE runtime for service execution, so a
free-standing sink daemon of the SRS's implied shape is not an available
building block. The medallion lakehouse subsumes the sink's collection,
normalization, buffering, and query functions with stronger durability
guarantees than a purpose-built sink would provide. The deployment scope is a
single-participant demonstrator, for which one composite tier serving both
connector roles is sufficient.

**Residual risk & mitigation**: Realizing the sink and both connector roles as a
composite raises the risk of coupling between concerns that the SRS keeps
separate. This is mitigated by keeping the parts isolated: separate services,
separate Helm charts, and separate ORCE flow tabs; namespaced HTTP endpoints so
routes do not collide; merge-by-id deployments so deploying one flow set does
not wipe another's; and IAM gating on the DSP protocol routes. The DSP connector
additionally runs on a dedicated ORCE runtime — the deployment mode selected
through the `facis-dsp-connector` chart's `dedicatedOrce` values block, per the
role-mapping document — so its execution is isolated from the shared runtime.

**Approval status**: `Pending — submitted via RFC Q-03`.

## D-2 — Single-replica ORCE runtime for DSP connector state (NF-5)

**Requirement**: The SRS requires the connector's transfer and negotiation state
to persist reliably across the runtime lifecycle (§6.1, state persistence), and
the non-functional expectations for a service tier imply the ability to scale
horizontally.

**Implementation**: DSP transfer and negotiation state is persisted in
**PostgreSQL** per SRS §6.1 — a dedicated Postgres StatefulSet rendered by the
`facis-dsp-connector` chart and addressed through `DSP_PG_URI`; the
`facis-dsp-state` flow bootstraps the schema (`dsp_transfers` / `dsp_negotiations`,
`doc JSONB`), performs a one-time migration of any legacy file-backed rows, and
writes each change back transactionally (see
[`services/dsp-connector/orce/README.md`](../services/dsp-connector/orce/README.md)
§State storage). The ORCE (Node-RED) runtime that hosts the flow nevertheless
runs at `replicas: 1`: between writes the authoritative copy of each state map
is Node-RED global context held in a single pod, so the running tier is not
horizontally scaled.

**Justification**: The concern this entry originally registered — file-based
state on a pod-local PVC, lost on reschedule — is resolved: durability is now
Postgres-backed. What remains registered is the single-replica runtime.
Node-RED holds working state in per-process memory and has no built-in
cross-instance coordination, so running multiple replicas against one database
would require sharing or externalizing that context. The deployment scope is a
single-participant demonstrator, for which one replica against a durable store
satisfies the state-persistence requirement.

**Residual risk & mitigation**: A single ORCE replica is a single point of
failure for request handling — though no longer for the state itself, which
outlives the pod. This is mitigated by Kubernetes rescheduling the pod on
failure; the Deployment's `Recreate` strategy over an RWO claim preventing
concurrent writers; and boot-time restore from Postgres, with a rate-limited
retry that rehydrates the in-memory maps on every start (covering the database
still starting when the pod boots). Scaling the runtime out is a defined
follow-up — share the global-context maps across instances — not a
re-architecture of the store.

**Approval status**: `Pending — demonstrator scope`.

## D-3 — Encryption at rest without an external KMS (NF-8)

**Requirement**: Encryption of lakehouse data at rest, with the review calling
for the encryption keys to be managed by an external / customer-managed Key
Management Service (KMS) rather than by the storage provider.

**Implementation**: The lakehouse bucket (`fap-iotai-stackable` on IONOS Object
Storage) has default server-side encryption enabled — **SSE-S3, AES-256**, with
keys managed by IONOS (see
[`infrastructure/s3/README.md`](../infrastructure/s3/README.md)). Every object
written after enablement is encrypted at rest. Key management is **not** placed
under an external KMS.

**Justification**: An external-KMS-managed model is not implementable on this
object store, confirmed both by live test and by provider documentation. IONOS
Object Storage offers no KMS and does not implement SSE-KMS — an explicit
`aws:kms` write is rejected by the endpoint, and its only server-side algorithm
is AES-256 (SSE-S3 or customer-provided SSE-C). Trino's Iceberg S3 filesystem —
through which all lakehouse writes pass — supports a KMS mode only against AWS
KMS, with no non-AWS KMS endpoint, so the client side has nothing to point at
either. The remaining customer-key mechanism, SSE-C with a static key, is not a
KMS (no per-object data keys, no rotation without rewriting every object) and
would require a full table-rewrite migration with permanent data loss on key
loss; it was evaluated and not adopted for a regenerable demonstrator dataset.
A true external KMS would require moving the lakehouse to an object store that
provides one (for example AWS S3 with KMS, or a self-run Ceph RadosGW wired to
HashiCorp Vault), which is out of scope for this demonstrator.

**Residual risk & mitigation**: Keys are provider-managed, so key custody and
rotation are IONOS's rather than the operator's — the deployment cannot perform
independent crypto-shredding by destroying a customer key. Data at rest is
nonetheless encrypted (AES-256), transport is TLS-protected (TLS 1.3 minimum at
the ingress; mTLS to Kafka; TLS to Trino/S3), and the lakehouse data is
regenerable from its sources, bounding the impact of the provider-managed key
model. Adopting an external KMS is a defined follow-up gated on an object-store
change, not a configuration adjustment on the current stack.

**Approval status**: `Pending — RFC to client/PMO (object-store KMS capability)`.

## D-4 — Kafka-streaming transfers without in-band credentials or per-agreement ACLs (NF-3 / FR-DP-002 / Q-15)

**Requirement**: FR-DP-002 calls for the Kafka data plane to provision a
per-agreement topic together with a scoped credential (for example a
SCRAM-SHA-256 user) and an ACL restricting that credential to only its topic,
so that a counterparty receives working connection credentials from the
transfer's access object.

**Implementation**: A kafka-streaming transfer creates a **real, per-transfer
Kafka topic** on the broker via the connector's mTLS AdminClient
(`facis-dsp-transfers.json`, node `dsp-tx-kafka-admin`) at transfer start, and
deletes it on terminate; suspend keeps it (reversible). The transfer's access
object carries the real bootstrap and topic but **no credentials** — `sasl`,
`token`, and `url` are explicitly `null`, with an `accessNote` stating that
mTLS trust to the topic is arranged out-of-band with the data space operator
and that the API does not deliver connection credentials. No SCRAM user and no
ACL are created.

**Justification**: The FACIS Kafka cluster is **mTLS-only by deliberate,
incident-informed decision** — SASL support is actively stripped from the
build toolchain after a past outage caused by SASL being linked in — so
SCRAM users and SASL ACLs are not buildable on this broker. Issuing a shared
credential in the access object would be dishonest (it would hand out the
connector's own identity) and was rejected in favour of an honest,
credential-free access object plus a real topic. Fabricating a credential, the
original state this finding recorded, is removed entirely.

**Residual risk & mitigation**: A counterparty cannot connect from the access
object alone; topic access requires an mTLS client certificate trusted by the
cluster, arranged out-of-band. This is mitigated by the access object stating
the requirement plainly rather than implying working credentials, and by the
end-to-end test asserting the access object is credential-free. Closing the
credential-delivery half requires a client/PMO decision among three options —
enable SASL + an authorizer cluster-side, gain cert-issuance access for
per-agreement mTLS certs, or accept a documented out-of-band mTLS trust model —
which is a cluster-infrastructure decision gate, not connector code.

**Approval status**: `Pending — RFC to client/PMO (Kafka credential-delivery model)`.

## D-5 — DSP TCK conformance scope: asynchronous state machine and consumer-role tests (NF-7)

**Requirement**: The Eclipse DSP TCK transfer suite (`dsp-tp`), run to 100%,
which exercises the full asynchronous DSP transfer-process state machine and,
under the same JUnit tag, consumer-role behaviours.

**Implementation**: The connector implements the DSP transfer binding surface the
TCK drives against a provider — the canonical message endpoints
(`POST /dsp/transfers/request`, `GET /dsp/transfers/:providerPid`,
`POST /dsp/transfers/:providerPid/{start,completion,termination,suspension}`)
mapped onto the existing transfer FSM — and returns DSP 2025-1 JSON-LD
`Catalog`/`Dataset` responses for the catalogue suite (`dsp-cat`). Two binding
behaviours are **not** implemented: (a) the connector does not deliver
asynchronous DSP state-callback messages to a consumer's callback address — its
transfer FSM resolves synchronously; (b) consumer-role tests are out of the
assessed surface. Both are recorded here as scope decisions; the per-gap ruling
is in `services/dsp-connector/tck/SCOPE-RULING.md`. A separate item — the
creation-ACK status code (DSP binding 201 vs SRS §7.1.3's 202) — is a
requirement-set conflict routed to PMO under NF-11, not a deviation.

**Justification**: FACIS is assessed as a DSP **provider** for a
single-participant demonstrator. A full asynchronous transfer state machine with
outbound callback delivery, and the consumer-role half of the TCK, exceed that
scope; the TCK 1.0.1 tooling also offers no provider-only tag to exclude the
consumer tests cleanly. The error-payload precondition (typed DSP 2025-1 error
objects) and the provider binding surface are implemented so the TCK produces
meaningful provider-side evidence.

**Residual risk & mitigation**: The transfer suite will not reach 100% while the
asynchronous and consumer-role tests remain unaddressed, so the TCK evidence is a
provider-scoped partial pass rather than a full pass. Mitigated by the scope-ruling
document mapping every expected failure to its cause and disposition, by
implementing the provider binding surface and catalogue JSON-LD so the pass rate
reflects real conformance, and by routing the one genuine requirement conflict
(201 vs 202) to PMO rather than silently diverging.

**Approval status**: `Pending — demonstrator scope; ACK status code pending PMO ruling (NF-11)`.

## D-6 — Shared ORCE runtime updates via Recreate, not zero-downtime rolling (NF-10 / test 25)

**Requirement**: QA acceptance test 25 requires a rolling update to complete
without downtime; TDR #2/#19 require repeatable Helm deploy/redeploy/uninstall
and zero-touch flow deployment with machine-readable errors.

**Implementation**: The shared ORCE (Node-RED) Deployment
(`services/simulation/k8s/orce/orce-deployment.yaml`) uses `strategy: Recreate`
because all flow apps share one flows PVC that admits a single writer, and
Node-RED holds authoritative working state in per-process global context (see
[[D-2]]). An update therefore terminates the running pod before the replacement
starts, producing a short request-handling gap. Stateless service Deployments
(e.g. `ai-insight-service`) keep the default rolling strategy and update without
downtime. Deploy/redeploy/uninstall repeatability and machine-readable
flow-deploy status (`{"event":"orce-flow-deploy",...}` lines emitted by the
merge-safe Jobs) are captured by the evidence harness in
[`ops/acceptance/`](../ops/acceptance/README.md).

**Justification**: Zero-downtime rolling of the shared ORCE pod is not
achievable without either sharing/externalizing Node-RED global context across
replicas or splitting each flow app onto its own runtime with its own claim —
both beyond the single-participant demonstrator scope. `Recreate` is the correct
strategy for a single-writer, stateful-in-memory workload: it prevents two pods
writing the same PVC and the split-brain that concurrent global-context writers
would cause.

**Residual risk & mitigation**: A brief control-plane gap during ORCE updates
(bounded by pod start + readiness, evidenced by
`ops/acceptance/rolling-update-probe.sh` with `RECREATE_EXPECTED=1`, and by
health-within-30s for the recovery bound). Mitigated by fast readiness probes on
the ORCE pod, by running updates in maintenance windows, and by the stateless
services carrying the zero-downtime rolling evidence for test 25. Externalizing
ORCE global context to allow multi-replica rolling is the defined follow-up,
shared with [[D-2]].

**Approval status**: `Pending — demonstrator scope; rolling-update exemption for the shared ORCE tier`.


## D-7 — FR-AI-001 AI-retrieval p95 threshold below the Trino-Iceberg query floor (NF-9)

**Requirement**: NF-9 perf criterion FR-AI-001 requires AI-retrieval (1000
records) at **p95 < 500 ms**; QA test #20 (JDBC gold read) requires **p95 < 1000 ms**.

**Implementation**: Gold aggregates are materialized Iceberg tables read over
Trino. The small-file explosion that originally blew both thresholds past 6 s
was remediated (2026-07-24): a Trino restart with `iceberg.expire-snapshots.min-retention`
lowered, then snapshot-expiry + orphan-removal + `OPTIMIZE` on all 21 silver+gold
tables, plus a standing daily `lakehouse-maintenance` CronJob
(`infrastructure/lakehouse/lakehouse-maintenance-cronjob.yaml`). Active files
dropped from ~5000 to ~16 per table; **in-cluster gold-read p95 improved 6420 ms
→ 799 ms**. **QA #20 (JDBC) now PASSES** (< 1000 ms). FR-AI-001 measures **~700-820 ms**.

**Justification**: With files already minimal (~16) the residual latency is the
**Trino per-query baseline** (submit → plan → schedule → execute → page-fetch →
cleanup) for a `SELECT *` of 526 wide rows — a floor of several hundred ms that
holds independent of data size. A **< 500 ms** p95 is therefore not reliably
achievable for *any* Trino-Iceberg query at this demonstrator's stack/scale;
the threshold was set below the engine's fixed overhead. The passing #20 JDBC
result confirms the data-plane itself is healthy and query latency is bounded.

**Residual risk & mitigation**: AI insights are a request/report path, not a
real-time SLA, so ~800 ms p95 carries negligible functional risk. The daily
maintenance CronJob keeps files (and thus latency) bounded going forward. A
genuine sub-500 ms path would require result caching in the AI-insight-service
or a narrower server-side projection (not `SELECT *`) — a defined perf follow-up
(see `project_trino_oom_followup`, `project_iceberg_throughput_baseline`).

**Approval status**: `Pending — PMO ruling on the FR-AI-001 < 500 ms threshold at demonstrator scale (accept ~800 ms, or fund the caching/projection follow-up)`.


## Resolved — no deviation required

Several items the review flagged as candidate deviations were **fixed** rather
than deviated. They are recorded here so the register is a complete account of
every flagged item, not only the ones that remain divergent.

- **TLS 1.3 minimum-version** (NF-8): enforced at the application ingress
  (`ssl-protocols: TLSv1.3`), with a re-runnable evidence scan
  (`infrastructure/tls/verify-tls.sh`) confirming TLS 1.2/1.1 are refused. Not a
  deviation — the requirement is met. (D-3 covers only the separate KMS point.)
- **In-memory state store** (NF-5): DSP transfer and negotiation state is now
  persisted in **PostgreSQL** per SRS §6.1 (`facis-dsp-state` flow +
  `postgres-statefulset.yaml`), demonstrated durable across pod kills. Not a
  deviation — the in-memory concern is resolved. What remains registered is the
  single-replica runtime only (D-2).
- **Dual DSP implementation (Python and ORCE)** (NF-5 / NF-7): there is **no**
  Python DSP connector — the earlier Python implementation was removed, and the
  connector is ORCE-native only, as the TDR mandates
  (`git ls-files services/dsp-connector/src/` returns nothing). Not a deviation —
  there is a single implementation. (D-5 records the separate DSP TCK
  conformance scope, which is unrelated to a dual implementation.)
- **Bronze hourly partitioning** (NF-15): the Bronze table DDL partitions by
  `hour(ingestion_timestamp)` (`infrastructure/lakehouse/setup_lakehouse.py`).
  Not a deviation — the requirement is met for tables provisioned from the
  current source; pre-existing demonstrator tables re-partition on their next
  re-provision (Bronze data is regenerable).
