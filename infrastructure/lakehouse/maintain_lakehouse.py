"""Lakehouse maintenance — Iceberg compaction (NF-9, audit 2026-07-24).

The ingest pattern writes many tiny files (NiFi single-row PutSQL to bronze;
silver refresh every 10 min appends a small file each run), and nothing ever
compacted them — so gold tables reached ~5,000 data files each and Trino query
p95 blew past the QA thresholds (#20 <1000 ms, FR-AI-001 <500 ms).

This job runs on a schedule and, for every silver + gold table:
  * EXECUTE optimize            -> rewrites small data files into few large ones
  * EXECUTE optimize_manifests  -> compacts the manifest list (query planning)
Both are safe, online, and need no special catalog config.

Snapshot/orphan expiry (which reclaims the *old* files and shrinks metadata
history further) is gated behind LAKEHOUSE_EXPIRE_SNAPSHOTS=true because Trino
rejects a retention below `iceberg.expire-snapshots.min-retention` (default 7d);
lower that catalog property first (see the NF-9 runbook), then enable it here.

Usage: python maintain_lakehouse.py --env-file /config/.env
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

from setup_lakehouse import (  # shared connection + table registries
    SILVER_VIEWS,
    GOLD_VIEWS,
    AuthRefreshingSession,
    resolve_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# retention_threshold is only accepted once the catalog's min-retention is lowered.
EXPIRE = os.environ.get("LAKEHOUSE_EXPIRE_SNAPSHOTS", "false").lower() == "true"
RETENTION = os.environ.get("LAKEHOUSE_RETENTION_THRESHOLD", "7d")


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=None)
    ap.add_argument("--schemas", default="silver,gold", help="comma list of schemas to maintain")
    return ap.parse_args()


def maintain(conn, catalog: str, schema: str, table: str) -> bool:
    procs = ['EXECUTE optimize', 'EXECUTE optimize_manifests']
    if EXPIRE:
        procs += [
            f"EXECUTE expire_snapshots(retention_threshold => '{RETENTION}')",
            f"EXECUTE remove_orphan_files(retention_threshold => '{RETENTION}')",
        ]
    ok = True
    for proc in procs:
        try:
            conn.execute(f'ALTER TABLE "{catalog}".{schema}.{table} {proc}')
        except Exception as exc:  # one failing proc must not abort the whole run
            ok = False
            logger.warning("  %s.%s %s failed: %s", schema, table, proc.split("(")[0], str(exc)[:120])
    return ok


def main() -> int:
    args = parse_args()
    username, password, client_secret, keycloak_url, trino_host, trino_port, catalog, _ = (
        resolve_credentials(args)
    )
    conn = AuthRefreshingSession(trino_host, trino_port, catalog, keycloak_url, username, password, client_secret)

    registries = {"silver": list(SILVER_VIEWS.keys()), "gold": list(GOLD_VIEWS.keys())}
    schemas = [s.strip() for s in args.schemas.split(",") if s.strip()]
    total, failed = 0, 0
    for schema in schemas:
        for table in registries.get(schema, []):
            total += 1
            if not maintain(conn, catalog, schema, table):
                failed += 1
            else:
                logger.info("  OK: compacted %s.%s", schema, table)
    logger.info("Maintenance done: %d/%d tables compacted (expire_snapshots=%s)", total - failed, total, EXPIRE)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
