# FACIS FAP IoT & AI Monorepo

FACIS IoT-AI Federated Architecture Pattern (IoT-AI FAP) enables secure IoT data collection,
dataspace-compliant transfer, data-lake aggregation, AI-supported analytics, and dashboard
visualization across on-premise and air-gapped environments.

Part of the [FACIS](https://github.com/eclipse-xfsc/facis) project under [IPCEI-CIS](https://www.ipcei-cis.eu/).

## Services

| Service | Path | Description | Status |
|---------|------|-------------|--------|
| Simulation | `services/simulation/` | Deterministic IoT simulation (9 correlated feeds) | v1.0.0 |
| AI Insight Service | `services/ai-insight-service/` | FastAPI backend for governed AI insights | v0.1.0 |
| AI Insight UI | `services/ai-insight-ui/` | Vue.js + UIBUILDER dashboard | v0.1.0 |
| SFTP Ingestion | `services/sftp-ingestion-service/` | Polls SFTP directories, publishes to Kafka Bronze layer | v1.0.0 |
| DSP Connector | `services/dsp-connector/` | Eclipse Dataspace Protocol connector (catalogue, transfers, identity) — ORCE-native | v1.0.0 |
| Industrial Ingestion | `services/industrial-ingestion-service/` | OPC UA + Modbus TCP ingestion reference flows (ORCE-only) | v0.1.0 |

## Quick Start

### Local Development

```bash
# Simulation Service
cd services/simulation
pip install -e ".[dev]"
python -m src.main

# AI Insight Service
cd services/ai-insight-service
pip install -e ".[dev]"
python -m src.main

# SFTP Ingestion Service
cd services/sftp-ingestion-service
pip install -e ".[dev]"
python -m src.main
```

DSP Connector is ORCE-native (Node-RED flows) — see
[services/dsp-connector/orce/README.md](services/dsp-connector/orce/README.md)
for local flow testing.

### Kubernetes (Production)

```bash
# Deploy all services via Helm
helm install facis-simulation services/simulation/helm/facis-simulation/ -n facis --create-namespace
helm install facis-ai-insight services/ai-insight-service/helm/facis-ai-insight/ -n facis
helm install facis-ai-insight-ui services/ai-insight-ui/helm/facis-ai-insight-ui/ -n facis
helm install facis-sftp-ingestion services/sftp-ingestion-service/helm/facis-sftp-ingestion/ -n facis
```

See [docs/deployment.md](docs/deployment.md) for full deployment instructions.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/deployment-walkthrough.md](docs/deployment-walkthrough.md) | **Step-by-step deployment with validation gates** |
| [docs/features.md](docs/features.md) | Feature overview and functional breakdown |
| [docs/deployment.md](docs/deployment.md) | Deployment reference (Helm values, config) |
| [docs/ci-cd.md](docs/ci-cd.md) | CI/CD pipeline configuration |
| [docs/api-docs.md](docs/api-docs.md) | API documentation (REST, MQTT, Modbus) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor guidelines |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community code of conduct |

### Per-Service Documentation

- **Simulation:** [services/simulation/docs/](services/simulation/docs/)
- **AI Insight Service:** [services/ai-insight-service/docs/](services/ai-insight-service/docs/)
- **AI Insight UI:** [services/ai-insight-ui/docs/](services/ai-insight-ui/docs/)
- **SFTP Ingestion:** [services/sftp-ingestion-service/README.md](services/sftp-ingestion-service/README.md)
- **DSP Connector:** [services/dsp-connector/README.md](services/dsp-connector/README.md)

## Architecture

```
IoT Devices / Simulators
        |
        v
  [MQTT / Kafka] ──> [NiFi] ──> [Bronze] ──> [Silver] ──> [Gold (Trino)]
        |                                                        |
        v                                                        v
  [ORCE (Node-RED)] <──────────────────────── [AI Insight Service]
        |                                            |
        v                                            v
  [Simulation Control]                    [AI Insight UI (Vue.js)]
```

## Technology Stack

- **Runtime:** Kubernetes v1.29+ on IONOS Cloud
- **Orchestration:** XFSC ORCE (Node-RED)
- **Backend:** Python 3.11, FastAPI
- **Frontend:** Vue.js 3, Chart.js, UIBUILDER
- **Data:** Apache Kafka, NiFi, Trino, Avro
- **AI:** OpenAI-compatible LLM API
- **CI/CD:** GitHub Actions
- **Deployment:** Helm, Docker

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions require the
[Eclipse Contributor Agreement (ECA)](https://www.eclipse.org/legal/ECA.php).

## License

Licensed under [Apache License 2.0](LICENSE).

SPDX-License-Identifier: Apache-2.0
