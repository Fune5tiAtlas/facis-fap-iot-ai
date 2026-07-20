# FACIS Industrial Ingestion Service

Reference implementation of the **Industrial Ingestion Pattern**: how real
industrial data sources are connected to the FACIS data flow via open OT
protocols (OPC UA and Modbus TCP), normalized into the FACIS data model, and
forwarded into the existing Data Sink (the Kafka Bronze ingestion layer).

This is an ORCE-only service — there is no Python implementation. The flows
run on the shared ORCE (Node-RED) pod alongside the other FACIS flow apps.

> **Scope**: this is a reusable integration pattern, **not** a SCADA or OT
> platform. The connectors are strictly read-only, poll a statically
> configured address list, and do not implement alarms, HMI, historian,
> device management, OT network auto-discovery, or writes to PLCs.

## Architecture

```
OPC UA server ──(opc.tcp, readmultiple)──▶ OPC UA client flow ──┐
                                                                ├─ normalize ─▶ Kafka Bronze
Modbus TCP server ──(FC3, registers)────▶ Modbus client flow ──┘   (mTLS)        topics
                                                                      │
                                                              failures ▼
                                                                DLQ topic
```

By default both clients point at the simulation fixtures on the same ORCE
pod (`services/simulation/orce/flows/facis-simulation-modbus.json` on port
5020 and `facis-simulation-opcua.json` on port 4840), making the demo fully
self-contained. Pointing at a real PLC or OPC UA server is a pure
configuration change (env vars / Helm values).

## Flows

| Flow | Tab | Purpose |
|---|---|---|
| `orce/flows/facis-inding-modbus-client.json` | `tab-inding-modbus-client` | FC3 poll → float32 ABCD decode → envelope → Kafka |
| `orce/flows/facis-inding-opcua-client.json` | `tab-inding-opcua-client` | readmultiple poll → StatusCode→quality → envelope → Kafka |
| `orce/flows/facis-inding-dlq.json` | `tab-inding-dlq` | Typed dead-letter publisher (non-recursive) |
| `orce/flows/facis-inding-observability.json` | `tab-inding-observability` | `GET /api/v1/industrial/health` + catch-all |

## Industrial ingestion envelope

Every published message is one snapshot of one device per poll cycle:

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
  "readings": { "active_power_l1_w": 10234.5, "...": "13 metrics, FACIS field names" },
  "raw_payload": "<stringified raw registers / OPC UA items>"
}
```

Semantics are **at-least-once**: `event_id` is deterministic
(`source_endpoint|device_id|source_timestamp`) so downstream deduplication
(Silver layer, per FR-DL-002) is possible. A failed cycle (connect error,
short register block, Bad OPC UA status, non-numeric value) goes to the DLQ
as a typed envelope and **no partial snapshot is ever published**. Values
that are finite but out of plausible range are published with `quality`
`uncertain` — range filtering stays in the Silver layer, consistent with the
rest of FACIS.

## Configuration

All settings reach the flows as ORCE pod environment variables, rendered by
the Helm chart into the `facis-industrial-orce-env` Secret (consumed by the
ORCE chart via `extraEnvFrom`, same pattern as `facis-sftp-orce-env`).

| Env var | Default | Purpose |
|---|---|---|
| `MODBUS_HOST` / `MODBUS_PORT` | `127.0.0.1` / `5020` | Modbus source (fixture by default) |
| `MODBUS_UNIT_ID` | `1` | Unit id |
| `MODBUS_POLL_MS` | `5000` | Poll interval |
| `MODBUS_BASE_ADDRESS` | `19000` | First register of the block |
| `MODBUS_DEVICE_ID` | `janitza-umg96rm-001` | Envelope device id / Kafka key |
| `MODBUS_INGEST_TOPIC` | `modbus.ingest.raw` | Bronze topic |
| `OPCUA_ENDPOINT` | `opc.tcp://127.0.0.1:4840` | OPC UA source (fixture by default) |
| `OPCUA_POLL_MS` | `5000` | Poll interval |
| `OPCUA_NODE_PREFIX` | `ns=1;s=FACIS.EnergyMeter.` | NodeId prefix for the 13 metrics |
| `OPCUA_DEVICE_ID` | `janitza-umg96rm-001` | Envelope device id / Kafka key |
| `OPCUA_INGEST_TOPIC` | `opcua.ingest.raw` | Bronze topic |
| `INDING_SITE_ID` | `site-001` | Envelope site id |
| `INDING_DLQ_TOPIC` | `industrial.ingest.dlq` | Dead-letter topic |
| `INDING_KAFKA_BROKERS` | — (required) | Stackable broker list (mTLS certs at `/etc/kafka-certs`) |

## Tests

```bash
cd services/industrial-ingestion-service/orce/tests
node --test flows
```

Parity specs (`node:test`, no Node-RED runtime, no broker) covering: float32
decode against the fixture encoding, register offsets cross-checked against
the simulation register map, cycle aggregation and quality mapping, envelope
contract, and DLQ formatting/wiring. Wired into CI (`test-orce-flows` job).

## Deploy

```bash
cd services/industrial-ingestion-service/helm/facis-industrial-ingestion
./sync-flows.sh
helm upgrade --install facis-industrial-ingestion . -n facis
```

The post-install Job merge-deploys the flows onto the shared ORCE runtime
(it fetches the current flow set and replaces only this service's tabs).
Prerequisites: `facis-orce-admin` Secret (admin token), Kafka mTLS certs on
the ORCE pod, and the `facis-industrial-orce-env` Secret wired into the ORCE
chart's `extraEnvFrom`.

## Documentation

See `docs/industrial-ingestion-pattern.md` (repository root `docs/`) for the
full pattern description and how to adapt it to real industrial sources.
