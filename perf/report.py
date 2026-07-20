#!/usr/bin/env python3
"""Aggregate perf evidence into a single QA report (NF-9).

Reads every JSON under evidence/ — both k6 --summary-export files and the
Python script outputs (kafka/trino) — and emits a markdown table mapping each
QA threshold to its measured value and PASS/FAIL verdict.
"""
import argparse
import glob
import json
import os
import sys
import time

# QA test -> (label, threshold text). Order defines the report rows.
THRESHOLDS = [
    ("k6-catalogue", "#16 Catalog request", "p95 < 500 ms"),
    ("k6-negotiation", "#17 Negotiation completes", "< 5 s"),
    ("k6-http-fetch", "#18 HTTP fetch (1000 readings)", "p95 < 2 s"),
    ("kafka-throughput", "#19 Kafka throughput", ">= 10,000 msg/s"),
    ("trino-jdbc", "#20 Retrieval via JDBC", "p95 < 1 s"),
    ("k6-rest-access", "#21 Retrieval via REST", "p95 < 1 s"),
    ("trino-ai", "FR-AI-001 AI retrieval (1000 records)", "p95 < 500 ms"),
]

K6_LIMITS_MS = {
    "k6-catalogue": 500,
    "k6-negotiation": 5000,
    "k6-http-fetch": 2000,
    "k6-rest-access": 1000,
}


def load(evidence_dir: str, stem: str):
    path = os.path.join(evidence_dir, stem + ".json")
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def k6_p95_ms(doc) -> float | None:
    """Extract p95 http_req_duration from a k6 --summary-export document."""
    metrics = doc.get("metrics", {})
    dur = metrics.get("http_req_duration") or {}
    # k6 summary export exposes percentiles as e.g. "p(95)".
    for key in ("p(95)", "p95"):
        if key in dur:
            return float(dur[key])
    return None


def row_for(stem: str, label: str, threshold: str, doc):
    if doc is None:
        return (label, threshold, "—", "NOT RUN")

    if stem.startswith("k6-"):
        p95 = k6_p95_ms(doc)
        limit = K6_LIMITS_MS[stem]
        if p95 is None:
            return (label, threshold, "no p95 in export", "INCONCLUSIVE")
        verdict = "PASS" if p95 < limit else "FAIL"
        return (label, threshold, f"p95 {p95:.0f} ms", verdict)

    if stem == "kafka-throughput":
        rate = doc.get("achieved_msg_per_sec", 0)
        verdict = "PASS" if doc.get("passed") else "FAIL"
        return (label, threshold, f"{rate:,.0f} msg/s", verdict)

    if stem in ("trino-jdbc", "trino-ai"):
        p95 = doc.get("p95_ms", 0)
        extra = f"p95 {p95:.0f} ms"
        if stem == "trino-ai":
            extra += f", {doc.get('rows_returned', 0)} rows"
        verdict = "PASS" if doc.get("passed") else "FAIL"
        return (label, threshold, extra, verdict)

    return (label, threshold, "unknown", "INCONCLUSIVE")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence-dir", default="evidence")
    ap.add_argument("--stamp", default=None,
                    help="UTC stamp for the filename; pass one for reproducible names")
    args = ap.parse_args()

    rows = [row_for(stem, label, thr, load(args.evidence_dir, stem))
            for stem, label, thr in THRESHOLDS]

    stamp = args.stamp or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    total = len(rows)
    passed = sum(1 for r in rows if r[3] == "PASS")
    not_run = sum(1 for r in rows if r[3] == "NOT RUN")

    lines = [
        "# FACIS Performance Evidence Report (NF-9)",
        "",
        f"Generated: {stamp}",
        f"Summary: {passed}/{total} PASS"
        + (f", {not_run} NOT RUN" if not_run else ""),
        "",
        "| QA threshold | Target | Measured | Verdict |",
        "|---|---|---|---|",
    ]
    for label, threshold, measured, verdict in rows:
        lines.append(f"| {label} | {threshold} | {measured} | {verdict} |")
    lines += [
        "",
        "Raw outputs: the per-test JSON files under `evidence/`.",
        "Record target environment, git commit, and IAM mode with this report.",
        "",
    ]
    report = "\n".join(lines)
    print(report)

    out = os.path.join(args.evidence_dir, f"perf-report-{stamp}.md")
    os.makedirs(args.evidence_dir, exist_ok=True)
    with open(out, "w") as fh:
        fh.write(report)
    print(f"\nWrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
