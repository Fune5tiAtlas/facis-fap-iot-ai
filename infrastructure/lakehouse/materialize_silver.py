#!/usr/bin/env python3
"""
Materialize Silver Layer: Incremental INSERT INTO silver tables from Bronze.

Reads raw JSON from Bronze Iceberg tables, parses and types the data, and
inserts into pre-created Silver Iceberg tables.  Tracks per-table watermarks
so that only new Bronze rows are processed on each run.

Usage:
    # Incremental refresh (default — only new rows since last watermark)
    python infrastructure/lakehouse/materialize_silver.py --env-file .env.cluster

    # Full refresh (truncate + reload all data)
    python infrastructure/lakehouse/materialize_silver.py --env-file .env.cluster --full-refresh

    # Single table only
    python infrastructure/lakehouse/materialize_silver.py --env-file .env.cluster --table energy_meter

    # Dry run (show SQL without executing)
    python infrastructure/lakehouse/materialize_silver.py --env-file .env.cluster --dry-run

Prerequisites:
    pip install -e ".[lakehouse]"
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

# Reuse auth & connection helpers from setup_lakehouse
from setup_lakehouse import (
    DEFAULT_CATALOG,
    DEFAULT_S3_BUCKET,
    SILVER_VIEWS,
    AuthRefreshingSession,
    execute,
    load_env_file,
    resolve_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("materialize_silver")

# Old metadata.json copies are deleted on every commit (bounded metadata history).
METADATA_PROPS = (
    "extra_properties = MAP(ARRAY['write.metadata.delete-after-commit.enabled', "
    "'write.metadata.previous-versions-max'], ARRAY['true', '10'])"
)


def replace_table_sql(conn, catalog: str, schema: str, table: str, select_sql: str) -> str:
    """One atomic CREATE OR REPLACE TABLE ... AS, keeping the table's current
    format/location/partitioning (a replace resets table properties)."""
    ddl = execute(conn, f'SHOW CREATE TABLE "{catalog}".{schema}.{table}')[0][0]
    with_clause = ddl[ddl.rindex("WITH ("):].rstrip().rstrip(")").rstrip()
    return (
        f'CREATE OR REPLACE TABLE "{catalog}".{schema}.{table}\n'
        f"{with_clause},\n   {METADATA_PROPS}\n)\nAS\n{select_sql}"
    )


# ---------------------------------------------------------------------------
# Silver materialization queries
#
# Each entry extracts the SELECT body from the SILVER_VIEWS dict (which
# contains CREATE OR REPLACE VIEW … AS SELECT …).  We strip the CREATE
# VIEW prefix to get a pure SELECT that can be used in INSERT INTO.
# ---------------------------------------------------------------------------


def _extract_select(view_sql: str) -> str:
    """Extract the SELECT portion from a CREATE OR REPLACE VIEW … AS SELECT …"""
    marker = " AS\nSELECT"
    idx = view_sql.upper().find(" AS\nSELECT")
    if idx == -1:
        # Try alternate spacing
        marker = " AS SELECT"
        idx = view_sql.upper().find(" AS SELECT")
    if idx == -1:
        raise ValueError(f"Cannot find SELECT in view SQL: {view_sql[:120]}…")
    # Return from "SELECT" onwards
    return view_sql[idx + 4:]  # skip " AS\n" or " AS "


def build_select_sql(catalog: str, table: str, since: str | None) -> str:
    """SELECT for silver.<table> over bronze, each Kafka message exactly once.

    Bronze can hold a message twice: NiFi re-inserts a batch whose commit
    succeeded but was reported as failed. `since` limits the bronze scan to
    one day before the newest row already in silver (partition pruning)."""
    select_sql = _extract_select(SILVER_VIEWS[table].format(catalog=catalog)).rstrip().rstrip(";")
    bronze = f'FROM "{catalog}".bronze.{table}\n'
    if select_sql.count(bronze) != 1:
        raise ValueError(f"silver.{table}: expected exactly one bronze source")
    recent = ""
    if since:
        recent = f"\n      AND ingestion_timestamp > TIMESTAMP '{since}' - INTERVAL '1' DAY"
    dedup = (
        "FROM (SELECT * FROM (\n"
        "    SELECT b.*, ROW_NUMBER() OVER (\n"
        "        PARTITION BY kafka_topic, kafka_partition, kafka_offset"
        " ORDER BY ingestion_timestamp) AS rn\n"
        f'    FROM "{catalog}".bronze.{table} b\n'
        f"    WHERE kafka_offset IS NOT NULL{recent}\n"
        ") WHERE rn = 1)\n"
    )
    return select_sql.replace(bronze, dedup)


# ---------------------------------------------------------------------------
# Main materialization
# ---------------------------------------------------------------------------


def materialize_table(
    conn, catalog: str, table: str, full_refresh: bool, dry_run: bool
) -> bool:
    """Materialize a single Silver table in ONE atomic statement. Returns True on success."""
    target = f'"{catalog}".silver.{table}'
    try:
        since = None
        if not full_refresh:
            rows = execute(conn, f"SELECT MAX(ingestion_timestamp) FROM {target}")
            since = str(rows[0][0]) if rows and rows[0][0] else None
        select_sql = build_select_sql(catalog, table, since)

        if since:
            # Insert-only MERGE on the Kafka coordinates: re-runs and late or
            # replayed bronze rows can neither duplicate nor be skipped.
            logger.info(f"  {table}: merging bronze rows since {since} - 1 day")
            cols = [r[0] for r in execute(
                conn,
                f'SELECT column_name FROM "{catalog}".information_schema.columns '
                f"WHERE table_schema = 'silver' AND table_name = '{table}' "
                "ORDER BY ordinal_position",
            )]
            sql = (
                f"MERGE INTO {target} t\nUSING (\n{select_sql}\n) s\n"
                "ON t.kafka_topic = s.kafka_topic AND t.kafka_partition = s.kafka_partition"
                " AND t.kafka_offset = s.kafka_offset\n"
                f"WHEN NOT MATCHED THEN INSERT ({', '.join(cols)})\n"
                f"VALUES ({', '.join('s.' + c for c in cols)})"
            )
        else:
            logger.info(f"  {table}: full refresh")
            sql = replace_table_sql(conn, catalog, "silver", table, select_sql)

        if dry_run:
            print(f"\n-- DRY RUN: {table}")
            print(sql)
            print()
            return True

        t0 = time.time()
        execute(conn, sql)
        logger.info(f"  OK: silver.{table} — {time.time() - t0:.1f}s")
        return True
    except Exception as e:
        logger.error(f"  FAIL: silver.{table} — {e}")
        return False


def materialize_all(
    conn, catalog: str, s3_bucket: str, tables: list[str] | None,
    full_refresh: bool, dry_run: bool,
) -> None:
    """Materialize Silver tables."""
    target_tables = tables if tables else list(SILVER_VIEWS.keys())
    logger.info(f"Materializing {len(target_tables)} Silver tables...")

    ok = 0
    for table in target_tables:
        if table not in SILVER_VIEWS:
            logger.error(f"  Unknown table: {table} (available: {list(SILVER_VIEWS.keys())})")
            continue
        if materialize_table(conn, catalog, table, full_refresh, dry_run):
            ok += 1

    print(f"\n  Materialized {ok}/{len(target_tables)} Silver tables.")
    if ok < len(target_tables):
        print("  STATUS: SOME TABLES FAILED (check logs above)")
        sys.exit(1)
    else:
        print("  STATUS: ALL TABLES MATERIALIZED SUCCESSFULLY")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Materialize Silver Layer — Incremental Refresh")
    parser.add_argument("--env-file", default=None, help="Path to .env.cluster credentials file")
    parser.add_argument("--catalog", default=None, help=f"Trino catalog (default: {DEFAULT_CATALOG})")
    parser.add_argument("--s3-bucket", default=None, help=f"S3 bucket (default: {DEFAULT_S3_BUCKET})")
    parser.add_argument("--table", action="append", dest="tables", help="Materialize specific table(s) only")
    parser.add_argument("--full-refresh", action="store_true", help="Truncate and reload all data")
    parser.add_argument("--dry-run", action="store_true", help="Print SQL without executing")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    print()
    print("=" * 72)
    print("  Silver Layer Materialization")
    print("  Incremental MERGE INTO silver.* FROM bronze.*")
    print("=" * 72)

    username, password, client_secret, keycloak_url, trino_host, trino_port, catalog, s3_bucket = (
        resolve_credentials(args)
    )

    # AuthRefreshingSession handles 401-on-token-expiry transparently. Long
    # backlog catch-up runs (post-HMS-zombie outage 2026-05-02) commonly
    # exceed the 5-minute Keycloak token TTL; the session refreshes + retries.
    conn = AuthRefreshingSession(
        trino_host, trino_port, catalog,
        keycloak_url, username, password, client_secret,
    )

    materialize_all(conn, catalog, s3_bucket, args.tables, args.full_refresh, args.dry_run)


if __name__ == "__main__":
    main()
