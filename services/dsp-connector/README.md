# DSP Connector Service

Eclipse Dataspace Protocol (DSP) 1.0 connector for the FACIS FAP IoT & AI platform.
Provides catalogue, negotiation, and transfer process services with HMAC-signed URL provisioning.

Implements:
- **FR-DSP-001**: Catalogue Service (SHOULD)
- **FR-DSP-002**: Contract Negotiation (out of scope per SRS 3.2 -- minimal stub)
- **FR-DSP-003**: Transfer Process (MUST)

## Architecture

```
Consumer ──> [DSP Connector] ──> Signed URL ──> [AI Insight Service]
                  |
                  v
         Transfer Store (state machine)
         Catalogue Store (dataset registry)
```

**Transfer formats:**
- **HTTP Pull**: HMAC-SHA256 signed URLs with time-windowed access
- **Kafka Streaming**: SCRAM-SHA-256 authenticated topic access (stub)

## Quick Start

### Local Development

```bash
pip install -e ".[dev]"

# REQUIRED: HMAC secret for signed URL generation
export DSP_HMAC_SECRET=$(openssl rand -hex 32)
export DSP_DATA_API_BASE_URL=http://localhost:8080

python -m src.main
```

### Docker

```bash
docker build -t facis-dsp-connector .
docker run \
  -e DSP_HMAC_SECRET=$(openssl rand -hex 32) \
  -e DSP_DATA_API_BASE_URL=http://ai-insight:8080 \
  facis-dsp-connector
```

## Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DSP_HMAC_SECRET` | — | **Yes** | Hex-encoded HMAC secret for signed URLs |
| `DSP_DATA_API_BASE_URL` | `https://ai-insight.facis.cloud` | No | Base URL for data access endpoints |
| `DSP_DEFAULT_TTL_SECONDS` | `3600` | No | Default signed URL validity period |
| `DSP_KAFKA_BOOTSTRAP` | — | No | Kafka bootstrap servers (for kafka-streaming format) |
| `DSP_IAM_ENFORCE` | `warn` | No | IAM verification mode: `off` (pre-NF-1 parity), `warn` (log violations), `enforce` (reject) |
| `DSP_VP_AUDIENCE` | `did:web:fap-iotai.facis.cloud` | No | This connector's did:web identity for VP audience claim validation |
| `DSP_TRUSTED_ISSUERS` | — | No | Comma-separated allowlist of trusted VC-issuer DIDs |
| `DSP_IAM_JTI_TTL_SECONDS` | `300` | No | Cache TTL for JWT ID (jti) claim validation |
| `DSP_IAM_DID_CACHE_TTL_SECONDS` | `300` | No | Cache TTL for resolved DIDs and VC documents |
| `DSP_IAM_CATALOGUE` | `open` | No | Catalogue access mode: `open` (public), `verified` (gated to trusted issuers) |
| `HTTP_HOST` | `0.0.0.0` | No | Server bind address |
| `HTTP_PORT` | `8090` | No | Server port |

## API Endpoints

### Catalogue (FR-DSP-001)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dsp/catalogue/request` | Query available datasets |

### Negotiation (FR-DSP-002 -- stub)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dsp/negotiations` | Create negotiation (auto-finalizes) |
| `GET` | `/dsp/negotiations/{id}` | Get negotiation state |
| `POST` | `/dsp/negotiations/{id}/terminate` | Terminate negotiation |

### Transfer Process (FR-DSP-003)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dsp/transfers` | Create transfer (provisions access) |
| `GET` | `/dsp/transfers/{id}` | Get transfer state and access object |
| `GET` | `/dsp/transfers` | List all transfers |
| `POST` | `/dsp/transfers/{id}/suspend` | Suspend a transfer |
| `POST` | `/dsp/transfers/{id}/terminate` | Terminate a transfer |

### Infrastructure

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/docs` | Swagger UI |

## Transfer State Machine

```
REQUESTED ──> STARTED ──> COMPLETED
    |             |
    v             v
TERMINATED   SUSPENDED ──> STARTED
    |             |
    v             v
  ERROR      TERMINATED
```

On `COMPLETED`, an `AccessObject` is provisioned with either:
- A signed pull URL (HTTP Pull format)
- Kafka connection parameters (Kafka Streaming format)

## HMAC Signed URL Format

Token is computed as:
```
HMAC-SHA256(secret, "GET:/api/data/{assetId}:{from}:{to}:{expiresAt}")
```

The signed URL includes `from`, `to`, `expiresAt`, and `sig` query parameters.

## Testing

```bash
pip install -e ".[dev]"
pytest tests/
```

## License

Apache License 2.0 -- see [LICENSE](../../LICENSE).
