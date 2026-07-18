# DSP Connector Service

Eclipse Dataspace Protocol (DSP) 1.0 connector for the FACIS FAP IoT & AI platform.
Provides catalogue, negotiation, and transfer process services with HMAC-signed URL
provisioning, plus NF-1 Identity & Trust (VP verification, did:web issuance, Identity
Hub). Implemented as ORCE-native Node-RED flows — see `orce/README.md` for the flow
layout, tests, and deploy mechanics. This file documents the protocol surface.

Implements:
- **FR-DSP-001**: Catalogue Service (SHOULD)
- **FR-DSP-002**: Contract Negotiation (out of scope per SRS 3.2 -- minimal stub)
- **FR-DSP-003**: Transfer Process (MUST)
- **FR-IAM-001/002**: Identity & Trust — see `orce/flows/facis-dsp-iam-verify.json`,
  `facis-dsp-iam-issuance.json`, `facis-dsp-iam-hub.json`

## Architecture

```
Consumer ──> [DSP Connector (ORCE)] ──> Signed URL ──> [AI Insight Service]
                  |
                  v
         Transfer Store (state machine)
         Catalogue Store (dataset registry)
```

**Transfer formats:**
- **HTTP Pull**: HMAC-SHA256 signed URLs with time-windowed access
- **Kafka Streaming**: SCRAM-SHA-256 authenticated topic access (stub)

## Configuration

Rendered into the ORCE pod's environment by the Helm chart's Secret
(`helm/facis-dsp-connector/templates/orce-secret.yaml`) — see that chart's
`values.yaml` for the full list, including the `dsp.iam.*` identity values
(`DSP_IAM_ENFORCE`, `DSP_VP_AUDIENCE`, `DSP_TRUSTED_ISSUERS`, etc.).

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
| `GET` | `/dsp/transfers` | List the caller's own transfers |
| `POST` | `/dsp/transfers/{id}/suspend` | Suspend a transfer |
| `POST` | `/dsp/transfers/{id}/terminate` | Terminate a transfer |

### Identity & Trust — Issuance / Identity Hub (NF-1 follow-on)

This connector's own did:web identity, Participant VC self-issuance, a minimal
OID4VCI issuer surface, and a MongoDB-backed read API over issued credentials
(`orce/flows/facis-dsp-iam-issuance.json` and `facis-dsp-iam-hub.json`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/did.json` | Serves this connector's own did:web document (verification method built from `DSP_CONNECTOR_KEY`'s public JWK) |
| `GET` | `/.well-known/openid-credential-issuer` | Static OID4VCI issuer metadata (single credential type: `ParticipantCredential`, format `jwt_vc_json`) |
| `POST` | `/iam/oid4vci/credential` | Issues a fresh self-signed Participant VC (`jwt_vc_json`), Bearer-guarded; pushes the record onto the Identity Hub for persistence |
| `GET` | `/iam/hub/credentials` | Lists persisted credentials, filterable by `?type`/`?issuer`/`?subject`/`?status` |
| `GET` | `/iam/hub/credentials/:id` | Fetches a single persisted credential by its `_id` (the credential's `jti`) |
| `GET` | `/iam/hub/participant` | Returns this connector's own `ParticipantCredential` — the DCP Credential-Service pull endpoint counterparties use to fetch it |

### Infrastructure

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/dsp/health` | Health check |
| `GET` | `/dsp/metrics` | Prometheus metrics |

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
HMAC-SHA256(secret, "GET:/api/data/{assetId}:{from}:{to}:{expiresAt}:{agreementId}:{roles}")
```

`agreementId` is the transfer's agreement ID; `roles` is the caller's roles, sorted
and comma-joined (empty string if none, e.g. when `DSP_IAM_ENFORCE=off` or identity
didn't resolve). Both are bound into the canonical message so a signed URL can't be
replayed against a different agreement or role set, and both are percent-encoded
before being concatenated into the message -- not just the URL -- so an unencoded `:`
inside either field can't make two different `(agreementId, roles)` pairs collide on
the same signed message. Encoded with `encodeURIComponent`.

The signed URL targets `{baseUrl}/api/data/{assetId}` on **ai-insight-service**
specifically, and includes `from`, `to`, `expiresAt`, `agreementId`, `roles`, and
`token` query parameters. ai-insight-service verifies the token there and enforces
`PolicyEnforcer` using these HMAC-verified `agreementId`/`roles` claims -- see
[ai-insight-service's configuration guide](../ai-insight-service/docs/guides/configuration.md#policy-and-rate-limiting)
for the policy implications.

## Testing

```bash
cd orce/tests
npm install --include=dev
node --test flows
```

See `orce/README.md` for the full flow layout and deploy mechanics.

## License

Apache License 2.0 -- see [LICENSE](../../LICENSE).
