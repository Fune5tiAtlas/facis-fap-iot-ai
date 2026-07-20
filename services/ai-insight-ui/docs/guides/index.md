# FACIS IoT & AI Insight UI — Developer Guide

**Project:** FACIS FAP — IoT & AI Demonstrator
**Version:** 0.1
**Date:** 05 April 2026

---

## What Is This?

The AI Insight UI is a Vue.js 3 single-page application (SPA) that runs inside ORCE (Node-RED + UIBUILDER) and provides a conversational AI dashboard for FACIS energy and city insights. It enables users to explore IoT data and derive actionable intelligence through two complementary AI pathways:

- **Path A (Structured):** Smart prompts → AI Insight Service → deterministic analytics enriched with LLM reasoning
- **Path B (Freeform):** Free-form natural language questions → Trino Gold Layer context → user-selected LLM provider

The dashboard surfaces KPI cards, time-series charts, and an interactive prompt-driven interface that bridges raw data and human-readable insights.

## Quickstart (60 seconds)

**Prerequisites:** Node.js 22+, a running ORCE instance with UIBUILDER installed.

```bash
# Navigate to the UI application root
cd services/ai-insight-ui/ui/app

# Install dependencies
npm install

# Start local development server
npm run dev
```

The Vue development server runs at `http://localhost:5173`. With ORCE running locally, you can also access the UI at `http://localhost:1880/aiInsight/` (with UIBUILDER deployed).

For the full stack (ORCE + Kafka + AI Insight Service), deploy via Helm against a kind/minikube cluster — see the deployment guides under `docs/deployment/`.

## Key Concepts

**UIBUILDER messaging.** The Vue app communicates with Node-RED flows via WebSocket. Messages are `msg` objects sent using `uibuilder.send()` on the frontend and received by UIBUILDER nodes on the backend. Flow context stores session state and conversation history.

**Two-path AI architecture.** Path A routes structured analytical requests through the AI Insight Service (FastAPI, port 8080) for deterministic results. Path B accepts freeform queries, enriches them with Trino Gold Layer context data, then routes to the user-selected LLM (OpenAI, Anthropic, or custom).

**Session management.** Flow context (Node-RED's persistent object store) maintains rolling conversation history and UI state across the HTTP session. LLM provider configuration is loaded from environment variables at startup.

**LLM provider routing.** Configured providers (OpenAI, Anthropic, custom) are selectable at runtime. Credentials are stored in Node-RED secrets (Kubernetes `Secret` objects in production, environment variables in development).

**KPI cards and visualization.** Cards display Key Performance Indicators (energy cost, PV forecast, anomalies, city events) sourced from cached AI Insight Service responses. Charts render 24-hour forecasts and cost trends using Chart.js.

## Developer Guide Contents

| Document | Description |
|---|---|
| [**setup.md**](setup.md) | Local development environment, Docker setup, prerequisites |
| [**architecture.md**](architecture.md) | UI component hierarchy, state management, flow integration |
| [**configuration.md**](configuration.md) | Environment variables, feature flags, customization |

## Related Documentation

These documents live elsewhere in the `docs/` tree and cover specific technical domains:

| Document | Path | Description |
|---|---|---|
| Flow Architecture | `docs/flow-architecture.md` | Node-RED tab structure and message routing |
| Helm Deployment | `helm/facis-ai-insight-ui/README.md` | Kubernetes deployment and Helm values |
| Operations Runbook | `docs/deployment/ops-runbook.md` | Production troubleshooting and monitoring |

---

(c) ATLAS IoT Lab GmbH -- FACIS FAP IoT & AI Demonstrator
Licensed under Apache License 2.0
