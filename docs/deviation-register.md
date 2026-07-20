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
- [Pending candidate entries](#pending-candidate-entries)

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

## Pending candidate entries

The following candidate deviations are identified and awaiting a full entry; the
detail is to be completed.

- TLS 1.3 minimum-version enforcement location (NF-8) — to be completed.
- Dual DSP implementation, Python and ORCE (NF-5 / NF-7) — to be completed.
