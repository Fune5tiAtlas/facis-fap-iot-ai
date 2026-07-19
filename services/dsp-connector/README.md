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
- **Kafka Streaming**: real per-transfer topic provisioning on the FACIS Kafka cluster (mTLS-only — no credentials delivered in-band; see "Kafka Streaming Transfer Format" below)

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
| `DSP_KAFKA_BOOTSTRAP` | `212.132.83.222:9093` | No | Kafka bootstrap (kafka-streaming topic creation + access objects) |
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

### NF-2: Data Lake HTTP Ingest

Provider-side real data serving (replacing the dead `ai-insight-service` Python
stub at the same path) and consumer-side Bronze ingest — see `orce/README.md`'s
"NF-2: Data Lake HTTP Ingest" section for the flow details, the
`SFTP_KAFKA_BROKERS` live-deploy caveat, and the E2E verification script.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/data/:assetId` | HTTP Pull Profile data endpoint — verifies the signed URL and returns the requested dataset's rows from Trino |
| `POST` | `/dsp/ingest` | Consumer-side: drive a negotiated transfer, pull its data, land it in Bronze |

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

`http-pull` transfers auto-complete (`REQUESTED → STARTED → COMPLETED`) and attach
an `AccessObject` with a signed pull URL. `kafka-streaming` transfers stop at
`STARTED` (NF-3): a stream has no natural end, and `COMPLETED` is terminal —
parking a live stream there would make suspend/terminate unreachable and orphan
its topic. The `AccessObject` attaches once the topic genuinely exists on the
broker; on provisioning failure the transfer lands in `ERROR` with a `reason`.

## Kafka Streaming Transfer Format (NF-3)

`POST /dsp/transfers` with `format: "kafka-streaming"` creates a **real** Kafka
topic on the FACIS Stackable cluster via `node-rdkafka`'s `AdminClient`, using
the connector's own mTLS client certificate (`/etc/kafka-certs/`) — the same
identity every producer/consumer flow on the shared ORCE pod already uses.

- **Topic**: `iot.dataset.<assetId sanitized to [a-zA-Z0-9._-]>.<transferId>`
  (e.g. `iot.dataset.dataset-facis-net-grid-hourly.tp-1a2b3c4d5e6f`), 1
  partition, replication factor 1. Sanitization is required — `:` is illegal
  in Kafka topic names. The pre-NF-3 stub's doubled `tp-tp-` prefix is fixed.
- **Access object**: `{ bootstrap, topic, sasl: null, accessNote, expiresAt }`.
  `bootstrap` defaults to the cluster's stable bootstrap `212.132.83.222:9093`.
  **No credential material is ever delivered.** The cluster is mTLS-only (SASL
  is deliberately absent from the toolchain), and shipping the connector's own
  private key would let any recipient impersonate the connector on every topic
  it touches — so `accessNote` states: "Connecting to this topic requires an
  mTLS client certificate trusted by the FACIS Kafka cluster, arranged
  out-of-band with the data space operator. This API does not deliver
  connection credentials." `expiresAt` is advisory (no reaper).
- **Terminate** deletes the topic on the broker. **Suspend** keeps it —
  suspend is a reversible pause (`SUSPENDED → STARTED` is legal); note that
  without in-band credentials suspension is state-only and cannot revoke a
  counterparty's out-of-band mTLS trust at the data plane.

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

The signed URL targets `{baseUrl}/api/data/{assetId}`, and includes `from`, `to`,
`expiresAt`, `agreementId`, `roles`, and `token` query parameters. This endpoint is
served by the ORCE flow (`orce/flows/facis-dsp-data.json`'s `dsp-data-verify-fn`
node), not by ai-insight-service -- the old Python route at the same path
(`services/ai-insight-service/src/api/rest/routes/dsp.py`) is dead code (see
`orce/README.md`'s NF-2 section). `dsp-data-verify-fn` reconstructs the HMAC from
the request's query params and rejects on mismatch or expiry; there is no
PolicyEnforcer-equivalent check beyond that -- `agreementId`/`roles` are bound into
the signature itself (so a signed URL can't be replayed against a different
agreement or role set) rather than being separately re-checked against a policy
engine.

## Testing

```bash
cd orce/tests
npm install --include=dev
node --test flows
```

See `orce/README.md` for the full flow layout and deploy mechanics.

## License

Apache License 2.0 -- see [LICENSE](../../LICENSE).
