#!/usr/bin/env python3
"""
Materialize Gold Layer: Replace Gold VIEWS with Iceberg TABLES.

Drops Gold views, creates Gold Iceberg tables, and populates them with
the aggregated data from Silver tables.  Uses full-refresh on each run
because Gold aggregations (GROUP BY hour/day) are idempotent and cheap
once Silver is materialized.

Usage:
    # Full materialization (default)
    python infrastructure/lakehouse/materialize_gold.py --env-file .env.cluster

    # Single table only
    python infrastructure/lakehouse/materialize_gold.py --env-file .env.cluster --table net_grid_hourly

    # Dry run (show SQL without executing)
    python infrastructure/lakehouse/materialize_gold.py --env-file .env.cluster --dry-run

Prerequisites:
    pip install -e ".[lakehouse]"
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from setup_lakehouse import (
    DEFAULT_CATALOG,
    DEFAULT_S3_BUCKET,
    GOLD_VIEWS,
    AuthRefreshingSession,
    execute,
    execute_ddl,
    resolve_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("materialize_gold")

# ---------------------------------------------------------------------------
# Materialization order (respects dependencies)
# ---------------------------------------------------------------------------

GOLD_TABLE_ORDER = [
    # Phase 1: Simple aggregations from Silver (no Gold dependencies)
    "energy_balance_hourly",
    "pv_performance_hourly",
    "weather_hourly",
    "event_impact_daily",
    "streetlight_zone_hourly",
    # Phase 2: Depends on Gold tables from Phase 1
    "net_grid_hourly",
    # Phase 3: Complex joins from Silver (no Gold dependencies, but heavier)
    "energy_cost_daily",
    "pv_self_consumption_daily",
    # Phase 4: Additional views (lower priority for AI service)
    "traffic_pattern_hourly",
    "city_dashboard_summary",
    "device_utilization_daily",
    "anomaly_candidates",
]

# ---------------------------------------------------------------------------
# Gold table DDL
# ---------------------------------------------------------------------------


def _extract_select(view_sql: str) -> str:
    """Extract the SELECT portion from a CREATE OR REPLACE VIEW ... AS SELECT ..."""
    upper = view_sql.upper()
    for marker in (" AS\nSELECT", " AS SELECT"):
        idx = upper.find(marker)
        if idx != -1:
            return view_sql[idx + 4:]  # skip " AS\n" or " AS "
    raise ValueError(f"Cannot find SELECT in view SQL: {view_sql[:120]}...")


def _time_column(table_name: str) -> str:
    """Return the time/date column used for partitioning."""
    if table_name in ("energy_cost_daily",):
        return "cost_date"
    if table_name in ("pv_self_consumption_daily",):
        return "sc_date"
    if table_name in ("event_impact_daily",):
        return "event_date"
    if table_name in ("city_dashboard_summary",):
        return "summary_date"
    if table_name in ("device_utilization_daily",):
        return "util_date"
    # All hourly tables + anomaly_candidates use "hour" or "event_timestamp"
    if table_name == "anomaly_candidates":
        return "event_timestamp"
    return "hour"


def _partition_expr(table_name: str) -> str:
    """Return the Iceberg partitioning expression."""
    col = _time_column(table_name)
    return f"ARRAY['day({col})']"


# ---------------------------------------------------------------------------
# Core materialization
# ---------------------------------------------------------------------------


def drop_view_if_exists(conn, catalog: str, table_name: str, dry_run: bool) -> None:
    """Drop the Gold VIEW so we can create a TABLE with the same name."""
    sql = f'DROP VIEW IF EXISTS "{catalog}".gold.{table_name}'
    if dry_run:
        print(f"-- {sql}")
        return
    execute_ddl(conn, sql, f"drop view gold.{table_name}")


def create_gold_table(conn, catalog: str, table_name: str, s3_bucket: str, dry_run: bool) -> None:
    """Create Gold Iceberg TABLE using CREATE TABLE AS SELECT (CTAS)."""
    view_sql = GOLD_VIEWS[table_name].format(catalog=catalog)
    select_sql = _extract_select(view_sql)

    location = f"s3a://{s3_bucket}/warehouse/gold.db/{table_name}"
    partition = _partition_expr(table_name)

    sql = (
        f'CREATE TABLE IF NOT EXISTS "{catalog}".gold.{table_name}\n'
        f"WITH (\n"
        f"    format = 'PARQUET',\n"
        f"    partitioning = {partition},\n"
        f"    location = '{location}'\n"
        f")\n"
        f"AS\n{select_sql}"
    )

    if dry_run:
        print(f"\n-- CREATE TABLE gold.{table_name}")
        print(sql)
        return

    execute_ddl(conn, sql, f"create gold.{table_name}")


def refresh_gold_table(conn, catalog: str, table_name: str, s3_bucket: str, dry_run: bool) -> None:
    """Full refresh: DELETE all rows then INSERT INTO from Silver."""
    view_sql = GOLD_VIEWS[table_name].format(catalog=catalog)
    select_sql = _extract_select(view_sql)

    delete_sql = f'DELETE FROM "{catalog}".gold.{table_name} WHERE true'
    insert_sql = f'INSERT INTO "{catalog}".gold.{table_name}\n{select_sql}'

    if dry_run:
        print(f"\n-- REFRESH gold.{table_name}")
        print(delete_sql)
        print(insert_sql)
        return

    execute_ddl(conn, delete_sql, f"truncate gold.{table_name}")

    t0 = time.time()
    execute(conn, insert_sql)
    elapsed = time.time() - t0
    logger.info(f"  Refreshed gold.{table_name} in {elapsed:.1f}s")


def materialize_table(
    conn, catalog: str, table_name: str, s3_bucket: str, dry_run: bool
) -> bool:
    """Materialize a single Gold table. Returns True on success."""
    try:
        # Check if table already exists (as TABLE, not VIEW)
        rows = execute(
            conn,
            f"SELECT table_type FROM \"{catalog}\".information_schema.tables "
            f"WHERE table_schema = 'gold' AND table_name = '{table_name}'",
        )

        if rows:
            table_type = rows[0][0]
            if table_type == "VIEW":
                logger.info(f"  {table_name}: dropping VIEW, creating TABLE")
                drop_view_if_exists(conn, catalog, table_name, dry_run)
                create_gold_table(conn, catalog, table_name, s3_bucket, dry_run)
            else:
                # Table exists, do a full refresh
                logger.info(f"  {table_name}: refreshing existing TABLE")
                refresh_gold_table(conn, catalog, table_name, s3_bucket, dry_run)
        else:
            # Nothing exists, create fresh
            logger.info(f"  {table_name}: creating new TABLE")
            create_gold_table(conn, catalog, table_name, s3_bucket, dry_run)

        return True
    except Exception as e:
        logger.error(f"  FAIL: gold.{table_name} — {e}")
        return False


def materialize_all(
    conn, catalog: str, s3_bucket: str, tables: list[str] | None, dry_run: bool
) -> None:
    """Materialize Gold tables in dependency order."""
    target_tables = tables if tables else GOLD_TABLE_ORDER
    logger.info(f"Materializing {len(target_tables)} Gold tables...")

    ok = 0
    for table_name in target_tables:
        if table_name not in GOLD_VIEWS:
            logger.error(f"  Unknown table: {table_name}")
            continue
        if materialize_table(conn, catalog, table_name, s3_bucket, dry_run):
            ok += 1

    print(f"\n  Materialized {ok}/{len(target_tables)} Gold tables.")
    if ok < len(target_tables):
        print("  STATUS: SOME TABLES FAILED (check logs above)")
        sys.exit(1)
    else:
        print("  STATUS: ALL GOLD TABLES MATERIALIZED SUCCESSFULLY")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Materialize Gold Layer")
    parser.add_argument("--env-file", default=None, help="Path to .env.cluster credentials file")
    parser.add_argument("--catalog", default=None, help=f"Trino catalog (default: {DEFAULT_CATALOG})")
    parser.add_argument("--s3-bucket", default=None, help=f"S3 bucket (default: {DEFAULT_S3_BUCKET})")
    parser.add_argument("--table", action="append", dest="tables", help="Materialize specific table(s) only")
    parser.add_argument("--dry-run", action="store_true", help="Print SQL without executing")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    print()
    print("=" * 72)
    print("  Gold Layer Materialization")
    print("  Convert Gold VIEWS → Iceberg TABLES for fast queries")
    print("=" * 72)

    username, password, client_secret, keycloak_url, trino_host, trino_port, catalog, s3_bucket = (
        resolve_credentials(args)
    )

    # AuthRefreshingSession handles 401-on-token-expiry transparently. Gold
    # materialization touches 12 tables and can comfortably exceed the
    # 5-minute Keycloak token TTL on first deploy after a long stall.
    conn = AuthRefreshingSession(
        trino_host, trino_port, catalog,
        keycloak_url, username, password, client_secret,
    )

    materialize_all(conn, catalog, s3_bucket, args.tables, args.dry_run)


if __name__ == "__main__":
    main()
