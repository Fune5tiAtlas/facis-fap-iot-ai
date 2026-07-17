"""Integration round-trip test for GET /api/data/{asset_id}.

Signs a token independently with the same secret the app is configured with
(mirroring what dsp-connector's HTTP_PULL signing does), then drives the real
route end-to-end through TestClient: HMAC verification + PolicyEnforcer.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.rest.app import create_app
from src.security.hmac_signing import HmacSigner

_SECRET = "integration-test-hmac-secret"


@pytest.fixture()
def data_route_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("AI_INSIGHT_HMAC__SECRET", _SECRET)
    monkeypatch.setenv("AI_INSIGHT_HMAC__ENABLED", "true")
    monkeypatch.setenv("AI_INSIGHT_POLICY__ENABLED", "true")
    yield TestClient(create_app())


def _signed_params(
    *, asset_id: str, agreement_id: str = "agr-1", roles: str = "ai_insight_consumer"
) -> dict[str, str]:
    signer = HmacSigner(secret=_SECRET)
    result = signer.generate_signed_url(
        base_url="https://ai-insight.facis.cloud",
        path=f"/api/data/{asset_id}",
        from_ts="2026-01-01T00:00:00Z",
        to_ts="2026-01-02T00:00:00Z",
        agreement_id=agreement_id,
        roles=roles,
    )
    return {
        "token": result.token,
        "expiresAt": result.expiresAt,
        "from": "2026-01-01T00:00:00Z",
        "to": "2026-01-02T00:00:00Z",
        "agreementId": agreement_id,
        "roles": roles,
    }


def test_matching_claims_are_authorized(data_route_client: TestClient) -> None:
    params = _signed_params(asset_id="asset-1")
    response = data_route_client.get("/api/data/asset-1", params=params)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "authorized"
    assert body["asset_id"] == "asset-1"
    assert body["agreement_id"] == "agr-1"


def test_tampered_agreement_id_is_rejected(data_route_client: TestClient) -> None:
    params = _signed_params(asset_id="asset-1")
    params["agreementId"] = "agr-DIFFERENT"
    response = data_route_client.get("/api/data/asset-1", params=params)
    assert response.status_code == 403
    assert "Invalid or expired HMAC token" in response.json()["detail"]


def test_missing_required_role_is_denied_by_policy(
    data_route_client: TestClient,
) -> None:
    params = _signed_params(asset_id="asset-1", roles="some-other-role")
    response = data_route_client.get("/api/data/asset-1", params=params)
    assert response.status_code == 403
    assert response.json()["detail"] == "Missing required role"
