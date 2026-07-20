# Migration Guide — Python Simulation → ORCE-native Runtime

## Audience

Operators upgrading an existing FACIS deployment from the Python simulation
service to the ORCE-native runtime introduced on the
`feature/orce-native-simulation-runtime` branch.

## What changes

- Simulation lifecycle, tick generation, deterministic RNG, all 9 simulators,
  correlation engine, and the four protocol adapters (Kafka, MQTT, Modbus,
  REST) move into ORCE flows on the existing ORCE pod.
- The Python image is no longer the runtime; it remains in the chart as the
  rollback fallback (`compatibilityMode=legacy`) but is scaled to 0 by default.
- Helm chart adds a post-install Job hook that POSTs flow JSON to the ORCE
  Admin API.

## What does **not** change

- REST endpoint paths and JSON schemas (`/api/v1/simulation/*`,
  `/api/v1/{meters,pv,weather,prices,loads}`, `/api/v1/health`).
- Kafka topic names (`sim.smart_energy.*`, `sim.smart_city.*`) and the JSON
  payload field names + types.
- MQTT topic conventions, QoS, retain flags.
- Modbus TCP register addresses (Janitza UMG 96RM layout).
- The Stackable Kafka, NiFi, Trino, and MinIO/S3 backends.

## SRS § 9.1.1 vs Technical Development Requirements

The FACIS SRS § 9.1.1 lists "Docker Compose (Development) or Kubernetes
(K3S, KIND)" as an exemplary single-host development profile, and § 11.5
Test 22 asserts "Docker Compose deployment starts successfully".

The FACIS Technical Development Requirements supersede the SRS for delivery
rules and explicitly state: **"Kubernetes v1.29 or higher on IONOS Cloud /
Helm for deployments / ORCE runtime for Builder execution / No Docker
Compose permitted."**

**Position taken by this migration**: we follow the TDR's stricter rule.
Concretely:

- The simulation service no longer ships any `docker-compose*.yml` file.
- The BDD `docker_deployment.feature` retains only the container-level
  scenarios (image build, env-driven config, volume mount); the multi-service
  compose scenario has been dropped.
- Local development uses kind/k3d clusters with the bundled Helm chart, not
  Docker Compose.

If a reviewer flags SRS Test 22 as an acceptance gap, point to the TDR's
"No Docker Compose permitted" clause and the corresponding statement in the
Change Request acceptance criteria. The TDR is the source of truth for
delivery rules.

Compose references across the tree's documentation, scripts, and test
docstrings have since been cleaned up to point at the Helm/kind local
stack instead. Only the compliance banners noting the TDR §9.1.1 rule
itself remain.

## Controlled break: numeric determinism

The ORCE-native engine uses a JS-native `seedrandom('alea')` PRNG seeded via
`sha256(base_seed:entity_id:tag:ts_ms)`. The Python service uses numpy's
PCG64. The seeding strategy is identical, but the underlying bit-stream
algorithms differ.

**Concrete consequence**: BDD scenarios and integration tests that asserted
exact numeric values from the Python service will not match the ORCE-native
output. They have been rewritten to assert ranges, correlations and
reproducibility instead. Property-based tests in
`services/simulation/orce/tests/flows/*.spec.js` cover the new engine.

If a test of yours asserts a specific float, regenerate the baseline:

```bash
helm upgrade facis-simulation . --set compatibilityMode=orce
# Run your suite against the ORCE-native runtime; capture new baselines.
```

## Step-by-step rollout

### 1. Pre-checks

```bash
# Confirm Stackable Kafka certs are in place
kubectl -n facis get secret kafka-tls-certs

# Confirm ORCE admin token Secret exists
kubectl -n facis get secret facis-orce-admin

# Sync flow JSON into the chart files/ directory
cd services/simulation/helm/facis-simulation
./sync-flows.sh
```

### 2. Stage in a non-prod cluster

```bash
helm upgrade --install facis-simulation . \
  --namespace facis-staging --create-namespace \
  --set compatibilityMode=orce
```

Run the smoke tests in
[`operations-runbook.md`](./operations-runbook.md#verify-kafka-publishing).
Confirm at least:

- Engine boots and `/api/v1/simulation/start` transitions the FSM.
- Kafka `sim.smart_energy.meter` receives messages every `(60 / speed_factor)`
  seconds.
- Modbus client reads of register 19000-19001 round-trip to a non-zero float.
- Trino sees rows in `bronze.energy_meter` after a few minutes.

### 3. Production cutover

```bash
helm upgrade facis-simulation services/simulation/helm/facis-simulation/ \
  --namespace facis --reuse-values \
  --set compatibilityMode=orce
```

Watch:

- `kubectl -n facis logs job/facis-simulation-orce-flow-deploy` (post-install
  Job)
- `kubectl -n facis get pods` — Python deployment should scale to 0.
- ORCE pod logs for `[entrypoint] simulation runtime modules ready`.

### 4. Decommission the Python image (optional, deferred to Phase 16)

Once the ORCE-native runtime has run cleanly in production for one full week
including a Bronze→Silver→Gold cycle, you may delete:

- The Python `Dockerfile`, `pyproject.toml`, and the `src/` directory
  (after archiving).
- The `legacy` branch of the `compatibilityMode` flag.

The legacy path is intentionally retained until that point so rollback is a
single Helm value flip.

## Rollback

See [`rollback.md`](./rollback.md). One-line summary:

```bash
helm upgrade facis-simulation . --reuse-values --set compatibilityMode=legacy
```
