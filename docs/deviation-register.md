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

## Pending candidate entries

The following candidate deviations are identified and awaiting a full entry; the
detail is to be completed.

- TLS 1.3 minimum-version enforcement location (NF-8) — to be completed.
- Dual DSP implementation, Python and ORCE (NF-5 / NF-7) — to be completed.
- File-based DSP state and single-replica deployment (NF-5) — to be completed.
