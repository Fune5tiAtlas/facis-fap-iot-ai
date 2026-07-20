"""FastAPI app factory for AI Insight Service."""

import logging
from pathlib import Path

import yaml
from fastapi import FastAPI

from src.api.rest.routes.dsp import configure_dsp_router, data_router, dsp_router
from src.api.rest.routes.insights import insights_router, outputs_router
from src.observability.metrics import create_metrics_app

logger = logging.getLogger(__name__)

# docs/openapi.yaml relative to project root (parent of src/)
_OPENAPI_SPEC = (
    Path(__file__).resolve().parent.parent.parent.parent / "docs" / "openapi.yaml"
)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )

    @app.get("/api/v1/health", tags=["health"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "ai-insight-service"}

    app.include_router(insights_router)
    app.include_router(outputs_router)
    app.include_router(dsp_router)
    app.include_router(data_router)

    # Initialize DSP HMAC signing (uses HMAC_SECRET env var or generates ephemeral key)
    import os

    configure_dsp_router(
        secret=os.getenv("AI_INSIGHT_HMAC__SECRET"),
        base_url=os.getenv(
            "AI_INSIGHT_HMAC__BASE_URL", "https://ai-insight.facis.cloud"
        ),
        enabled=os.getenv("AI_INSIGHT_HMAC__ENABLED", "true").lower() == "true",
    )

    # Prometheus metrics endpoint at /metrics
    app.mount("/metrics", create_metrics_app())

    if _OPENAPI_SPEC.exists():
        with open(_OPENAPI_SPEC, encoding="utf-8") as file:
            spec = yaml.safe_load(file)
        # Overriding the openapi() method is the version-stable way to serve
        # a hand-written spec; plain assignment to app.openapi_schema is not
        # honored by every FastAPI release.
        app.openapi = lambda: spec  # type: ignore[method-assign]
    else:
        logger.warning(
            "OpenAPI spec file not found at %s. Falling back to auto-generated schema.",
            _OPENAPI_SPEC,
        )

    return app
