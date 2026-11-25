"""Check against a live Trino: the silver load is exactly-once per Kafka message.

Creates and drops the throwaway tables bronze.zz_t and silver.zz_t, and covers a
duplicate in bronze, a re-run, the replay of an old offset and a late row.

Usage: python infrastructure/lakehouse/check_silver_merge.py --env-file .env.cluster
"""

import argparse

import materialize_silver as m
from setup_lakehouse import AuthRefreshingSession, execute, resolve_credentials

ap = argparse.ArgumentParser()
ap.add_argument("--env-file", default=None)
ap.add_argument("--catalog", default=None)
ap.add_argument("--s3-bucket", default=None)
user, password, secret, keycloak, host, port, cat, _ = resolve_credentials(ap.parse_args())
conn = AuthRefreshingSession(host, port, cat, keycloak, user, password, secret)

BRONZE, SILVER = f'"{cat}".bronze.zz_t', f'"{cat}".silver.zz_t'
OLD = "current_timestamp - INTERVAL '5' DAY"
m.SILVER_VIEWS["zz_t"] = (
    'CREATE OR REPLACE VIEW "{catalog}".silver.zz_t AS\nSELECT\n    ingestion_timestamp,\n'
    "    json_extract_scalar(raw_value, '$.v') AS v,\n    message_key,\n    kafka_topic,\n"
    '    kafka_partition,\n    kafka_offset\nFROM "{catalog}".bronze.zz_t\n'
    "WHERE json_extract_scalar(raw_value, '$.v') IS NOT NULL\n"
)


def drop_tables() -> None:
    for table in (BRONZE, SILVER):
        execute(conn, f"DROP TABLE IF EXISTS {table}")


def insert(offset: int, ts: str) -> None:
    value = f'{{"v":"{offset}"}}'
    execute(conn, f"INSERT INTO {BRONZE} VALUES ({ts}, 'top', 0, {offset}, 'k', '{value}')")


def load_and_expect(rows: int, label: str, full_refresh: bool = False) -> None:
    assert m.materialize_table(conn, cat, "zz_t", full_refresh, False)
    got = execute(conn, f"SELECT count(*), count(DISTINCT kafka_offset) FROM {SILVER}")[0]
    assert got == [rows, rows], (label, got)
    print(f"{label}: {got}")


drop_tables()
execute(
    conn,
    f"CREATE TABLE {BRONZE} (ingestion_timestamp TIMESTAMP(6) WITH TIME ZONE, "
    "kafka_topic VARCHAR, kafka_partition INTEGER, kafka_offset BIGINT, "
    "message_key VARCHAR, raw_value VARCHAR)",
)
execute(
    conn,
    f"CREATE TABLE {SILVER} (ingestion_timestamp TIMESTAMP(6) WITH TIME ZONE, v VARCHAR, "
    "message_key VARCHAR) "
    "WITH (format = 'PARQUET', partitioning = ARRAY['day(ingestion_timestamp)'])",
)
for offset in (1, 2, 3):
    insert(offset, OLD)
insert(2, "current_timestamp - INTERVAL '4' DAY")  # duplicate in bronze
load_and_expect(3, "full refresh dedupes", full_refresh=True)
insert(4, "current_timestamp")
insert(1, "current_timestamp")  # replay of an old offset
load_and_expect(4, "incremental + old replay")
load_and_expect(4, "re-run is a no-op")
insert(5, "current_timestamp - INTERVAL '6' HOUR")  # committed late, older than newest silver row
load_and_expect(5, "late row inside look-back is loaded")
drop_tables()
print("ALL CHECKS PASSED")
