"""BDD steps for the SFTP ingestion observability surface (NF-13).

Live scenarios against a deployed ORCE runtime; skipped when
FACIS_ORCE_BASE_URL is unset so the suite stays green on CI runners
without an ORCE backend.
"""
from __future__ import annotations

import os

import httpx
import pytest
from pytest_bdd import given, when, then, scenarios, parsers

ORCE_BASE_URL_ENV = "FACIS_ORCE_BASE_URL"

scenarios("../features/sftp_health.feature")


@pytest.fixture
def ctx() -> dict:
    return {}


@given("the SFTP ingestion flow is deployed on a reachable ORCE runtime")
def _deployed() -> str:
    base = os.environ.get(ORCE_BASE_URL_ENV)
    if not base:
        pytest.skip(f"{ORCE_BASE_URL_ENV} not set; skipping live SFTP BDD scenario")
    return base.rstrip("/")


@when(parsers.parse('I GET "{path}"'))
def _get(ctx: dict, _deployed: str, path: str) -> None:
    ctx["resp"] = httpx.get(f"{_deployed}{path}", timeout=10.0, verify=False)


@then(parsers.parse("the response status is {code:d}"))
def _status(ctx: dict, code: int) -> None:
    assert ctx["resp"].status_code == code, ctx["resp"].text


@then(parsers.parse('the JSON field "{field}" is present'))
def _json_field(ctx: dict, field: str) -> None:
    assert field in ctx["resp"].json()


@then(parsers.parse('the body contains "{needle}"'))
def _body_contains(ctx: dict, needle: str) -> None:
    assert needle in ctx["resp"].text
