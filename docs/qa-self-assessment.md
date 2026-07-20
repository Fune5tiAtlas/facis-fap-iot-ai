# QA Self-Assessment — Remediation Status

This document re-baselines the project's status against the external QA review's
findings, replacing blanket self-assessment with an accurate per-item status and
a pointer to the evidence for each. It records, for every review item, whether
the requirement is **Met**, **Partial** (implemented but evidence or a decision
is outstanding), **Deviation** (recorded in the deviation register), or **Open**.

Status is scoped to the deployed **ORCE-native** DSP connector (the Node-RED
flows under `services/dsp-connector/orce/`), which is the runtime the TDR
mandates. The connector has no Python implementation — the DSP connector is
ORCE-only.

## Verdict-decisive items (NF-1 – NF-4)

| Item | Requirement | Status | Evidence |
|---|---|---|---|
| **NF-1** | Identity & Trust (FR-IAM-001/002): DID resolution, VC/VP verification, reject invalid presentations with DSP error format | **Met** | `facis-dsp-iam-verify.json` (real did:web resolution, `jose.jwtVerify`, holder binding, jti replay cache, trusted-issuer allowlist, BitstringStatusList revocation); issuance in `facis-dsp-iam-issuance.json`; all four endpoint classes (catalogue, negotiation, transfer, ingest) link-call `iam.verify`; five QA test cases (valid/expired/missing/tampered VP, forged DID) in `tests/flows/iam-verify.spec.js` + `iam-verify-missing-auth.spec.js`; live unauthenticated `POST /dsp/transfers` returns 401 in enforce mode. **Config prerequisite**: enforce mode requires `DSP_TRUSTED_ISSUERS` populated (empty rejects all). |
| **NF-2** | Data Lake HTTP Ingest (FR-DL-001), QA flow #3: negotiate → transfer → ingest → Bronze row | **Met** | Provider serves real Trino rows (`facis-dsp-data.json`, no stub); consumer chain (`facis-dsp-consumer.json`) fetches via the access object, wraps a Bronze envelope, publishes to `dsp.ingest.raw` → NiFi PutSQL → `bronze.dsp_ingest`; consumer attaches a self-issued VP on its internal provider hops so flow #3 runs under enforce; E2E `tests/e2e/dsp-ingest-e2e.js` (live PASS, Bronze row count grew). `/dsp/ingest` is IAM-gated. |
| **NF-3** | Kafka Data-Plane Provisioning (FR-DP-002): real topic; no fabricated values | **Met** (topic) + **Deviation D-4** (credentials) | Real per-transfer topic create/delete on the broker via mTLS AdminClient (`dsp-tx-kafka-admin`); access objects credential-free by design (`sasl`/`token`/`url` null + `accessNote`); E2E `dsp-kafka-transfer-e2e.js` proves topic appears/disappears on the live broker. Credential delivery and ACLs are not buildable on this mTLS-only cluster — deviation D-4, pending client sign-off. |
| **NF-4** | Data-Sink deviation (Q-03): clarify and/or rework | **Met** + **Deviation D-1** | `docs/architecture/fap-role-mapping.md` (simulation proven a pure producer — zero consumer nodes); catalogue derived from live Trino gold tables (`dsp-cat-derive-fn`), the SRS MUST; lakehouse tooling relocated to `infrastructure/lakehouse/`; dedicated ORCE runtime for the connector; deviation D-1, pending RFC Q-03. |

## Follow-up items (NF-5 – NF-15)

| Item | Requirement | Status | Evidence / gap |
|---|---|---|---|
| **NF-5** | State persistence (SRS §6.1, PostgreSQL) | **Met** | Postgres StatefulSet + `DSP_PG_URI`; `facis-dsp-state.json` (DDL bootstrap, one-time legacy migration, transactional snapshot, boot retry, readiness guard); both stores global-scoped (fixed a bug that made transfer persistence a silent no-op); kill-pod durability drill passes live (`services/dsp-connector/orce/README.md` §Durability drill). Deviation D-2 covers the single-replica runtime. |
| **NF-6** | Header-trust / policy enforcement (FR-DL-010/011) | **Met** | AI-insight authorization derived from verified Keycloak tokens (`ai-insight-auth.json`), roles taken only from verified claims; header-injection negative test (`policy-rate-limit.spec.js`); DSP transfer path checks negotiation FINALIZED + counterparty DID (`dsp-tx-agreement-check`). |
| **NF-7** | DSP TCK & error payload (FR-DSP-001) | **Partial** | Typed DSP 2025-1 JSON-LD error bodies (`@context`/`@type`/pids/code/reason) + payload-shape tests (`dsp-error-binding.spec.js`) — **Met**. TCK harness + conformance gap register present (`services/dsp-connector/tck/`). Scope ruling recorded (`services/dsp-connector/tck/SCOPE-RULING.md`): the provider binding surface (canonical transfer paths + `dcat` catalogue JSON-LD) is implemented; asynchronous callbacks and consumer-role tests are demonstrator-scope deviations (D-5); the 201-vs-202 ACK conflict is a PMO ruling (NF-11). A TCK run against the cluster captures the provider-scoped evidence. |
| **NF-8** | TLS 1.3 / S3 SSE / KMS / NetworkPolicies | **Met** (TLS, SSE) + **Deviation D-3** (KMS) + policies | TLS 1.3 minimum enforced at the ingress with a re-runnable evidence scan (`infrastructure/tls/`); S3 default encryption SSE-S3/AES256 enabled (`infrastructure/s3/`); external KMS proven infeasible on IONOS → deviation D-3; NetworkPolicies for the DSP datastores added to the chart (Postgres/Mongo reachable only from the DSP ORCE pod). Superset's separate LB TLS floor is called out as a distinct follow-up. |
| **NF-9** | Load tests (thresholds + p95) | **Partial** | k6/Python scripts exist for every threshold + a p95 report aggregator (`perf/`); not yet run against the cluster, so no captured p95 evidence. Closing requires a run. |
| **NF-10** | IONOS runtime evidence (rolling update, health) | **Partial** | Readiness probes present; the NF-5 kill-pod drill demonstrates in-flight state surviving pod loss (rolling-update evidence). Full helm install/upgrade/uninstall capture against the QA cluster is a run item. |
| **NF-13** | Test hygiene / CI | **Met** (largely) | CI runs the DSP, simulation, industrial-ingestion, SFTP, and AI-insight ORCE flow specs; lockfiles present for the Node test suites; Docker Compose references removed. Remaining nits: some Python deps use lower-bound ranges, integration tests gate on broker availability. |
| **NF-14** | Self-assessment re-baseline | **Met** | This document. |
| **NF-15** | Configuration & deviations | **Met** | Deviation register consolidated (D-1..D-5); gold-materializer single-sourced to `infrastructure/lakehouse/` (Helm copy deprecated). Bronze partitioning granularity and the LLM model id remain client-confirmation items. |
| **NF-11** | Requirement-set defects | **Open** (PMO) | Not contractor code — a PMO ruling-request memo, tracked separately. |
| **NF-12** | Rate limiting | **Partial** | Subject-keyed rate limiting exists in the AI-insight policy flow; enforcement coverage across all data-pull endpoints is a follow-up. |

## Outstanding to reach Accept-with-Conditions

- **Runs** (need the QA cluster): NF-7 TCK to 100% (plus a scope ruling on the five registered gaps), NF-9 load-test p95 capture, NF-10 helm lifecycle capture.
- **Client/PMO decisions** (RFCs): D-1 (Q-03 Data-Sink), D-3 (object-store KMS), D-4 (Kafka credential model), and the NF-11 requirement-set ruling.
- **Cleanup follow-ups**: Superset subdomain TLS floor; broaden rate-limit enforcement (NF-12).
