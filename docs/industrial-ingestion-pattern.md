# Industrial Ingestion Pattern

**A reusable pattern for connecting real industrial data sources to the FACIS
data flow via open OT protocols (OPC UA, Modbus TCP), normalizing them into
the FACIS data model, and forwarding them into the existing Data Sink.**

This pattern is the reference implementation of the SRS "OT/IoT Connector"
component (SRS Table 1: "Protocol adapters (OPC UA, MQTT, Modbus), bridge to
HTTP/Kafka"). It is explicitly **not** a SCADA or OT platform — see
[Non-goals](#non-goals).

## Where it lives

| Piece | Location |
|---|---|
| Reference flows (OPC UA + Modbus clients, DLQ, health) | `services/industrial-ingestion-service/orce/flows/` |
| Modbus TCP demo source (test fixture) | `services/simulation/orce/flows/facis-simulation-modbus.json` |
| OPC UA demo source (test fixture) | `services/simulation/orce/flows/facis-simulation-opcua.json` |
| Parity specs | `services/industrial-ingestion-service/orce/tests/flows/` |
| Helm chart (flows ConfigMap + merge-deploy Job + env Secret) | `services/industrial-ingestion-service/helm/facis-industrial-ingestion/` |

## The pattern

```
┌─────────────────────┐   opc.tcp (readmultiple)   ┌──────────────────────┐
│ OPC UA source        │◀──────────────────────────│ OPC UA client flow    │──┐
│ (PLC / demo fixture) │                           │ poll → quality → norm │  │
└─────────────────────┘                            └──────────────────────┘  │   ┌──────────────────┐
                                                                             ├──▶│ Kafka Bronze      │──▶ NiFi → Iceberg
┌─────────────────────┐   Modbus TCP (FC3)         ┌──────────────────────┐  │   │ (the Data Sink    │    Bronze → Silver
│ Modbus TCP source    │◀──────────────────────────│ Modbus client flow    │──┘   │  ingestion layer) │    (Trino views)
│ (PLC / demo fixture) │                           │ poll → decode → norm  │      └──────────────────┘
└─────────────────────┘                            └──────────────────────┘              │ failures
                                                                                         ▼
                                                                                  DLQ topic (typed envelopes)
```

1. **Acquire** — a client flow polls the source over the native OT protocol
   (read-only): Modbus TCP holding registers (FC3), or OPC UA attribute reads
   (`readmultiple`). Connection parameters are environment-driven; the flow
   never embeds credentials or endpoints.
2. **Decode / assess** — protocol payloads become typed numbers: float32
   register pairs (big-endian ABCD) for Modbus; OPC UA DataValues with their
   StatusCodes mapped to a `quality` field (`good` / `uncertain`; `Bad`
   fails the cycle).
3. **Normalize** — one snapshot per device per poll cycle is wrapped in the
   *industrial ingestion envelope* (below). Metric names follow the FACIS
   convention of unit-suffixed field names (`active_power_l1_w`).
4. **Forward** — the envelope is published to a Kafka Bronze ingestion topic
   over mTLS. This is the "Data Sink API" of the running system: Kafka
   ingestion is one of the three data-lakehouse ingestion interfaces defined
   by the SRS (§7.3.1), and the Bronze → Silver → Gold refinement happens
   downstream exactly as for every other FACIS source.
5. **Fail safely** — connection errors, short reads, decode failures and Bad
   statuses produce a typed dead-letter envelope; a failed cycle never
   publishes a partial snapshot.

## Industrial ingestion envelope

```json
{
  "schema_version": "1.0",
  "event_id": "modbus-tcp://127.0.0.1:5020/1|janitza-umg96rm-001|2026-07-19T14:00:05.000Z",
  "ingest_timestamp": "2026-07-19T14:00:05.123Z",
  "source_protocol": "modbus-tcp",
  "source_endpoint": "modbus-tcp://127.0.0.1:5020/1",
  "site_id": "site-001",
  "device_id": "janitza-umg96rm-001",
  "source_timestamp": "2026-07-19T14:00:05.000Z",
  "quality": "good",
  "readings": {
    "active_power_l1_w": 10234.5,
    "active_power_l2_w": 10123.4,
    "active_power_l3_w": 10345.6,
    "active_power_total_w": 30703.5,
    "voltage_l1_v": 230.5,
    "voltage_l2_v": 231.0,
    "voltage_l3_v": 229.8,
    "current_l1_a": 45.2,
    "current_l2_a": 44.7,
    "current_l3_a": 45.9,
    "power_factor": 0.97,
    "total_energy_kwh": 123456.789,
    "frequency_hz": 50.02
  },
  "raw_payload": "<stringified raw registers / OPC UA items>"
}
```

| Field | Notes |
|---|---|
| `schema_version` | Envelope contract version (`1.0`) |
| `event_id` | Deterministic: `source_endpoint\|device_id\|source_timestamp`. Enables downstream deduplication (Silver, per FR-DL-002) under at-least-once delivery |
| `ingest_timestamp` | When the connector built the envelope (ISO 8601 UTC) |
| `source_protocol` | `modbus-tcp` or `opc-ua` |
| `source_endpoint` | Protocol-scheme URL of the source |
| `source_timestamp` | OPC UA `sourceTimestamp` when available; otherwise the poll-cycle start |
| `quality` | `good` or `uncertain` (OPC UA StatusCode-derived; Modbus reads are `good` by construction). `Bad` never publishes — it dead-letters |
| `readings` | Normalized snapshot, FACIS unit-suffixed field names, aligned with the star-schema direction of SRS §7.4 (`value`, `unit`, `quality_flag`) |
| `raw_payload` | String-serialized protocol-level raw data (registers / DataValues), preserving the Bronze "raw with minimal transformation" principle |

Out-of-range but finite values are **published** with their quality flag —
plausibility filtering stays in the Silver layer (Trino `WHERE` clauses),
consistent with the rest of FACIS. Structurally invalid data (non-numeric,
short register block, invalid timestamp) dead-letters the whole cycle.

## Kafka topics

| Topic | Producer | Default |
|---|---|---|
| `modbus.ingest.raw` | Modbus client flow | env `MODBUS_INGEST_TOPIC` |
| `opcua.ingest.raw` | OPC UA client flow | env `OPCUA_INGEST_TOPIC` |
| `industrial.ingest.dlq` | DLQ tab | env `INDING_DLQ_TOPIC` |

Message key = `device_id` (per-device ordering). Both datasets are registered
in the DSP Provider catalogue (`services/dsp-connector/orce/config/datasets.json`),
so the Provider connector derives its catalogue from the Data Sink as the SRS
describes. Topics follow the existing convention (pre-create via
`kafka-topics.sh` or rely on broker auto-create — see
`services/simulation/docs/deployment/infrastructure-prerequisites.md`).

## Swapping the demo fixture for a real source

Everything is environment-driven (rendered by the Helm chart into the
`facis-industrial-orce-env` Secret):

- **Real PLC over Modbus TCP**: set `MODBUS_HOST`, `MODBUS_PORT`,
  `MODBUS_UNIT_ID`, `MODBUS_BASE_ADDRESS`, and (if the register layout
  differs) adapt the offset map in the decode function — the only
  device-specific piece of the flow.
- **Real OPC UA server**: set `OPCUA_ENDPOINT`, `OPCUA_NODE_PREFIX` (or a
  full NodeId list). For secured endpoints, the `OpcUa-Endpoint` config node
  supports Sign / SignAndEncrypt and username or certificate authentication;
  the demo uses SecurityPolicy None + anonymous **only because it targets
  the in-pod fixture**.

No flow logic changes are needed for a source that exposes the same metric
set; the pattern (acquire → decode → normalize → forward → DLQ) is the
reusable part.

## Non-goals

Explicitly out of scope, in line with SRS §3.2 ("deep Operational Technology
(OT) protocol server implementations are out of scope") and the agreed
framing ("this should not become a SCADA or OT platform extension"):

- writes to PLCs or any remote control of equipment
- HMI, alarm management, historian, device management
- OT network auto-discovery (address lists are static configuration)
- production-grade OPC UA / Modbus **server** implementations (the demo
  servers are test fixtures of the simulation, not products)
- OT high availability, industrial certification
- universal register-map support (the decode map is per-device configuration)
- full OPC UA certificate lifecycle management

## Verification

- CI (no broker, no Node-RED runtime): `node --test flows` in
  `services/industrial-ingestion-service/orce/tests` — decode parity against
  the fixture encoding, register-offset cross-check, cycle aggregation and
  quality mapping, envelope contract, DLQ wiring. Simulation-side fixtures
  are covered by `services/simulation/orce/tests/flows/{modbus,opcua}.spec.js`.
- Live (env-gated, against a deployed ORCE pod): read registers with
  `pymodbus` (`services/simulation/docs/api/modbus-reference.md`), browse the
  OPC UA endpoint with any UA client, and consume the Bronze topics with
  `kcat`/`confluent_kafka` to observe envelopes end-to-end.
