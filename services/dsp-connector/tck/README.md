# Eclipse DSP TCK — Run Harness & Conformance Gap Register (NF-7)

QA follow-up **NF-7** requires running the Eclipse DSP TCK catalogue and
transfer suites (100% pass) and delivering report, version and logs — after
fixing the plain-string 400 error payload (done: all control-plane errors are
now typed DSP 2025-1 objects; see `orce/tests/flows/dsp-error-binding.spec.js`).

- TCK: `eclipsedataspacetck/dsp-tck-runtime:1.0.1` (targets **DSP 2025-1
  final**; error schemas are byte-identical between 2025-1-RC4 and final, so
  the RC4 reference in the QA report is satisfied by the same shapes).
- Suites are selected by JUnit tags: `dsp-cat` (catalog + metadata tests) and
  `dsp-tp` (transfer process).

## How to run (against the deployed connector)

1. **Relax IAM for the run**: the TCK does not present FACIS VPs — set
   `DSP_IAM_ENFORCE=off` (or `warn`) on the DSP ORCE runtime for the session,
   and record that in the evidence log.
2. **Seed catalogue datasets**: ensure `CAT0101`/`CAT0102`/`CAT0103` exist as
   dataset ids (add to `orce/config/datasets.json` or the derive source).
3. **Seed agreements**: create one finalized negotiation per `TP_xx`
   agreement id in `tck.properties` (`POST /dsp/negotiations`), or map the
   ids in the properties file to existing agreements.
4. **Point the config at the connector**: edit
   `dataspacetck.dsp.connector.http.url` / `.base.url` in `tck.properties`
   (the TCK must be able to reach the connector, and the connector must be
   able to reach `dataspacetck.callback.address`).
5. `./run-tck.sh` — captures the full console output (the TCK's report:
   "Passed tests / Failed tests" + per-test spec-mapped IDs like `CAT:01-02`,
   `TP:01-03`) into `evidence/tck-run-<stamp>.log` together with the image
   digest. Generate the test-plan mapping once with
   `./gradlew genTestPlan` from the dsp-tck repo if the QA wants the
   ID→spec-flow table.

## Conformance gap register

The error-binding precondition is fixed. Gaps 1 and 5 (the provider binding
surface and the catalog JSON-LD shape) are now **implemented**; gaps 2–4 have a
recorded scope decision in `SCOPE-RULING.md`. Per-gap disposition:

| # | Gap | Status | Notes |
|---|---|---|---|
| 1 | Transfer binding paths: TCK drives `POST <base>/transfers/request`, `GET /transfers/:providerPid`, `POST /transfers/:providerPid/{start,completion,termination,suspension}` | **Implemented** | DSP-canonical alias endpoints map onto the existing FSM (translation surface, not a second state machine): `TransferRequestMessage` → create → `TransferProcess` ACK; `GET /:providerPid` returns a `TransferProcess`; `termination`/`suspension`/`start`/`completion` move state. FACIS `POST /dsp/transfers`, `GET/POST /dsp/transfers/:id[/suspend|/terminate]` still work unchanged. Spec: `orce/tests/flows/dsp-transfer-binding.spec.js`. |
| 2 | Creation ACK: binding requires **201**; FACIS returns 202 `{transferId}` (SRS §7.1.3 documents 202) | **PMO ruling** | Requirement-set conflict; code deliberately left at 202. See `SCOPE-RULING.md` → NF-11. The binding response body is a correct `TransferProcess` ACK; only the status code differs. |
| 3 | Async DSP callback messages to `callback.address` are not sent by FACIS | **Accepted deviation** | Transfer FSM is synchronous by design. See `SCOPE-RULING.md` → deviation D-5. |
| 4 | Consumer-role tests (`TP_C`, same `dsp-tp` tag) need the bespoke `transfer.initiate.url` webhook | **Accepted deviation** | FACIS is a provider connector here. See `SCOPE-RULING.md` → deviation D-5. |
| 5 | Catalog response shape: 2025-1 `Catalog`/`Dataset` JSON-LD | **Implemented** | `POST /dsp/catalog/request` now returns a `dcat:Catalog` of `dcat:Dataset` entries (`@context`/`@type`/`@id`, `dcat:distribution`, `odrl:hasPolicy`); FACIS `POST /dsp/catalogue/request` keeps its `{datasets, nextCursor}` shape. `/.well-known/dspace-version` and `GET /dsp/catalog/datasets/:id` also in place. Spec: `orce/tests/flows/dsp-catalog-binding.spec.js`. |

**Bottom line for the QA session:** the NF-7 precondition (typed error payloads
per DSP 2025-1) and the provider binding surface (gaps 1, 5) are implemented and
spec-guarded; the TCK harness is ready to produce the evidence log. The residual
failures are bounded and documented in `SCOPE-RULING.md`: one PMO requirement
conflict (gap 2 / NF-11) and two accepted demonstrator-scope deviations (gaps
3–4 / deviation D-5). A 100% run is not achievable until the PMO resolves the
201-vs-202 conflict and the async-callback / consumer-role scope is funded or the
suite is filtered to the provider-synchronous subset.
