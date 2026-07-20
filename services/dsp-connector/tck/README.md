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

## Conformance gap register (expected failures today)

The error-binding precondition is fixed, but a 100% pass additionally
requires binding-level conformance that is **not yet implemented**. Known
gaps, in dependency order:

| # | Gap | TCK impact | Notes |
|---|---|---|---|
| 1 | Transfer binding paths: TCK drives `POST <base>/transfers/request`, `GET /transfers/:providerPid`, `POST /transfers/:providerPid/{start,completion,termination,suspension}`; FACIS exposes `POST /dsp/transfers`, `GET/POST /dsp/transfers/:id[/suspend|/terminate]` | All `TP_*` provider tests | Needs alias endpoints + message-type handling (TransferRequestMessage etc.) |
| 2 | Creation ACK: binding requires **201** with a `TransferProcess` ACK object; FACIS returns 202 `{transferId}` (SRS §7.1.3 documents 202 — requirement-set conflict, see NF-11) | `TP_01_*` | PMO ruling or dual-surface |
| 3 | Async DSP callback messages to the TCK's connector (`callback.address`) are not sent by FACIS | `TP_02_*`/`TP_03_*` state tests | Transfer FSM is synchronous today |
| 4 | Consumer-role tests (`TP_C`, selected by the same `dsp-tp` tag) need the bespoke `transfer.initiate.url` webhook | `TP_C_*` | No provider-only tag exists in TCK 1.0.1; accept these failures or embed via JUnit with a custom filter |
| 5 | Catalog response shape: TCK validates the 2025-1 `Catalog`/`Dataset` JSON-LD schemas; FACIS returns its own `{datasets, nextCursor}` shape | `CAT_*` | `/.well-known/dspace-version` and `GET /dsp/catalog/datasets/:id` + `POST /dsp/catalog/request` alias are now in place; the response-shape mapping remains |

**Bottom line for the QA session:** the NF-7 *precondition* (typed error
payloads per DSP 2025-1) is implemented and spec-guarded; the TCK harness is
ready to produce the evidence log; the remaining gaps above are the
"dual DSP implementation" deviation already named in the QA report (NF-15
deviation register) and need either implementation or a recorded scope
decision before a 100% run is achievable.
