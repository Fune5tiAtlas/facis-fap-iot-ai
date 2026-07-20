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
| `materialize_silver.py` | Incrementally INSERTs new Bronze rows into Silver Iceberg tables (watermark-tracked). |
| `materialize_gold.py` | Materializes the Gold views into Gold Iceberg tables for fast queries. |
| `validate_lakehouse.py` | Runs the WP3 validation suite (schemas, tables, and layer checks). |
| `provision_nifi_jdbc.sh` | Provisions the Trino JDBC driver JAR onto the NiFi pods. |
| `silver-materializer-cronjob.yaml` | Kubernetes CronJob that runs `materialize_silver.py` on a schedule. |
| `gold-materializer-cronjob.yaml` | Kubernetes CronJob that runs `materialize_gold.py` on a schedule. |

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
