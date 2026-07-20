#!/usr/bin/env python3
"""QA tests #20 (JDBC) and FR-AI-001 (AI retrieval): Trino query latency p95.

The Trino Python DBAPI client speaks the same /v1/statement HTTP protocol as
the official Trino JDBC driver, so these timings are directly comparable to a
JDBC run (see perf/README.md honest-labeling note). Two profiles:

  --profile jdbc : #20  -> p95 < 1000 ms, arbitrary Gold read
  --profile ai   : FR-AI-001 -> p95 < 500 ms fetching 1000 records

Self-judging: exits non-zero if measured p95 exceeds the profile threshold.
"""
import argparse
import json
import os
import statistics
import sys
import time

import trino

PROFILES = {
    "jdbc": {
        "qa_test": "20 (JDBC interface)",
        "threshold_ms": 1000,
        "limit": 1000,
    },
    "ai": {
        "qa_test": "FR-AI-001 (AI retrieval, 1000 records)",
        "threshold_ms": 500,
        "limit": 1000,
    },
}


def connect() -> "trino.dbapi.Connection":
    scheme = os.environ.get("TRINO_HTTP_SCHEME", "https")
    auth = None
    password = os.environ.get("TRINO_PASSWORD")
    if password:
        auth = trino.auth.BasicAuthentication(os.environ.get("TRINO_USER", "trino"), password)
    return trino.dbapi.connect(
        host=os.environ["TRINO_HOST"],
        port=int(os.environ.get("TRINO_PORT", "8443")),
        user=os.environ.get("TRINO_USER", "trino"),
        http_scheme=scheme,
        auth=auth,
        catalog=os.environ.get("TRINO_CATALOG", "iceberg"),
        schema=os.environ.get("TRINO_SCHEMA", "gold"),
    )


def measure(query: str, iterations: int) -> tuple[list[float], int]:
    conn = connect()
    samples_ms: list[float] = []
    last_rows = 0
    for _ in range(iterations):
        cur = conn.cursor()
        start = time.monotonic()
        cur.execute(query)
        rows = cur.fetchall()
        samples_ms.append((time.monotonic() - start) * 1000.0)
        last_rows = len(rows)
        cur.close()
    conn.close()
    return samples_ms, last_rows


def percentile(samples: list[float], pct: float) -> float:
    ordered = sorted(samples)
    if not ordered:
        return 0.0
    k = max(0, min(len(ordered) - 1, int(round((pct / 100.0) * len(ordered) + 0.5)) - 1))
    return ordered[k]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", choices=list(PROFILES), required=True)
    ap.add_argument("--iterations", type=int, default=int(os.environ.get("PERF_TRINO_ITER", "30")))
    ap.add_argument("--table", default=os.environ.get("PERF_TRINO_TABLE", "fact_sensor_measurements"))
    ap.add_argument("--query", default=None, help="override the SQL entirely")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    profile = PROFILES[args.profile]
    query = args.query or f"SELECT * FROM {args.table} LIMIT {profile['limit']}"

    samples, rows = measure(query, args.iterations)
    p95 = percentile(samples, 95)
    result = {
        "test": f"trino-{args.profile}",
        "qa_test": profile["qa_test"],
        "threshold": f"p95 < {profile['threshold_ms']} ms",
        "query": query,
        "iterations": args.iterations,
        "rows_returned": rows,
        "p50_ms": round(statistics.median(samples), 1) if samples else 0.0,
        "p95_ms": round(p95, 1),
        "max_ms": round(max(samples), 1) if samples else 0.0,
        "passed": p95 < profile["threshold_ms"]
        and (args.profile != "ai" or rows >= profile["limit"]),
    }
    text = json.dumps(result, indent=2)
    print(text)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text + "\n")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
