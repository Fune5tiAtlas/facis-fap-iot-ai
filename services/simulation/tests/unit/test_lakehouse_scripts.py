"""Unit tests for the lakehouse batch scripts in infrastructure/lakehouse.

No Trino connection is used: the scripts are driven through a fake connection
that records the SQL it is given and returns canned rows.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

LAKEHOUSE_DIR = Path(__file__).resolve().parents[4] / "infrastructure" / "lakehouse"
SCRIPTS = (
    "setup_lakehouse",
    "materialize_silver",
    "materialize_gold",
    "maintain_lakehouse",
)
KAFKA_COLUMNS = ("kafka_topic", "kafka_partition", "kafka_offset")
SINCE = "2026-01-02 03:04:05.000000 UTC"
GOOD_PROPS = [
    ["write.metadata.delete-after-commit.enabled", "true"],
    ["write.metadata.previous-versions-max", "10"],
]


@pytest.fixture(scope="module")
def scripts():
    """The lakehouse scripts, importable without the `lakehouse` extra installed."""
    patch = pytest.MonkeyPatch()
    for name in ("urllib3", "requests", "trino", "tabulate"):
        try:
            importlib.import_module(name)
        except ImportError:
            # only the Trino connection needs these; building SQL does not
            patch.setitem(sys.modules, name, MagicMock())
    patch.syspath_prepend(str(LAKEHOUSE_DIR))
    for name in SCRIPTS:
        patch.delitem(sys.modules, name, raising=False)
    yield {name: importlib.import_module(name) for name in SCRIPTS}
    patch.undo()


@pytest.fixture
def silver(scripts):
    return scripts["materialize_silver"]


@pytest.fixture
def maintenance(scripts, monkeypatch):
    module = scripts["maintain_lakehouse"]
    monkeypatch.setattr(module, "RETRY_WAIT_SECONDS", 0)
    return module


class FakeTrino:
    """Records every statement; `answer(sql)` returns rows or raises."""

    def __init__(self, answer):
        self.answer = answer
        self.statements: list[str] = []

    def cursor(self):
        return self

    def execute(self, sql, params=None):
        self.statements.append(sql)
        self.rows = self.answer(sql)
        return self.rows

    def fetchall(self):
        return self.rows


# ---------------------------------------------------------------------------
# Silver: each Kafka message exactly once
# ---------------------------------------------------------------------------


def test_every_silver_view_carries_the_kafka_coordinates(silver) -> None:
    assert silver.SILVER_VIEWS
    for table, view_sql in silver.SILVER_VIEWS.items():
        for column in KAFKA_COLUMNS:
            assert f"\n    {column}" in view_sql, f"silver.{table} lacks {column}"


def test_full_refresh_reads_bronze_once_through_the_dedupe_subquery(silver) -> None:
    for table in silver.SILVER_VIEWS:
        sql = silver.build_select_sql("cat", table, None)
        assert sql.count(f'"cat".bronze.{table}') == 1
        assert "PARTITION BY kafka_topic, kafka_partition, kafka_offset" in sql
        assert ") WHERE rn = 1)" in sql
        assert "INTERVAL '1' DAY" not in sql


def test_rows_without_full_kafka_coordinates_are_left_out(silver) -> None:
    # A NULL never equals itself in the MERGE key, so such a row would be re-inserted.
    sql = silver.build_select_sql("cat", "energy_meter", None)
    for column in KAFKA_COLUMNS:
        assert f"{column} IS NOT NULL" in sql


def test_incremental_scan_looks_back_one_day_from_the_newest_silver_row(silver) -> None:
    for table in silver.SILVER_VIEWS:
        sql = silver.build_select_sql("cat", table, SINCE)
        assert (
            f"AND ingestion_timestamp > TIMESTAMP '{SINCE}' - INTERVAL '1' DAY" in sql
        )
        assert sql.count("ROW_NUMBER()") == 1


def test_a_view_without_a_single_bronze_source_is_rejected(silver, monkeypatch) -> None:
    monkeypatch.setitem(
        silver.SILVER_VIEWS,
        "zz_bad",
        'CREATE OR REPLACE VIEW "{catalog}".silver.zz_bad AS\nSELECT 1 AS x\nFROM other\n',
    )
    with pytest.raises(ValueError, match="exactly one bronze source"):
        silver.build_select_sql("cat", "zz_bad", None)


def test_incremental_run_is_one_insert_only_merge_on_the_kafka_key(silver) -> None:
    def answer(sql):
        if "MAX(ingestion_timestamp)" in sql:
            return [[SINCE]]
        if "information_schema.columns" in sql:
            return [["event_timestamp"], *([c] for c in KAFKA_COLUMNS)]
        return []

    conn = FakeTrino(answer)
    assert silver.materialize_table(conn, "cat", "energy_meter", False, False)

    writes = [s for s in conn.statements if not s.startswith("SELECT")]
    assert len(writes) == 1
    merge = writes[0]
    assert merge.startswith('MERGE INTO "cat".silver.energy_meter t')
    assert (
        "ON t.kafka_topic = s.kafka_topic AND t.kafka_partition = s.kafka_partition"
        " AND t.kafka_offset = s.kafka_offset\n" in merge
    )
    assert "WHEN NOT MATCHED THEN INSERT (event_timestamp, kafka_topic" in merge
    assert "WHEN MATCHED" not in merge
    # the target side must stay unbounded so a replayed old offset still matches
    assert "t.ingestion_timestamp" not in merge


@pytest.mark.parametrize("full_refresh, newest", [(True, SINCE), (False, None)])
def test_full_refresh_or_empty_table_is_one_atomic_replace(
    silver, full_refresh, newest
) -> None:
    def answer(sql):
        if "MAX(ingestion_timestamp)" in sql:
            return [[newest]]
        if sql.startswith("SHOW CREATE TABLE"):
            return [
                ["CREATE TABLE x (\n   a varchar\n)\nWITH (\n   format = 'PARQUET'\n)"]
            ]
        return []

    conn = FakeTrino(answer)
    assert silver.materialize_table(conn, "cat", "energy_meter", full_refresh, False)

    writes = [s for s in conn.statements if s.startswith(("CREATE", "MERGE", "DELETE"))]
    assert len(writes) == 1
    assert writes[0].startswith('CREATE OR REPLACE TABLE "cat".silver.energy_meter\n')
    assert "format = 'PARQUET'" in writes[0]
    assert "write.metadata.delete-after-commit.enabled" in writes[0]
    assert "write.metadata.previous-versions-max" in writes[0]


def test_a_failed_statement_is_reported_not_raised(silver) -> None:
    def answer(sql):
        raise RuntimeError("coordinator unavailable")

    assert (
        silver.materialize_table(FakeTrino(answer), "cat", "energy_meter", False, False)
        is False
    )


# ---------------------------------------------------------------------------
# Gold: atomic refresh, no refresh from a failed input
# ---------------------------------------------------------------------------


def test_gold_refresh_is_one_atomic_replace(scripts) -> None:
    gold = scripts["materialize_gold"]

    def answer(sql):
        if sql.startswith("SHOW CREATE TABLE"):
            return [
                ["CREATE TABLE x (\n   a varchar\n)\nWITH (\n   format = 'PARQUET'\n)"]
            ]
        return []

    conn = FakeTrino(answer)
    gold.refresh_gold_table(conn, "cat", "net_grid_hourly", "bucket", False)

    writes = [s for s in conn.statements if not s.startswith("SHOW")]
    assert len(writes) == 1
    assert writes[0].startswith('CREATE OR REPLACE TABLE "cat".gold.net_grid_hourly\n')
    assert not any(s.startswith(("DELETE", "INSERT")) for s in conn.statements)


def test_gold_table_is_skipped_when_a_gold_table_it_reads_failed(
    scripts, monkeypatch
) -> None:
    gold = scripts["materialize_gold"]
    monkeypatch.setattr(
        gold,
        "GOLD_VIEWS",
        {
            "base": 'SELECT 1 FROM "{catalog}".silver.x',
            "derived": 'SELECT 1 FROM "c".gold.base',
        },
    )
    attempted: list[str] = []

    def fail_base(conn, catalog, table, bucket, dry_run):
        attempted.append(table)
        return table != "base"

    monkeypatch.setattr(gold, "materialize_table", fail_base)
    with pytest.raises(SystemExit):
        gold.materialize_all(None, "c", "bucket", ["base", "derived"], False)
    assert attempted == ["base"]


# ---------------------------------------------------------------------------
# Maintenance: bounded metadata, failures surface, one bad table does not stop the rest
# ---------------------------------------------------------------------------


def healthy(sql, props=GOOD_PROPS, snapshots=5):
    if "$properties" in sql:
        return props
    if "$snapshots" in sql:
        return [[snapshots]]
    return []


def test_maintenance_runs_expiry_and_compaction_but_never_orphan_removal(
    maintenance,
) -> None:
    conn = FakeTrino(healthy)
    assert maintenance.maintain(conn, "cat", "bronze", "energy_meter")

    alters = [s for s in conn.statements if s.startswith("ALTER")]
    assert [s.split(" EXECUTE ")[1] for s in alters] == [
        "expire_snapshots(retention_threshold => '1d')",
        "optimize",
        "optimize_manifests",
    ]
    assert not any("remove_orphan_files" in s for s in conn.statements)


@pytest.mark.parametrize(
    "props",
    [
        [],
        [["write.metadata.delete-after-commit.enabled", "true"]],
        [
            ["write.metadata.delete-after-commit.enabled", "false"],
            ["write.metadata.previous-versions-max", "10"],
        ],
    ],
)
def test_missing_or_wrong_metadata_properties_are_repaired(maintenance, props) -> None:
    conn = FakeTrino(lambda sql: healthy(sql, props=props))
    assert maintenance.maintain(conn, "cat", "silver", "weather")
    assert sum("SET PROPERTIES" in s for s in conn.statements) == 1


def test_correct_metadata_properties_are_left_alone(maintenance) -> None:
    conn = FakeTrino(healthy)
    maintenance.maintain(conn, "cat", "silver", "weather")
    assert not any("SET PROPERTIES" in s for s in conn.statements)


def test_too_many_snapshots_fails_the_table(maintenance) -> None:
    limit = maintenance.MAX_SNAPSHOTS
    assert maintenance.maintain(
        FakeTrino(lambda s: healthy(s, snapshots=limit)), "c", "gold", "t"
    )
    over = FakeTrino(lambda s: healthy(s, snapshots=limit + 1))
    assert maintenance.maintain(over, "c", "gold", "t") is False


def test_a_statement_is_retried_and_a_lasting_failure_fails_the_table(
    maintenance,
) -> None:
    calls = {"optimize": 0}

    def flaky(sql):
        if sql.endswith("EXECUTE optimize"):
            calls["optimize"] += 1
            if calls["optimize"] < 3:
                raise RuntimeError("commit conflict")
        return healthy(sql)

    assert maintenance.maintain(FakeTrino(flaky), "c", "gold", "t")
    assert calls["optimize"] == 3

    def broken(sql):
        if sql.endswith("EXECUTE optimize"):
            raise RuntimeError("still failing")
        return healthy(sql)

    assert maintenance.maintain(FakeTrino(broken), "c", "gold", "t") is False


def test_an_unreadable_table_fails_without_stopping_the_run(
    maintenance, monkeypatch
) -> None:
    def answer(sql):
        if "information_schema.tables" in sql:
            return [["bad"], ["good"]] if "'gold'" in sql else []
        if '"bad$properties"' in sql:
            raise RuntimeError("metadata unreadable")
        return healthy(sql)

    conn = FakeTrino(answer)
    monkeypatch.setattr(
        maintenance, "resolve_credentials", lambda args: ("",) * 6 + ("cat", "")
    )
    monkeypatch.setattr(maintenance, "AuthRefreshingSession", lambda *a: conn)
    monkeypatch.setattr(sys, "argv", ["maintain_lakehouse.py"])

    assert maintenance.main() == 1
    assert any("gold.good EXECUTE optimize" in s for s in conn.statements)
