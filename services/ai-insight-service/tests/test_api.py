"""API tests for insight endpoints."""

from types import SimpleNamespace

from src.api.rest.routes import insights
from src.storage.output_store import InMemoryOutputStore


class _FakePolicy:
    def build_context(self, headers):
        return insights.AccessContext(
            agreement_id=headers.get("x-agreement-id", ""),
            asset_id=headers.get("x-asset-id", ""),
            roles=tuple(headers.get("x-user-roles", "").split(",")),
        )

    def enforce(self, context):
        if not context.agreement_id:
            raise insights.PolicyDeniedError("Missing agreement identifier")
        if "ai_insight_consumer" not in context.roles:
            raise insights.PolicyDeniedError("Missing required role")


class _FakeLimiter:
    def __init__(self):
        self.fail = False

    def check(self, agreement_id: str) -> None:
        if self.fail:
            raise insights.RateLimitExceededError(retry_after_seconds=10)


class _FakeOrchestrator:
    def __init__(self, store: InMemoryOutputStore) -> None:
        self._store = store

    def _result(self, insight_type: str):
        record = self._store.save(
            insight_type=insight_type,
            agreement_id="agreement-1",
            asset_id="asset-7",
            input_data={"window": {"rows_analyzed": 24}},
            llm_model="llama-2-7b-chat",
            output_text='{"summary":"ok","key_findings":[],"recommendations":[]}',
            structured_output={
                "summary": f"{insight_type} summary",
                "key_findings": [f"{insight_type} finding"],
                "recommendations": [f"{insight_type} recommendation"],
            },
        )
        return SimpleNamespace(
            record=record,
            context={
                "source_context": {"rows_analyzed": 24, "insight_type": insight_type}
            },
            llm_used=True,
            llm_error=None,
        )

    def run_anomaly_report(self, **kwargs):
        return self._result("anomaly-report")

    def run_city_status(self, **kwargs):
        return self._result("city-status")

    def run_energy_summary(self, **kwargs):
        return self._result("energy-summary")


def _install_fake_singletons() -> tuple[InMemoryOutputStore, _FakeLimiter]:
    store = InMemoryOutputStore()
    limiter = _FakeLimiter()
    insights._singletons.clear()
    insights._singletons.update(
        {
            "policy": _FakePolicy(),
            "limiter": limiter,
            "store": store,
            "orchestrator": _FakeOrchestrator(store),
        }
    )
    return store, limiter


def _headers() -> dict[str, str]:
    return {
        "x-agreement-id": "agreement-1",
        "x-asset-id": "asset-7",
        "x-user-roles": "ai_insight_consumer",
    }


def test_health_endpoint(client) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_endpoint_rejects_missing_policy_headers(client) -> None:
    _install_fake_singletons()
    response = client.post(
        "/api/v1/insights/anomaly-report",
        json={
            "start_ts": "2026-01-01T00:00:00Z",
            "end_ts": "2026-01-02T00:00:00Z",
        },
    )
    assert response.status_code == 403


def test_endpoint_rejects_when_rate_limited(client) -> None:
    _, limiter = _install_fake_singletons()
    limiter.fail = True
    response = client.post(
        "/api/v1/insights/anomaly-report",
        headers=_headers(),
        json={
            "start_ts": "2026-01-01T00:00:00Z",
            "end_ts": "2026-01-02T00:00:00Z",
        },
    )
    assert response.status_code == 429
    assert response.headers["retry-after"] == "10"


def test_energy_summary_returns_governed_output(client) -> None:
    _install_fake_singletons()
    response = client.post(
        "/api/v1/insights/energy-summary",
        headers=_headers(),
        json={
            "start_ts": "2026-01-01T00:00:00Z",
            "end_ts": "2026-01-02T00:00:00Z",
            "forecast_alpha": 0.6,
            "trend_epsilon": 0.02,
            "daily_overview_strategy": "strict_daily",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"] == "energy-summary summary"
    assert payload["metadata"]["output_id"]
    assert payload["data"] is None


def test_energy_summary_include_data_returns_context(client) -> None:
    _install_fake_singletons()
    response = client.post(
        "/api/v1/insights/energy-summary",
        headers=_headers(),
        json={
            "start_ts": "2026-01-01T00:00:00Z",
            "end_ts": "2026-01-02T00:00:00Z",
            "forecast_alpha": 0.6,
            "trend_epsilon": 0.02,
            "daily_overview_strategy": "strict_daily",
            "include_data": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["data"]["source_context"]["rows_analyzed"] == 24


def test_dev_mode_includes_llm_error_in_metadata(client) -> None:
    store = InMemoryOutputStore()
    insights._singletons.clear()

    class _FailingOrchestrator:
        def run_anomaly_report(self, **kwargs):
            record = store.save(
                insight_type="anomaly-report",
                agreement_id="agreement-1",
                asset_id="asset-7",
                input_data={},
                llm_model="rule-based-fallback",
                output_text="{}",
                structured_output={
                    "summary": "fallback",
                    "key_findings": [],
                    "recommendations": [],
                },
            )
            return SimpleNamespace(
                record=record,
                context={},
                llm_used=False,
                llm_error="LLM upstream failed with 503",
            )

    insights._singletons.update(
        {
            "settings": SimpleNamespace(
                service=SimpleNamespace(environment="development")
            ),
            "policy": _FakePolicy(),
            "limiter": _FakeLimiter(),
            "store": store,
            "orchestrator": _FailingOrchestrator(),
        }
    )

    response = client.post(
        "/api/v1/insights/anomaly-report",
        headers=_headers(),
        json={"start_ts": "2026-01-01T00:00:00Z", "end_ts": "2026-01-02T00:00:00Z"},
    )
    assert response.status_code == 200
    assert response.json()["metadata"]["llm_error"] == "LLM upstream failed with 503"


def test_latest_returns_per_type_cache(client) -> None:
    _install_fake_singletons()
    client.post(
        "/api/v1/insights/anomaly-report",
        headers=_headers(),
        json={"start_ts": "2026-01-01T00:00:00Z", "end_ts": "2026-01-02T00:00:00Z"},
    )
    latest_response = client.get("/api/v1/insights/latest")
    assert latest_response.status_code == 200
    latest = latest_response.json()["latest"]
    assert latest["anomaly-report"]["output"]["summary"] == "anomaly-report summary"
    assert latest["energy-summary"] is None


def test_get_ai_output_by_id(client) -> None:
    _install_fake_singletons()
    create = client.post(
        "/api/v1/insights/city-status",
        headers=_headers(),
        json={"start_ts": "2026-01-01T00:00:00Z", "end_ts": "2026-01-02T00:00:00Z"},
    )
    output_id = create.json()["metadata"]["output_id"]
    response = client.get(f"/api/ai/outputs/{output_id}")
    assert response.status_code == 200
    assert response.json()["id"] == output_id


def test_openapi_json_available(client) -> None:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    payload = response.json()
    # FastAPI's emitted OpenAPI spec version follows the installed FastAPI
    # release (3.0.x pre-0.99, 3.1.0 after); the contract under test is that
    # a valid 3.x document is served, not a specific minor version.
    assert payload["openapi"].startswith("3.")
    assert "/api/v1/insights/anomaly-report" in payload["paths"]
    assert "/api/ai/outputs/{output_id}" in payload["paths"]
    responses = payload["paths"]["/api/v1/insights/anomaly-report"]["post"]["responses"]
    assert "403" in responses
    assert "429" in responses


def test_docs_available(client) -> None:
    response = client.get("/docs")
    assert response.status_code == 200
    assert "swagger" in response.text.lower() or "openapi" in response.text.lower()


def test_redoc_available(client) -> None:
    response = client.get("/redoc")
    assert response.status_code == 200
