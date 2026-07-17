"""Tests for DSP Connector — Transfer Process, Catalogue, and Negotiation.

Runs against the in-process FastAPI app by default. Set ``ORCE_BASE_URL`` to
also exercise the deployed ORCE flow (compatibilityMode=orce). When set, every
test runs twice — once against the Python reference, once against the live
ORCE Admin-API-deployed flows — and any divergence fails the suite.

Example::

    ORCE_BASE_URL=http://facis-orce.orce.svc.cluster.local:1880 pytest -v

Note: ORCE health/metrics paths are namespaced (`/api/v1/dsp/health`,
`/dsp/metrics`) to avoid colliding with the Simulation flow on the shared
ORCE pod. The ``client`` fixture rewrites those paths transparently when
``mode == "orce"``.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from src.main import create_app

_ORCE_PATH_REWRITES = {
    "/api/v1/health": "/api/v1/dsp/health",
    "/metrics": "/dsp/metrics",
}


class _OrceHttpClient:
    """Minimal TestClient-shaped wrapper around the live ORCE flow URL."""

    def __init__(self, base_url: str) -> None:
        self._client = httpx.Client(base_url=base_url, timeout=10.0)

    def _rewrite(self, path: str) -> str:
        return _ORCE_PATH_REWRITES.get(path, path)

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._client.get(self._rewrite(path), **kwargs)

    def post(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._client.post(self._rewrite(path), **kwargs)


def _client_modes() -> list[str]:
    modes = ["python"]
    if os.getenv("ORCE_BASE_URL"):
        modes.append("orce")
    return modes


@pytest.fixture(params=_client_modes())
def client(request: pytest.FixtureRequest):
    if request.param == "orce":
        return _OrceHttpClient(os.environ["ORCE_BASE_URL"])
    app = create_app()
    return TestClient(app)


class TestHealth:
    def test_health(self, client: TestClient) -> None:
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
        assert resp.json()["service"] == "dsp-connector"


class TestCatalogue:
    def test_catalogue_returns_datasets(self, client: TestClient) -> None:
        resp = client.post("/dsp/catalogue/request", json={})
        assert resp.status_code == 200
        data = resp.json()
        assert "datasets" in data
        assert len(data["datasets"]) > 0
        assert "id" in data["datasets"][0]
        assert "metadata" in data["datasets"][0]
        assert "offers" in data["datasets"][0]

    def test_catalogue_filter_by_asset_type(self, client: TestClient) -> None:
        resp = client.post(
            "/dsp/catalogue/request", json={"filter": {"assetType": "iot.timeseries"}}
        )
        assert resp.status_code == 200
        datasets = resp.json()["datasets"]
        assert all(d["metadata"]["assetType"] == "iot.timeseries" for d in datasets)

    def test_catalogue_filter_by_dataset_id(self, client: TestClient) -> None:
        resp = client.post(
            "/dsp/catalogue/request",
            json={"filter": {"datasetIds": ["dataset:facis:anomaly-candidates"]}},
        )
        assert resp.status_code == 200
        datasets = resp.json()["datasets"]
        assert len(datasets) == 1
        assert datasets[0]["id"] == "dataset:facis:anomaly-candidates"

    def test_catalogue_pagination(self, client: TestClient) -> None:
        resp = client.post(
            "/dsp/catalogue/request", json={"page": {"limit": 2, "cursor": None}}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["datasets"]) == 2
        assert data["nextCursor"] is not None


class TestTransferProcess:
    def test_create_transfer_returns_202(self, client: TestClient) -> None:
        resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test-001",
                "assetId": "dataset:facis:net-grid-hourly",
                "format": "http-pull",
                "parameters": {
                    "windowFrom": "2026-04-07T00:00:00Z",
                    "windowTo": "2026-04-07T23:59:59Z",
                },
            },
        )
        assert resp.status_code == 202
        data = resp.json()
        assert "transferId" in data
        assert data["transferId"].startswith("tp-")

    def test_get_completed_transfer_has_access_object(self, client: TestClient) -> None:
        # Create transfer
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test-002",
                "assetId": "dataset:facis:anomaly-candidates",
                "format": "http-pull",
                "parameters": {
                    "windowFrom": "2026-04-07T00:00:00Z",
                    "windowTo": "2026-04-07T23:59:59Z",
                },
            },
        )
        transfer_id = create_resp.json()["transferId"]

        # Get transfer
        get_resp = client.get(f"/dsp/transfers/{transfer_id}")
        assert get_resp.status_code == 200
        transfer = get_resp.json()
        assert transfer["state"] == "COMPLETED"
        assert transfer["access"] is not None
        assert "url" in transfer["access"]
        assert "token" in transfer["access"]
        assert "expiresAt" in transfer["access"]

    def test_access_url_contains_hmac_and_time_window(self, client: TestClient) -> None:
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test-003",
                "assetId": "dataset:facis:weather-hourly",
                "format": "http-pull",
                "parameters": {
                    "windowFrom": "2026-04-01T00:00:00Z",
                    "windowTo": "2026-04-07T00:00:00Z",
                },
            },
        )
        transfer_id = create_resp.json()["transferId"]

        get_resp = client.get(f"/dsp/transfers/{transfer_id}")
        access = get_resp.json()["access"]
        assert "from=" in access["url"]
        assert "to=" in access["url"]
        assert "token=" in access["url"]
        assert "agreementId=agr-test-003" in access["url"]
        assert "roles=" in access["url"]
        assert "weather-hourly" in access["url"]

    def test_access_url_percent_encodes_agreement_id_with_colon(
        self, client: TestClient
    ) -> None:
        # agreementId containing a colon must be percent-encoded before being
        # bound into both the canonical HMAC message and the URL query string
        # — an unencoded colon would be delimiter-ambiguous with the ':'
        # separators in "GET:{path}:{from}:{to}:{expires}:{agreementId}:{roles}".
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test:special",
                "assetId": "dataset:facis:weather-hourly",
                "format": "http-pull",
                "parameters": {
                    "windowFrom": "2026-04-01T00:00:00Z",
                    "windowTo": "2026-04-07T00:00:00Z",
                },
            },
        )
        assert create_resp.status_code == 202
        transfer_id = create_resp.json()["transferId"]

        get_resp = client.get(f"/dsp/transfers/{transfer_id}")
        assert get_resp.status_code == 200
        access = get_resp.json()["access"]
        assert "agreementId=agr-test%3Aspecial" in access["url"]
        assert "agreementId=agr-test:special" not in access["url"]

    def test_access_url_matches_encode_uri_component_for_divergent_chars(
        self, client: TestClient
    ) -> None:
        # Python's urllib.parse.quote() and JS's encodeURIComponent() disagree
        # on the default "safe" set: quote() leaves '/' unescaped but escapes
        # "!*'()"; encodeURIComponent does the exact opposite. The fix
        # (safe="!*'()") must reproduce encodeURIComponent's behavior: '/'
        # gets percent-encoded, and '(' / ')' are left literal.
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr/test(id)",
                "assetId": "dataset:facis:weather-hourly",
                "format": "http-pull",
                "parameters": {
                    "windowFrom": "2026-04-01T00:00:00Z",
                    "windowTo": "2026-04-07T00:00:00Z",
                },
            },
        )
        assert create_resp.status_code == 202
        transfer_id = create_resp.json()["transferId"]

        get_resp = client.get(f"/dsp/transfers/{transfer_id}")
        assert get_resp.status_code == 200
        access = get_resp.json()["access"]
        # '/' must be percent-encoded (matches encodeURIComponent, diverges
        # from quote()'s default safe='/')
        assert "agreementId=agr%2Ftest(id)" in access["url"]
        assert "agreementId=agr/test" not in access["url"]
        # '(' and ')' must stay literal (matches encodeURIComponent, diverges
        # from quote()'s default which would escape them to %28/%29)
        assert "%28" not in access["url"]
        assert "%29" not in access["url"]

    def test_kafka_streaming_transfer(self, client: TestClient) -> None:
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test-004",
                "assetId": "dataset:facis:net-grid-hourly",
                "format": "kafka-streaming",
            },
        )
        transfer_id = create_resp.json()["transferId"]

        get_resp = client.get(f"/dsp/transfers/{transfer_id}")
        transfer = get_resp.json()
        assert transfer["state"] == "COMPLETED"
        assert transfer["access"]["bootstrap"] is not None
        assert transfer["access"]["topic"] is not None
        assert transfer["access"]["sasl"] is not None
        assert transfer["access"]["sasl"]["mechanism"] == "SCRAM-SHA-256"

    def test_get_nonexistent_transfer_returns_404(self, client: TestClient) -> None:
        resp = client.get("/dsp/transfers/tp-nonexistent")
        assert resp.status_code == 404

    def test_terminate_transfer(self, client: TestClient) -> None:
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test-005",
                "assetId": "dataset:facis:net-grid-hourly",
                "format": "http-pull",
            },
        )
        transfer_id = create_resp.json()["transferId"]

        # Can't terminate a COMPLETED transfer
        term_resp = client.post(f"/dsp/transfers/{transfer_id}/terminate")
        assert term_resp.status_code == 400

    def test_error_state_includes_reason(self, client: TestClient) -> None:
        # This tests the reason field requirement — we verify it's present in the model
        create_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-test-006",
                "assetId": "dataset:facis:net-grid-hourly",
                "format": "http-pull",
            },
        )
        transfer_id = create_resp.json()["transferId"]

        get_resp = client.get(f"/dsp/transfers/{transfer_id}")
        transfer = get_resp.json()
        # Successful transfer has no reason
        assert transfer["reason"] is None
        # But the field exists in the response
        assert "reason" in transfer

    def test_list_transfers(self, client: TestClient) -> None:
        # Create two transfers
        client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-list-1",
                "assetId": "dataset:facis:net-grid-hourly",
                "format": "http-pull",
            },
        )
        client.post(
            "/dsp/transfers",
            json={
                "agreementId": "agr-list-2",
                "assetId": "dataset:facis:weather-hourly",
                "format": "http-pull",
            },
        )

        resp = client.get("/dsp/transfers")
        assert resp.status_code == 200
        assert len(resp.json()) >= 2


class TestNegotiation:
    def test_create_negotiation_auto_finalizes(self, client: TestClient) -> None:
        resp = client.post(
            "/dsp/negotiations",
            json={
                "counterparty": "did:web:consumer.example",
                "offerId": "offer:facis:net-grid-hourly:read",
            },
        )
        assert resp.status_code == 202
        assert "negotiationId" in resp.json()

    def test_get_negotiation_shows_finalized_with_agreement(
        self, client: TestClient
    ) -> None:
        create_resp = client.post(
            "/dsp/negotiations",
            json={
                "counterparty": "did:web:consumer.example",
                "offerId": "offer:facis:net-grid-hourly:read",
            },
        )
        neg_id = create_resp.json()["negotiationId"]

        get_resp = client.get(f"/dsp/negotiations/{neg_id}")
        assert get_resp.status_code == 200
        neg = get_resp.json()
        assert neg["state"] == "FINALIZED"
        assert neg["agreementId"] is not None

    def test_terminate_negotiation(self, client: TestClient) -> None:
        create_resp = client.post(
            "/dsp/negotiations",
            json={
                "counterparty": "did:web:consumer.example",
                "offerId": "offer:facis:net-grid-hourly:read",
            },
        )
        neg_id = create_resp.json()["negotiationId"]

        term_resp = client.post(f"/dsp/negotiations/{neg_id}/terminate")
        assert term_resp.status_code == 200
        assert term_resp.json()["state"] == "TERMINATED"


class TestE2EFlow:
    """End-to-end: Catalogue → Negotiation → Transfer → Access."""

    def test_full_dsp_flow(self, client: TestClient) -> None:
        # 1. Discover datasets
        cat_resp = client.post(
            "/dsp/catalogue/request", json={"filter": {"assetType": "iot.timeseries"}}
        )
        assert cat_resp.status_code == 200
        datasets = cat_resp.json()["datasets"]
        assert len(datasets) > 0
        offer_id = datasets[0]["offers"][0]["id"]
        asset_id = datasets[0]["id"]

        # 2. Negotiate (auto-finalizes)
        neg_resp = client.post(
            "/dsp/negotiations",
            json={
                "counterparty": "did:web:consumer.example",
                "offerId": offer_id,
            },
        )
        assert neg_resp.status_code == 202
        neg_id = neg_resp.json()["negotiationId"]

        # Get agreement ID
        neg_state = client.get(f"/dsp/negotiations/{neg_id}")
        agreement_id = neg_state.json()["agreementId"]
        assert agreement_id is not None

        # 3. Start transfer with agreement
        transfer_resp = client.post(
            "/dsp/transfers",
            json={
                "agreementId": agreement_id,
                "assetId": asset_id,
                "format": "http-pull",
                "parameters": {
                    "windowFrom": "2026-04-07T00:00:00Z",
                    "windowTo": "2026-04-07T23:59:59Z",
                },
            },
        )
        assert transfer_resp.status_code == 202
        transfer_id = transfer_resp.json()["transferId"]

        # 4. Get access object
        access_resp = client.get(f"/dsp/transfers/{transfer_id}")
        assert access_resp.status_code == 200
        transfer = access_resp.json()
        assert transfer["state"] == "COMPLETED"
        assert transfer["access"]["url"] is not None
        assert transfer["access"]["token"] is not None
        assert transfer["access"]["expiresAt"] is not None
