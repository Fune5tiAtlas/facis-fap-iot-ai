# NF-7 DSP TCK — Per-Gap Scope Ruling

This is the architect's disposition for each conformance gap in the TCK gap
register (`README.md`). It records what is now implemented, what is deferred to
the PMO, and what is an accepted demonstrator-scope deviation, so a TCK run's
pass/fail profile is understood rather than surprising.

## Ruling table

| # | Gap | Disposition | Rationale | Pointer |
|---|-----|-------------|-----------|---------|
| 1 | Canonical transfer binding paths (`/transfers/request`, `GET /transfers/:providerPid`, `.../start\|completion\|termination\|suspension`) | **Implemented** | Added DSP-canonical alias endpoints that map onto the existing transfer FSM — a translation surface, not a second state machine. Same `global.get('transfers')` store, same transition matrix, same persist link. | `orce/flows/facis-dsp-transfers.json` |
| 2 | Creation ACK status code: DSP binding wants **201**, FACIS returns **202** | **PMO ruling** | SRS §7.1.3 mandates 202; the DSP binding wants 201. This is a requirement-set conflict, not a bug — code is deliberately left at 202 and the conflict is escalated. | NF-11 |
| 3 | Async DSP callback messages to the TCK's `callback.address` | **Accepted deviation** | The transfer FSM is synchronous by design for the demonstrator; no outbound callback channel is built. The binding accepts and records `callbackAddress` but never calls it. | Deviation register **D-5** |
| 4 | Consumer-role tests (`TP_C_*`, same `dsp-tp` tag) | **Accepted deviation** | FACIS is a provider connector for this demonstrator; the consumer webhook (`transfer.initiate.url`) is out of scope. TCK 1.0.1 has no provider-only tag to exclude these. | Deviation register **D-5** |
| 5 | Catalog response JSON-LD shape (`dcat:Catalog` / `dcat:Dataset`) | **Implemented** | `POST /dsp/catalog/request` now returns a DSP 2025-1 `dcat:Catalog` of `dcat:Dataset` entries (with `@context`/`@type`/`@id`, `dcat:distribution`, `odrl:hasPolicy`). FACIS `POST /dsp/catalogue/request` keeps its native `{datasets, nextCursor}` shape. | `orce/flows/facis-dsp-catalogue.json` |

## What a TCK run will now pass

- **`CAT_*` (catalog + dataset schema):** the catalog-request response and the
  `GET /dsp/catalog/datasets/:id` lookup are now spec-shaped 2025-1 JSON-LD, and
  `/.well-known/dspace-version` advertises the protocol version. Catalog schema
  validation that previously failed on the FACIS `{datasets, nextCursor}` shape
  is expected to pass.
- **`TP_*` provider request/read/state transitions:** the canonical binding
  paths exist and drive the real FSM. `TransferRequestMessage` → create →
  `TransferProcess` ACK; `GET /transfers/:providerPid` returns a
  `TransferProcess`; `termination`/`suspension`/`start`/`completion` move state
  and return a `TransferProcess` ACK or a typed `TransferError`. Path-shape and
  message-type conformance for these is expected to pass.
- **Error binding (precondition):** every control-plane error is a typed DSP
  2025-1 object (`TransferError` / `ContractNegotiationError` / `CatalogError`),
  already implemented and spec-guarded.

## What will still fail, and why

- **`TP_01_*` creation-ACK assertions that require HTTP 201** — FACIS returns
  **202** (Gap 2, SRS §7.1.3). Not a defect; a requirement conflict awaiting the
  PMO ruling (NF-11). The response *body* is a correct `TransferProcess` ACK; only
  the status code differs.
- **`TP_02_*` / `TP_03_*` async-callback state tests** — FACIS never posts DSP
  messages to the TCK's `callback.address` (Gap 3). Accepted deviation D-5.
- **`TP_C_*` consumer-role tests** — no consumer webhook (Gap 4). Accepted
  deviation D-5. TCK 1.0.1 offers no provider-only tag, so these run under the
  `dsp-tp` tag and are expected to fail unless filtered out with a custom JUnit
  selector at run time.

## Bottom line

Gaps 1 and 5 are implemented against the existing FSM/catalogue with no new state
machine and no regression to the error-binding or version endpoints. The
remaining failures are bounded and explained: one PMO requirement conflict (Gap
2 / NF-11) and two accepted demonstrator-scope deviations (Gaps 3–4 / D-5). A
100% run is not achievable until the PMO resolves the 201-vs-202 conflict and the
async-callback / consumer-role scope is either funded or the suite is filtered to
the provider-synchronous subset.

### Executed evidence (2026-07-24) — provider-synchronous subset green

`tck/evidence/tck-run-20260724T124437Z.log` (isolated IAM-off instance,
`tck-datasets.json` overlay live) records the provider-synchronous subset passing
**4/4**: `MET:01-01`, `CAT:01-01`, `CAT:01-02`, `CAT:01-03` all **SUCCESSFUL**.
Two connector-side conformance fixes closed the earlier `CAT:01-02/03` failures:

- **`CAT:01-02` (dataset request):** the single-dataset endpoint `dsp-cat-dataset-fn`
  (`orce/flows/facis-dsp-catalogue.json`) now emits a proper `dcat:Dataset` JSON-LD
  (`@context`/`@type`/`@id`/`dct:title`/`dcat:distribution`/`odrl:hasPolicy`) rather
  than the raw internal `{id, metadata, offers}` object — resolving the TCK's
  JSON-LD-navigation NPE. Unit-guarded by `orce/tests/flows/dsp-dataset-dcat.spec.js`.
- **`CAT:01-03` (dataset request *not found*):** `CAT_01_03_DATASETID=CAT0103` is the
  negative probe — the fixture set deliberately **omits** CAT0103 (seeds only
  CAT0101/CAT0102) so the connector returns a 404 `CatalogError`.

The other 55 tests are exhaustively `ContractNegotiation*` / `TransferProcess*`
async-callback FSM and consumer-role cases (Gaps 3–4). They require the CUT to POST
DSP state callbacks to `callback.address`, which is unreachable from the in-cluster
connector reached via inbound port-forward; TCK 1.0.1 has no synchronous TP subset.
FINALIZED-agreement seeding (`tck/tck-agreements-seed.sql`) is delivered as the
necessary state groundwork but cannot be TCK-verified without a callback bridge —
so those remain accepted deviation **D-5**, unchanged.

## Approval / sign-off

This scope ruling is **approved** as the delivery-side decision governing DSP TCK
conformance for the FACIS FAP IoT & AI demonstrator. It fixes the conformance
scope at the **provider-synchronous** surface (Gaps 1 and 5 implemented), records
the async-callback and consumer-role items as accepted demonstrator-scope
deviations (Gaps 3–4, register **D-5**), and escalates the 201-vs-202 ACK conflict
to the PMO (Gap 2, **NF-11**). The executed provider-synchronous run above
(`tck-run-20260724T124437Z.log`, 4/4) is the acceptance evidence for the
implemented surface.

| Role | Name | Decision | Date |
|---|---|---|---|
| Remediation / delivery lead | Daniel Pires | Approved — scope fixed as above | 2026-07-23 |
| PMO (Gap 2 / NF-11 only) | *pending* | Open — 201-vs-202 requirement-set conflict | — |

> The PMO line remains open by design: Gap 2 is a requirement-set conflict that
> only the PMO can rule on (NF-11). It does not gate the provider-synchronous
> conformance evidence approved above.
