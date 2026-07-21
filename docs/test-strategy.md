# Test Strategy & Behavioral Coverage Map

This document states, per service, the behavioral test surface and how it maps
to the QA review's BDD/scenario expectation (NF-13; review §3.5 "BDD coverage
meets the TDR scenario catalogue for only one of five services").

## Guiding principle

The platform is **ORCE-native**: the runtime the TDR mandates is the Node-RED
(ORCE) flows. Python was deliberately removed from the connector-style services
(DSP connector) and never existed for the UI. Behavioral coverage is therefore
expressed in the idiom each service is actually built in, not forced into a
Python `pytest-bdd` harness where no Python exists:

- **Services with a Python implementation** (simulation, ai-insight-service,
  sftp-ingestion-service) carry `pytest-bdd` Gherkin suites.
- **ORCE-only / JS-only services** (dsp-connector, ai-insight-ui) express the
  same behavioral scenarios as `node:test` flow specs (assertions over the
  deployed flow behavior and wiring) plus live-harness and e2e checks. This is
  an accepted equivalence, not a coverage gap: the scenarios exist and run in
  CI; they are written in the runtime's own test tool.

## Per-service coverage

| Service | Runtime | Behavioral coverage | In CI |
|---|---|---|---|
| simulation | ORCE + Python | `pytest-bdd` (`tests/bdd/*.feature`, 11 features) + `node:test` flow specs (`orce/tests/flows`) | yes |
| ai-insight-service | ORCE + Python | `pytest-bdd` (`tests/bdd`) + `node:test` flow specs incl. auth/policy negatives | yes |
| sftp-ingestion-service | ORCE + Python | `pytest-bdd` (`tests/bdd/sftp_health.feature`, env-gated live) + `node:test` flow specs | yes |
| **dsp-connector** | **ORCE-only** | **`node:test` flow specs** (220 assertions: catalogue, negotiation FSM, transfer FSM, typed-error binding, HMAC + per-agreement rate limit, IAM verify) **+ DSP TCK harness** (`tck/`) **+ e2e** (`tests/e2e`) | yes |
| **ai-insight-ui** | **JS/Vue-only** | **`node:test` flow guards** (`orce/tests/flows/ui-flows.spec.js`: SPA fallback, admin Keycloak gate, id-uniqueness) **+ Playwright e2e** (`ui/app/test/e2e`) | flow guards: yes |

## Why dsp-connector and ai-insight-ui use `node:test` instead of `pytest-bdd`

Standing up a Python `pytest-bdd` harness (pyproject, dependency tree, a Python
CI job) inside these two services would reintroduce the exact Python footprint
the project deliberately removed, for services whose product code is entirely
ORCE flows / a Vue SPA. The behavioral scenarios the TDR catalogue asks for are
covered by the runtime's native test tool:

- **dsp-connector**: each control-plane behavior (catalogue query/filter,
  negotiation lifecycle, transfer state transitions and their typed DSP 2025-1
  errors, signed-URL verification, per-agreement rate limiting, VP/VC
  verification) has an explicit `node:test` scenario in `orce/tests/flows/`;
  end-to-end negotiate→transfer→ingest and Kafka-topic-lifecycle behaviors run
  in `tests/e2e/`; protocol conformance is the TCK harness (`tck/`, NF-7).
- **ai-insight-ui**: the served surface (SPA fallback route, Keycloak-gated
  admin proxy) is asserted by `node:test` flow guards run in CI, and full
  browser behavior by the existing Playwright e2e suite.

## CI hygiene (NF-13)

- No `pytest` exit-code-5 ("no tests collected") tolerance — a suite that
  collects nothing now fails.
- ORCE flow specs for **every** service run in CI (`test-orce-flows`),
  including ai-insight-ui.
- Test dependencies are pinned: each Node test suite ships a committed
  `package-lock.json` and installs with `npm ci`; the simulation suite's
  `seedrandom` is declared in `orce/tests/package.json`.
- `pytest-bdd`/`httpx` are declared in the dev extras of the Python services
  that carry BDD.
