"""Unit tests for the SQL built by infrastructure/lakehouse/materialize_silver.py.

The silver load must put each Kafka message into silver exactly once. That rests on
two things checked here without a Trino connection: every silver view carries the
Kafka coordinates, and the loader reads bronze through one de-duplicating subquery.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

LAKEHOUSE_DIR = Path(__file__).resolve().parents[4] / "infrastructure" / "lakehouse"
KAFKA_COLUMNS = ("kafka_topic", "kafka_partition", "kafka_offset")
SINCE = "2026-01-02 03:04:05.000000 UTC"


@pytest.fixture(scope="module")
def silver():
    """materialize_silver, importable without the `lakehouse` extra installed."""
    patch = pytest.MonkeyPatch()
    for name in ("urllib3", "requests", "trino", "tabulate"):
        try:
            importlib.import_module(name)
        except ImportError:
            # only the Trino connection needs these; SQL building does not
            patch.setitem(sys.modules, name, MagicMock())
    patch.syspath_prepend(str(LAKEHOUSE_DIR))
    for name in ("setup_lakehouse", "materialize_silver"):
        patch.delitem(sys.modules, name, raising=False)
    yield importlib.import_module("materialize_silver")
    patch.undo()


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
        assert "WHERE kafka_offset IS NOT NULL\n" in sql
        assert "INTERVAL '1' DAY" not in sql


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
