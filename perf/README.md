# FACIS Performance Evidence Harness (NF-9)

Load-test scripts and p95 report generation for every QA performance
threshold (Inspection & Approval §11.4 + FR-AI-001). Scripts embed their
thresholds, so each run is self-judging (non-zero exit on breach); the
aggregator turns the collected outputs into the QA evidence report.

| QA test | Threshold | Script | Output |
|---|---|---|---|
| #16 Catalog request | p95 < 500 ms | `k6/catalogue.js` | `evidence/k6-catalogue.json` |
| #17 Negotiation completes | < 5 s | `k6/negotiation.js` | `evidence/k6-negotiation.json` |
| #18 HTTP data fetch (1000 readings) | p95 < 2 s | `k6/http-fetch.js` | `evidence/k6-http-fetch.json` |
| #19 Kafka throughput | ≥ 10,000 msg/s sustained | `kafka/throughput.py` | `evidence/kafka-throughput.json` |
| #20 Data retrieval via JDBC | p95 < 1 s | `trino/query-latency.py --profile jdbc` | `evidence/trino-jdbc.json` |
| #21 Data retrieval via REST | p95 < 1 s | `k6/rest-access.js` | `evidence/k6-rest-access.json` |
| FR-AI-001 AI retrieval (1000 records) | p95 < 500 ms | `trino/query-latency.py --profile ai` | `evidence/trino-ai.json` |

## Prerequisites

- [k6](https://k6.io) ≥ 0.50 (single binary; no cluster tooling needed).
- Python 3.11 + `pip install -r perf/requirements.txt` (confluent-kafka, trino).
- Copy `env.example`, fill it in, `source` it. Notes:
  - AI Insight endpoints require a Bearer token since NF-6 (`FACIS_TOKEN`,
    realm role `ai_insight_consumer`).
  - For the DSP scripts either set `DSP_IAM_ENFORCE=off` for the session or
    provide `DSP_AUTH_HEADER` with a valid VP; record the choice in the run
    log.
  - Kafka uses the cluster mTLS certs (`KAFKA_SSL_*`, same files the ORCE
    pod mounts at /etc/kafka-certs).

## Running

```bash
cd perf
mkdir -p evidence

k6 run --summary-export evidence/k6-catalogue.json  k6/catalogue.js
k6 run --summary-export evidence/k6-negotiation.json k6/negotiation.js
k6 run --summary-export evidence/k6-http-fetch.json k6/http-fetch.js
k6 run --summary-export evidence/k6-rest-access.json k6/rest-access.js

python kafka/throughput.py   --out evidence/kafka-throughput.json
python trino/query-latency.py --profile jdbc --out evidence/trino-jdbc.json
python trino/query-latency.py --profile ai   --out evidence/trino-ai.json

python report.py             # -> evidence/perf-report-<UTC stamp>.md
```

Each k6 script defaults to a 60 s steady load (`PERF_VUS`/`PERF_DURATION`
override). `report.py` aggregates whatever exists under `evidence/` into a
single markdown table (threshold, measured p95/achieved rate, PASS/FAIL) —
that file plus the raw JSON outputs are the NF-9 evidence package. Record
the target environment, git commit, and IAM mode alongside.

## Honest-labeling notes for the QA session

- **#20 (JDBC)**: `trino/query-latency.py` uses the Trino Python DBAPI
  client, which speaks the same `/v1/statement` protocol as the official
  Trino JDBC driver. If the QA insists on the literal JDBC driver, run the
  same query through `trino-jdbc` in any JDBC client and attach that timing;
  the script's numbers are directly comparable.
- **#18**: the fetched window must actually contain ≥ 1000 readings — the
  script checks and reports the row count; pick `PERF_WINDOW_FROM/TO`
  accordingly.
- **#19**: the producer must be network-close to the brokers (run from a pod
  inside the cluster, not a laptop over VPN) for the number to be meaningful.
