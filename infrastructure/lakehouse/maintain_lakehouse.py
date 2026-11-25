"""Lakehouse maintenance — keeps every Iceberg table's metadata bounded.

Every commit adds a snapshot to a table's metadata.json and leaves the previous
metadata.json behind. With nothing expiring them, bronze tables reached ~290k
snapshots and 583 MB metadata files (tens of TB of old copies in S3), which is
what exhausted the Trino coordinator's heap in November 2026.

For EVERY table in bronze, silver and gold (discovered, not hard-coded):
  * metadata-retention table properties are set if missing
  * EXECUTE expire_snapshots     -> drops old snapshots (history only, never rows)
  * EXECUTE optimize             -> rewrites small data files into few large ones
  * EXECUTE optimize_manifests   -> compacts the manifest list (query planning)

The job exits non-zero if any step fails or a table still has more than
MAX_SNAPSHOTS afterwards, so a regression shows up as a failed Job.

Usage: python maintain_lakehouse.py --env-file /config/.env
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from setup_lakehouse import AuthRefreshingSession, resolve_credentials

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Snapshot history kept per schema. Nothing reads old snapshots; the floor is the
# longest reader/writer (query.max-run-time = 1h), not the commit cadence.
RETENTION = {"bronze": "1d", "silver": "7d", "gold": "7d"}
MAX_SNAPSHOTS = 20000
METADATA_PROPS = (
    "extra_properties = MAP(ARRAY['write.metadata.delete-after-commit.enabled', "
    "'write.metadata.previous-versions-max'], ARRAY['true', '10'])"
)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=None)
    # resolve_credentials() reads these too (mirrors the materializer parsers).
    ap.add_argument("--catalog", default=None)
    ap.add_argument("--s3-bucket", default=None)
    ap.add_argument("--schemas", default="bronze,silver,gold", help="comma list of schemas to maintain")
    return ap.parse_args()


def run(conn, sql: str) -> bool:
    # Commits are compare-and-set (no metastore lock): losing a race with a
    # concurrent writer is a normal, retryable failure.
    for attempt in range(3):
        try:
            conn.execute(sql)
            return True
        except Exception as exc:
            logger.warning("  attempt %d failed: %s :: %s", attempt + 1, sql[:90], str(exc)[:160])
            time.sleep(10)
    return False


def maintain(conn, catalog: str, schema: str, table: str) -> bool:
    target = f'"{catalog}".{schema}.{table}'
    keep = RETENTION[schema]
    ok = True
    props = conn.execute(f'SELECT key FROM "{catalog}".{schema}."{table}$properties"')
    if ["write.metadata.delete-after-commit.enabled"] not in [list(r) for r in props]:
        ok &= run(conn, f"ALTER TABLE {target} SET PROPERTIES {METADATA_PROPS}")
    # No remove_orphan_files here: on tables with ~1M objects it starved the
    # coordinator's health check (2026-11-25). expire_snapshots already deletes the
    # files of the snapshots it drops, so steady-state growth stays bounded without it.
    for proc in (
        f"expire_snapshots(retention_threshold => '{keep}')",
        "optimize",
        "optimize_manifests",
    ):
        ok &= run(conn, f"ALTER TABLE {target} EXECUTE {proc}")
    snapshots = conn.execute(f'SELECT count(*) FROM "{catalog}".{schema}."{table}$snapshots"')[0][0]
    if snapshots > MAX_SNAPSHOTS:
        logger.error("  %s.%s still has %d snapshots (limit %d)", schema, table, snapshots, MAX_SNAPSHOTS)
        ok = False
    logger.info("  %s %s.%s (%d snapshots)", "OK:" if ok else "FAILED:", schema, table, snapshots)
    return ok


def main() -> int:
    args = parse_args()
    username, password, client_secret, keycloak_url, trino_host, trino_port, catalog, _ = (
        resolve_credentials(args)
    )
    conn = AuthRefreshingSession(trino_host, trino_port, catalog, keycloak_url, username, password, client_secret)

    total, failed = 0, 0
    for schema in [s.strip() for s in args.schemas.split(",") if s.strip() in RETENTION]:
        tables = conn.execute(
            f'SELECT table_name FROM "{catalog}".information_schema.tables '
            f"WHERE table_schema = '{schema}' AND table_type = 'BASE TABLE' ORDER BY table_name"
        )
        for (table,) in [tuple(r) for r in tables]:
            total += 1
            failed += not maintain(conn, catalog, schema, table)
    logger.info("Maintenance done: %d/%d tables OK", total - failed, total)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
