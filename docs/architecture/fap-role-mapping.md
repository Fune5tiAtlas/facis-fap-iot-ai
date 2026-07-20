# FAP Role Mapping — FACIS IoT & AI

This document maps every architecture role defined by the SRS/FAP reference model
onto the component that realizes it in this repository, and defines the **FACIS
Data Sink** — the named composite that fulfills the SRS's Data Sink role. It exists
so that role terminology used across the codebase and its documentation resolves to
concrete, evidenced components rather than abstract reference-model boxes.

## Role mapping table

| SRS/FAP role | Realized by | Evidence |
|---|---|---|
| Data Provider (IoT sources) | Simulation service (`services/simulation/`) | Generates 9 correlated feeds and publishes them over Kafka/MQTT/Modbus/REST. Pure producer: no Kafka/MQTT consumption and no lakehouse read-back (see the runtime evidence matrix below). |
| **Data Sink** (collect, normalize, buffer, queryable access) | **FACIS Data Sink** = ORCE ingest/validation flows (schema validation + feed splitting) + Kafka topics (durable buffer) + NiFi ingestion (normalization + landing) + Trino **Bronze** layer (queryable storage) | Composite defined formally in the next section. |
| Provider Data Connector | `services/dsp-connector/` ORCE flows | Catalogue (`/dsp/catalogue/request`, derived from the Data Sink — see `facis-dsp-catalogue.json`), transfer process (`/dsp/transfers`), data plane (`/api/data/:assetId`, serving from the lakehouse), and IAM (`/iam/*`, `/.well-known/*`). |
| Consumer Data Connector | Same service's consumer flow | `/dsp/ingest` lands into Bronze via `dsp.ingest.raw` (`services/dsp-connector/orce/flows/facis-dsp-consumer.json`), demonstrating the consumer role of a single-participant demonstrator. |
| Data Lake | Trino/Iceberg medallion lakehouse | Bronze → Silver → Gold on the Stackable cluster. |
| Analytics/AI | ai-insight-service, ai-insight-ui, Superset | Gold-layer consumers. |

## The FACIS Data Sink — formal definition

The SRS's Data Sink role bundles four functions: centralized collection of provider
data, normalization to a common form, reliability buffering so that transient
downstream unavailability does not lose data, and queryable access to what has been
collected. In this implementation those functions are realized as a single named
composite, the **FACIS Data Sink**:

- **Centralized collection** — ORCE ingest/validation flows accept the simulation
  service's unified tick envelope, validate it against schema, and split it into the
  per-feed streams.
- **Normalization** — NiFi ingestion normalizes the validated feeds and lands them
  in the lakehouse.
- **Reliability buffering** — Kafka topics provide the durable buffer between
  ingest and landing, decoupling producer cadence from downstream availability.
- **Queryable access** — the Trino **Bronze** layer is the queryable store of
  collected data.

Two consequences follow from this definition and are used elsewhere in the codebase:
the provider connector's catalogue is **derived from** the FACIS Data Sink rather
than maintained as a separate hand-authored inventory, and the Bronze layer is the
FACIS Data Sink's queryable store that the connector's data plane reads from.

## Simulation service: runtime evidence matrix

The simulation service occupies the Data Provider role and nothing else. The
following table records the runtime behaviors that establish provider purity.

| Behavior | Present | Evidence (file:line) |
|---|---|---|
| Produces Kafka (9 topics) | Yes | `services/simulation/orce/flows/facis-simulation-kafka.json` (9× `rdkafka out`); `services/simulation/src/api/kafka/topics.py:19-45` |
| Consumes Kafka | No | Zero consumer nodes in any flow; the only Kafka call in the Python producer path is a producer poll/flush (`services/simulation/src/api/kafka/producer.py:193`) |
| Publishes MQTT | Yes | `services/simulation/orce/flows/facis-simulation-mqtt.json` (`mqtt out` only) |
| Subscribes MQTT | No | Zero `mqtt in` nodes in any flow |
| Serves REST snapshots | Yes | `services/simulation/orce/flows/facis-simulation-rest.json`; `services/simulation/src/api/rest/routes/` |
| Reads back from Kafka/Trino | No | `services/simulation/src/api/rest/routes/meters.py:83-100` (in-memory `generate_at`); `services/simulation/src/api/rest/dependencies.py:39-64` (no Kafka/Trino client) |
| Contains DSP code | No | Zero `dsp` references in `services/simulation/src/` or `services/simulation/orce/flows/` |

## Deployment topology

The realized components run as ORCE (Node-RED) runtimes on Kubernetes, split across
two ORCE instances:

- **Shared ORCE instance** — the simulation flow set, the SFTP flow set, and the
  AI-UI flow set run together on one shared runtime.
- **Dedicated DSP ORCE instance** — the `services/dsp-connector/` flow set runs on
  its own dedicated runtime. A dedicated DSP ORCE runtime is the deployment mode of
  the `facis-dsp-connector` chart, configured through its `dedicatedOrce` values
  block (`services/dsp-connector/helm/facis-dsp-connector/values.yaml`).

Isolation between flow sets rests on several properties:

- **Separate charts** — each runtime is deployed by its own Helm chart.
- **Separate flow tabs** — flow sets occupy distinct Node-RED tabs.
- **Namespaced HTTP paths** — routes are namespaced by prefix (for example
  `/dsp/*`, `/iam/*`), so flow sets do not collide on paths.
- **Merge-by-id deploys** — flows deploy by merging on node id, so a deploy of one
  flow set does not wipe another's tabs.
- **IAM gating on DSP routes** — DSP protocol routes are gated by the connector's
  IAM flows.

The topology is sized for a single-participant demonstrator: a single replica per
ORCE instance, and file-based DSP state rather than an external state store.

## Related documents

- [`deviation-register.md`](../deviation-register.md) — recorded deviations,
  including the NF-4 entry.
- [`system-architecture.md`](../../services/simulation/docs/architecture/system-architecture.md)
  — the simulation service and end-to-end pipeline architecture.
- [`dsp-connector/README.md`](../../services/dsp-connector/README.md) — the DSP
  connector's protocol surface.
