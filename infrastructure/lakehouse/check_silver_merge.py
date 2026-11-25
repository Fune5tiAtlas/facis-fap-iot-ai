"""Check against a live Trino: the silver load is exactly-once per Kafka message.

Creates and drops the throwaway tables bronze.zz_t and silver.zz_t, and covers a
duplicate in bronze, a re-run, and the replay of an old offset.

Usage: python infrastructure/lakehouse/check_silver_merge.py --env-file .env.cluster
"""
import argparse

import materialize_silver as m
from setup_lakehouse import AuthRefreshingSession, resolve_credentials, execute

ap = argparse.ArgumentParser()
ap.add_argument("--env-file", default=None)
ap.add_argument("--catalog", default=None)
ap.add_argument("--s3-bucket", default=None)
a = ap.parse_args()
u, p, cs, kc, host, port, cat, bucket = resolve_credentials(a)
conn = AuthRefreshingSession(host, port, cat, kc, u, p, cs)
B, T = f'"{cat}".bronze.zz_t', f'"{cat}".silver.zz_t'
m.SILVER_VIEWS["zz_t"] = (
    'CREATE OR REPLACE VIEW "{catalog}".silver.zz_t AS\nSELECT\n    ingestion_timestamp,\n'
    "    json_extract_scalar(raw_value, '$.v') AS v,\n    message_key,\n    kafka_topic,\n"
    '    kafka_partition,\n    kafka_offset\nFROM "{catalog}".bronze.zz_t\n'
    "WHERE json_extract_scalar(raw_value, '$.v') IS NOT NULL\n")
for t in (B, T): execute(conn, f"DROP TABLE IF EXISTS {t}")
execute(conn, f"CREATE TABLE {B} (ingestion_timestamp TIMESTAMP(6) WITH TIME ZONE, kafka_topic VARCHAR, "
              "kafka_partition INTEGER, kafka_offset BIGINT, message_key VARCHAR, raw_value VARCHAR)")
execute(conn, f"CREATE TABLE {T} (ingestion_timestamp TIMESTAMP(6) WITH TIME ZONE, v VARCHAR, message_key VARCHAR) "
              "WITH (format = 'PARQUET', partitioning = ARRAY['day(ingestion_timestamp)'])")
ins = lambda off, ts: execute(conn, f"INSERT INTO {B} VALUES ({ts}, 'top', 0, {off}, 'k', '{{\"v\":\"{off}\"}}')")
count = lambda: execute(conn, f"SELECT count(*), count(DISTINCT kafka_offset) FROM {T}")[0]
OLD = "current_timestamp - INTERVAL '5' DAY"
for off in (1, 2, 3): ins(off, OLD)
ins(2, "current_timestamp - INTERVAL '4' DAY")                      # duplicate in bronze
assert m.materialize_table(conn, cat, "zz_t", True, False)
assert count() == [3, 3], count(); print("full refresh dedupes:", count())
ins(4, "current_timestamp"); ins(1, "current_timestamp")            # new row + replay of an OLD offset
assert m.materialize_table(conn, cat, "zz_t", False, False)
assert count() == [4, 4], count(); print("incremental + old replay:", count())
assert m.materialize_table(conn, cat, "zz_t", False, False)
assert count() == [4, 4], count(); print("re-run is a no-op:", count())
ins(5, "current_timestamp - INTERVAL '6' HOUR")                     # committed late, older than newest silver row
assert m.materialize_table(conn, cat, "zz_t", False, False)
assert count() == [5, 5], count(); print("late row inside look-back is loaded:", count())
print("props:", [r for r in execute(conn, f'SELECT * FROM "{cat}".silver."zz_t$properties"') if "metadata" in r[0]])
for t in (B, T): execute(conn, f"DROP TABLE IF EXISTS {t}")
print("ALL CHECKS PASSED")
