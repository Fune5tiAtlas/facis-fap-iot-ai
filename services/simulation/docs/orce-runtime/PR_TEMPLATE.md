# Pull Request — Entity-Rendered Simulation Runtime + Production Hardening

> Reusable template for the entity-rendering migration PR and any future
> simulation-runtime PRs. Copy the body when opening the PR.

## Summary

Completes the ORCE-native simulation migration that was started on
`feature/orce-native-simulation-runtime` and adds the production-hardening
needed to make it durable against Stackable cluster events (cert rotation,
broker NodePort drift) and operator races (engine state restore).

## Workstreams

- **A — Engine state restore idempotence**
  - `services/simulation/orce/flows/facis-simulation-engine.json`
  - Guards added to `engine-state-restore` and `engine-state-default`.
  - `engine-bootstrap.onceDelay` raised from `0.5s` to `1.5s`.

- **B1 — Client-side Kafka metadata refresh**
  - `services/simulation/orce/rdkafka-patch.js`
  - `services/simulation/orce/scripts/render-kafka.py`
  - `services/simulation/orce/flows/facis-simulation-kafka.json`
  - `services/simulation/helm/facis-simulation/files/orce-flows/facis-simulation-kafka.json`
  - Adds `metadata.max.age.ms=30000` and bootstrap-led broker list.

- **B2 — NodePort drift watcher (defence-in-depth)**
  - `services/simulation/orce/scripts/watch-kafka-brokers.sh`
  - `infrastructure/orce/kafka-broker-watcher-cronjob.yaml`

- **C — mTLS cert expiry monitoring**
  - `infrastructure/orce/kafka-cert-expiry-cronjob.yaml`
  - `infrastructure/monitoring/alerts/facis-alerts.yaml` (3 new alerts)
  - Runbook section: `services/simulation/docs/orce-runtime/operations-runbook.md`

- **D — Documentation**
  - `services/simulation/docs/orce-runtime/entity-rendering-migration.md` (new)
  - `services/simulation/docs/orce-runtime/operations-runbook.md` (new sections for cert rotation, NodePort drift)
  - `infrastructure/README.md` (new — apply order, file walkthrough, conventions)
  - `services/simulation/orce/scripts/README.md` (new — generator usage)
  - `services/simulation/CHANGELOG.md` (new)

## Verification

End-to-end on the IONOS cluster (`fap-iotai.facis.cloud`):

```text
GET /api/v1/simulation/status
{"state":"running","registered_entities":21,"simulation_time":"…","seed":12345}

GET /api/v1/meters → 2 readings, 3-phase
GET /api/v1/pv     → 2 readings with power_output_kw
GET /api/v1/weather → conditions{ghi_w_m2,temperature_c,…}
GET /api/v1/loads   → 4 consumer devices
GET /api/v1/prices  → epex-spot-de, tariff_type=MIDDAY

# Kafka mTLS — fresh messages on all 9 topics:
sim.smart_energy.{meter,pv,weather,price,consumer}
sim.smart_city.{light,traffic,event,weather}

ORCE log: 9× [rdkafka] Producer ready ; no errors ; tick scheduler running.
```

Idempotence:
```bash
python3 services/simulation/orce/scripts/render-feeds.py
python3 services/simulation/orce/scripts/render-kafka.py
git diff --stat services/simulation/orce/flows/   # → empty
helm lint services/simulation/helm/facis-simulation
helm template services/simulation/helm/facis-simulation > /dev/null
```

CronJobs:
```bash
kubectl create job --from=cronjob/kafka-cert-expiry-check kafka-cert-expiry-now -n orce
kubectl logs job/kafka-cert-expiry-now -n orce
# {"level":"info","msg":"kafka cert expiry check","days":18,"notAfter":"…"}

kubectl create job --from=cronjob/kafka-broker-watcher kafka-broker-watcher-now -n orce
kubectl logs job/kafka-broker-watcher-now -n orce
# {"level":"info","msg":"no drift","live":"…"}
```

## Open follow-ups (out of scope)

1. **Auto-rotation of the Stackable mTLS cert.** Requires kubeconfig
   access to the Stackable cluster or a shared cert store. Tracked in
   `services/simulation/CHANGELOG.md` under operational notes.
2. **pytest-bdd test for the engine restore guard.** A scenario that
   asserts `/start` immediately after a flow deploy is preserved.
3. **Image rebuild that bundles modbus + rdkafka + ssh2-sftp-client +
   csv-parse + seedrandom + the rdkafka SSL patch.** The current
   init-deps approach is a runtime self-heal; the long-term answer is a
   custom `xfsc-orce` image with everything baked in.
4. **Cleanup of legacy compose references** in simulation docs (already
   tracked in the original migration-guide).

## Reviewer checklist

- [ ] `python3 render-feeds.py && python3 render-kafka.py` produce a clean diff
- [ ] `helm lint services/simulation/helm/facis-simulation` passes
- [ ] `infrastructure/README.md` walks every file in `infrastructure/`
- [ ] `operations-runbook.md` has cert rotation + NodePort drift sections
- [ ] `facis-alerts.yaml` includes the three new `facis.kafka.certs` rules
- [ ] No secrets, kubeconfigs, or cert material committed
- [ ] `CHANGELOG.md` reflects the user-visible changes
- [ ] Existing CI (`lint-simulation`, `test-simulation`) still green

## Related

- Existing migration: `services/simulation/docs/orce-runtime/migration-guide.md`
