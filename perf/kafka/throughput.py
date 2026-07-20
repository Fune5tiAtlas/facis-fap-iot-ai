#!/usr/bin/env python3
"""QA test #19: Kafka data plane sustains >= 10,000 msg/s per topic.

Producer-side sustained-rate measurement against the FACIS Stackable cluster
(mTLS, same cert files the ORCE pod mounts at /etc/kafka-certs). Produces a
fixed payload as fast as librdkafka allows for a wall-clock window, flushes,
and reports achieved msg/s. Self-judging: exits non-zero if below target.

Run from a pod inside the cluster for a meaningful number (not over VPN).
"""
import argparse
import json
import os
import sys
import time

from confluent_kafka import Producer

TARGET_MSG_PER_SEC = 10_000


def build_producer() -> Producer:
    conf = {
        "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP"],
        "client.id": "facis-perf-producer",
        # Throughput-oriented batching (mirrors the repo's rdkafka settings).
        "linger.ms": 20,
        "batch.num.messages": 10_000,
        "queue.buffering.max.messages": 1_000_000,
        "compression.type": "lz4",
        "acks": "1",
    }
    ca = os.environ.get("KAFKA_SSL_CA")
    if ca:
        conf.update({
            "security.protocol": "ssl",
            "ssl.ca.location": ca,
            "ssl.certificate.location": os.environ["KAFKA_SSL_CERT"],
            "ssl.key.location": os.environ["KAFKA_SSL_KEY"],
        })
    else:
        conf["security.protocol"] = "plaintext"
    return Producer(conf)


def run(topic: str, duration_s: float, payload_bytes: int) -> dict:
    producer = build_producer()
    payload = b"x" * payload_bytes
    delivered = 0
    errors = 0

    def on_delivery(err, _msg):
        nonlocal delivered, errors
        if err is not None:
            errors += 1
        else:
            delivered += 1

    start = time.monotonic()
    deadline = start + duration_s
    produced = 0
    while time.monotonic() < deadline:
        try:
            producer.produce(topic, value=payload, on_delivery=on_delivery)
            produced += 1
        except BufferError:
            producer.poll(0)
            continue
        if produced % 10_000 == 0:
            producer.poll(0)
    producer.flush(30)
    elapsed = time.monotonic() - start

    rate = delivered / elapsed if elapsed > 0 else 0.0
    return {
        "test": "kafka-throughput",
        "qa_test": 19,
        "threshold": f">= {TARGET_MSG_PER_SEC} msg/s",
        "topic": topic,
        "duration_s": round(elapsed, 3),
        "messages_delivered": delivered,
        "delivery_errors": errors,
        "payload_bytes": payload_bytes,
        "achieved_msg_per_sec": round(rate, 1),
        "passed": rate >= TARGET_MSG_PER_SEC and errors == 0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", default=os.environ.get("KAFKA_PERF_TOPIC", "perf.throughput.test"))
    ap.add_argument("--duration", type=float, default=float(os.environ.get("PERF_KAFKA_DURATION", "30")))
    ap.add_argument("--payload-bytes", type=int, default=256)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    result = run(args.topic, args.duration, args.payload_bytes)
    text = json.dumps(result, indent=2)
    print(text)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text + "\n")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
