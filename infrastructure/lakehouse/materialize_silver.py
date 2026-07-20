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
    execute_ddl,
    load_env_file,
    resolve_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("materialize_silver")

# ---------------------------------------------------------------------------
# Watermark management
# ---------------------------------------------------------------------------

WATERMARK_TABLE = "_watermarks"

WATERMARK_DDL = """
CREATE TABLE IF NOT EXISTS "{catalog}".silver._watermarks (
    table_name       VARCHAR,
    last_watermark   TIMESTAMP(6) WITH TIME ZONE,
    updated_at       TIMESTAMP(6) WITH TIME ZONE
)
WITH (format = 'PARQUET', location = '{location}')
"""


def ensure_watermark_table(conn, catalog: str, s3_bucket: str) -> None:
    location = f"s3a://{s3_bucket}/warehouse/silver.db/{WATERMARK_TABLE}"
    sql = WATERMARK_DDL.format(catalog=catalog, location=location)
    execute_ddl(conn, sql, "silver._watermarks table")


def get_watermark(conn, catalog: str, table_name: str) -> str | None:
    """Return the most recently recorded watermark timestamp for a table,
    or None.  We pick the row with the latest `updated_at` because the
    table is append-only (see update_watermark below) — multiple rows may
    exist per table_name, oldest first."""
    # table_name comes from the hardcoded SILVER_VIEWS dict — validated.
    # Trino's python client does not support ? placeholder substitution
    # against this Trino version, so we inline the validated identifier.
    if table_name not in SILVER_VIEWS:
        raise ValueError(f"Invalid table name: {table_name}")
    rows = execute(
        conn,
        f'SELECT last_watermark FROM "{catalog}".silver._watermarks'
        f" WHERE table_name = '{table_name}'"
        f" ORDER BY updated_at DESC LIMIT 1",
    )
    if rows and rows[0][0]:
        return str(rows[0][0])
    return None


def update_watermark(conn, catalog: str, table_name: str) -> None:
    """Set the watermark to the max ingestion_timestamp in the Silver table."""
    if table_name not in SILVER_VIEWS:
        raise ValueError(f"Invalid table name: {table_name}")
    rows = execute(
        conn,
        f'SELECT MAX(ingestion_timestamp) FROM "{catalog}".silver.{table_name}',
    )
    if not rows or not rows[0][0]:
        return
    max_ts = str(rows[0][0])

    # Append a new watermark row.  We deliberately DO NOT delete previous
    # rows for this table_name: Iceberg's DELETE + INSERT in two separate
    # statements creates a race where the INSERT's commit conflicts with
    # the DELETE's positional-delete file (ICEBERG_COMMIT_ERROR: "Found
    # new conflicting delete files that can apply to records matching
    # ref(name=\"table_name\")...", observed 2026-05-05 on a backlog
    # catch-up run).  Append-only sidesteps the race entirely; get_watermark
    # picks the latest row via ORDER BY updated_at DESC LIMIT 1.  At
    # 9 tables × every 10 minutes = ~50k rows/year — trivially small.
    # table_name is validated against SILVER_VIEWS; max_ts is a TIMESTAMP
    # literal from Trino's MAX().
    execute(
        conn,
        f'INSERT INTO "{catalog}".silver._watermarks'
        f" VALUES ('{table_name}', TIMESTAMP '{max_ts}', CURRENT_TIMESTAMP)",
    )
    logger.info("  Watermark for %s updated to %s", table_name, max_ts)


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


def build_insert_sql(catalog: str, table: str, watermark: str | None) -> str:
    """Build INSERT INTO silver.<table> SELECT … FROM bronze.<table>."""
    view_sql = SILVER_VIEWS[table].format(catalog=catalog)
    select_sql = _extract_select(view_sql)

    # Add watermark filter for incremental load
    # NOTE: watermark comes from our own Trino watermark table (trusted internal value),
    # and table comes from the hardcoded SILVER_VIEWS dict.  Trino does not support
    # parameterized DDL identifiers, so table names are validated against SILVER_VIEWS.
    if watermark:
        # Append to existing WHERE clause
        select_sql = select_sql.rstrip().rstrip(";")
        select_sql += f"\n  AND ingestion_timestamp > TIMESTAMP '{watermark}'"

    return f'INSERT INTO "{catalog}".silver.{table}\n{select_sql}'


# ---------------------------------------------------------------------------
# Main materialization
# ---------------------------------------------------------------------------


def materialize_table(
    conn, catalog: str, table: str, full_refresh: bool, dry_run: bool
) -> bool:
    """Materialize a single Silver table. Returns True on success."""
    watermark = None if full_refresh else get_watermark(conn, catalog, table)

    if watermark:
        logger.info(f"  {table}: incremental from {watermark}")
    else:
        logger.info(f"  {table}: full refresh")

    sql = build_insert_sql(catalog, table, watermark)

    if dry_run:
        print(f"\n-- DRY RUN: {table}")
        print(sql)
        print()
        return True

    # For full refresh, delete existing data first
    if full_refresh:
        execute_ddl(conn, f'DELETE FROM "{catalog}".silver.{table} WHERE true', f"truncate silver.{table}")

    try:
        t0 = time.time()
        rows = execute(conn, sql)
        elapsed = time.time() - t0
        logger.info(f"  OK: silver.{table} — {elapsed:.1f}s")
    except Exception as e:
        logger.error(f"  FAIL: silver.{table} — {e}")
        return False

    # Update watermark
    if not dry_run:
        update_watermark(conn, catalog, table)

    return True


def materialize_all(
    conn, catalog: str, s3_bucket: str, tables: list[str] | None,
    full_refresh: bool, dry_run: bool,
) -> None:
    """Materialize Silver tables."""
    ensure_watermark_table(conn, catalog, s3_bucket)

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
    print("  Incremental INSERT INTO silver.* FROM bronze.*")
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
