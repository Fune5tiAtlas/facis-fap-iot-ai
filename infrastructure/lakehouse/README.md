# Lakehouse Provisioning & Batch Tooling

Platform provisioning and batch tools for the **FACIS Data Sink** and its
lakehouse (Bronze/Silver/Gold on Trino + Iceberg). These operate the shared
platform, not the simulation, so they live under `infrastructure/` rather than
inside any single service. See the role definition in
[`docs/architecture/fap-role-mapping.md`](../../docs/architecture/fap-role-mapping.md).

## Tools

| Tool | What it does |
|------|--------------|
| `setup_lakehouse.py` | Creates (or tears down) the Bronze/Silver/Gold schemas, tables, and views in Trino/Iceberg. |
| `setup_nifi.py` | Configures the NiFi Kafka→Trino ingestion pipeline (Bronze topics → Trino). |
| `setup_nifi_mqtt_to_kafka.py` | Configures the NiFi MQTT→Kafka pipeline that routes broker messages into Kafka Bronze topics. |
| `materialize_silver.py` | MERGEs new Bronze rows into Silver Iceberg tables, exactly once per Kafka message (keyed on topic, partition, offset). |
| `materialize_gold.py` | Rebuilds each Gold Iceberg table from its view with one atomic `CREATE OR REPLACE TABLE ... AS`. |
| `maintain_lakehouse.py` | Expires snapshots and compacts every Bronze, Silver and Gold table so table metadata stays bounded. |
| `validate_lakehouse.py` | Runs the WP3 validation suite (schemas, tables, and layer checks). |
| `provision_nifi_jdbc.sh` | Provisions the Trino JDBC driver JAR onto the NiFi pods. |
| `silver-materializer-cronjob.yaml` | Kubernetes CronJob that runs `materialize_silver.py` on a schedule. |
| `gold-materializer-cronjob.yaml` | Kubernetes CronJob that runs `materialize_gold.py` on a schedule. |
| `lakehouse-maintenance-cronjob.yaml` | Kubernetes CronJob that runs `maintain_lakehouse.py` daily. |

## Prerequisites

The Python dependencies for these scripts still come from the simulation
package's `lakehouse` extra:

```bash
pip install -e "services/simulation[lakehouse]"
```

Then run any tool from the repo root, e.g.:

```bash
python infrastructure/lakehouse/setup_lakehouse.py --env-file .env.cluster
```

## Materializer CronJobs

The CronJob manifests in this directory are the **single source of truth** for
the scheduled Silver/Gold materializers. The equivalent Helm-chart templates in
`services/simulation/helm/facis-simulation` are disabled by default and
deprecated in favour of these manifests.

Each CronJob mounts its scripts from a ConfigMap. Create/refresh them from the
canonical script paths:

```bash
kubectl create configmap facis-silver-scripts \
  --from-file=materialize_silver.py=infrastructure/lakehouse/materialize_silver.py \
  --from-file=setup_lakehouse.py=infrastructure/lakehouse/setup_lakehouse.py \
  -n stackable

kubectl create configmap facis-gold-scripts \
  --from-file=materialize_gold.py=infrastructure/lakehouse/materialize_gold.py \
  --from-file=setup_lakehouse.py=infrastructure/lakehouse/setup_lakehouse.py \
  -n stackable

# Shared credentials for both CronJobs:
kubectl create secret generic facis-lakehouse-credentials \
  --from-env-file=.env.cluster -n stackable

kubectl apply -f infrastructure/lakehouse/silver-materializer-cronjob.yaml
kubectl apply -f infrastructure/lakehouse/gold-materializer-cronjob.yaml
```

## Required catalog settings

The scripts depend on these properties of the Iceberg catalog (`configOverrides`
on the Stackable `TrinoCatalog` CR; the coordinator and workers must be
restarted after a change):

```yaml
configOverrides:
  # Commit with compare-and-set instead of a Hive Metastore lock. Locks left
  # behind by a killed query blocked every later writer of that table.
  iceberg.hive-catalog.locking-enabled: "false"
  # Lets the scripts set the two table properties that delete superseded
  # metadata.json files on commit.
  iceberg.allowed-extra-properties: "write.metadata.delete-after-commit.enabled,write.metadata.previous-versions-max"
  # maintain_lakehouse.py expires bronze snapshots after 1 day (default floor is 7d).
  iceberg.expire-snapshots.min-retention: "0s"
```

Without a metastore lock, two commits to the same table at the same moment make
one of them fail instead of wait. The CronJobs use `concurrencyPolicy: Forbid`
and retry, so run manual writes against a table only while its job is idle.

## Table maintenance

Every commit adds a snapshot to a table's `metadata.json` and, by default,
leaves the previous `metadata.json` in object storage. Left unbounded this grew
single metadata files to several hundred MB (the cause of the Trino coordinator
out-of-memory loop in November 2026) and left more than 100 TB of superseded
copies in the bucket. Three things keep it bounded:

- `materialize_silver.py` and `materialize_gold.py` create their tables with
  `write.metadata.delete-after-commit.enabled=true` and
  `write.metadata.previous-versions-max=10`.
- `maintain_lakehouse.py` sets the same properties on any table that lacks
  them, expires snapshots (bronze after 1 day, silver and gold after 7), and
  compacts data files and manifests. It exits non-zero if a table still has
  more than 20,000 snapshots.
- `remove_orphan_files` is deliberately not run: on tables with around a
  million objects it starved the coordinator's health check.

```bash
kubectl create configmap facis-maintenance-scripts \
  --from-file=maintain_lakehouse.py=infrastructure/lakehouse/maintain_lakehouse.py \
  --from-file=setup_lakehouse.py=infrastructure/lakehouse/setup_lakehouse.py \
  -n stackable
kubectl apply -f infrastructure/lakehouse/lakehouse-maintenance-cronjob.yaml
```
