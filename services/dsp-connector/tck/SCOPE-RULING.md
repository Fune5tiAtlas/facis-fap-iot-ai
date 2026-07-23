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

## Approval / sign-off

This scope ruling is **approved** as the delivery-side decision governing DSP TCK
conformance for the FACIS FAP IoT & AI demonstrator. It fixes the conformance
scope at the **provider-synchronous** surface (Gaps 1 and 5 implemented), records
the async-callback and consumer-role items as accepted demonstrator-scope
deviations (Gaps 3–4, register **D-5**), and escalates the 201-vs-202 ACK conflict
to the PMO (Gap 2, **NF-11**). A TCK run under the provider-synchronous selector
is the acceptance evidence for the implemented surface.

| Role | Name | Decision | Date |
|---|---|---|---|
| Remediation / delivery lead | Daniel Pires | Approved — scope fixed as above | 2026-07-23 |
| PMO (Gap 2 / NF-11 only) | *pending* | Open — 201-vs-202 requirement-set conflict | — |

> The PMO line remains open by design: Gap 2 is a requirement-set conflict that
> only the PMO can rule on (NF-11). It does not gate the provider-synchronous
> conformance evidence approved above.
