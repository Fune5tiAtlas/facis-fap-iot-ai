# Industrial Ingestion — ORCE Flows

ORCE (Node-RED) implementation of the Industrial Ingestion Pattern. This is
the only implementation of this service — there is no Python counterpart.

## Layout

- `flows/facis-inding-modbus-client.json` — Modbus TCP client (FC3 poll,
  float32 ABCD decode, envelope, Kafka publish)
- `flows/facis-inding-opcua-client.json` — OPC UA client (readmultiple poll,
  StatusCode→quality mapping, envelope, Kafka publish)
- `flows/facis-inding-dlq.json` — shared dead-letter publisher
- `flows/facis-inding-observability.json` — health endpoint + catch-all
- `tests/flows/*.spec.js` — parity specs (`node --test flows` from `tests/`)

## Shared ORCE pod conventions

The flows deploy onto the shared ORCE runtime next to the simulation, SFTP
and DSP tabs. To avoid collisions:

- tab/node ids are prefixed `inding-` / `tab-inding-`
- the health endpoint is namespaced: `GET /api/v1/industrial/health`
- Kafka client ids: `facis-orce-inding` / `facis-orce-inding-dlq`

Runtime packages (`node-red-contrib-modbus`, `node-red-contrib-opcua`,
`node-red-contrib-rdkafka`) are provisioned by the shared ORCE image /
init container (`infrastructure/orce/init-deps-patch.yaml` and
`services/simulation/orce/Dockerfile`) — cross-service coupling documented
there.

## Talking to the fixtures

Defaults target the simulation fixtures in-pod: Modbus server on
`127.0.0.1:5020` (tab-modbus) and the OPC UA demo server on
`opc.tcp://127.0.0.1:4840` (tab-opcua). The clients speak real protocol TCP
— no Node-RED links or shared context between client and fixture — so
swapping in a real PLC/server is an env-var change only.
