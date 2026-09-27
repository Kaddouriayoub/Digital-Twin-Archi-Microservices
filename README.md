# Digital Twin for Microservices

> A real-time digital twin platform that visualizes, monitors, simulates, and autonomously optimizes microservices performance.
> Designed to work with any **OpenTelemetry-instrumented** microservices architecture.

**PFA (Projet de Fin d'Année) — ENSIAS**

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
  - [Data Flow](#data-flow)
  - [Project Structure](#project-structure)
  - [Kafka Topics](#kafka-topics)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Option 1: OpenTelemetry Demo (real metrics)](#option-1-connect-to-opentelemetry-demo-real-metrics)
  - [Option 2: Demo Mode (synthetic data)](#option-2-demo-mode-synthetic-data-no-dependencies)
  - [Option 3: Local Development](#option-3-local-development)
- [API Reference](#api-reference)
  - [Metrics & Topology](#metrics--topology)
  - [Simulation](#simulation)
  - [Optimization](#optimization)
  - [Anomalies](#anomalies)
  - [Control Service](#control-service)
  - [State & History](#state--history)
  - [Kafka](#kafka)
  - [ML Service](#ml-service-port-8001)
- [Anomaly Detection](#anomaly-detection)
- [ML Service (Isolation Forest)](#ml-service-isolation-forest)
- [Simulation Scenarios](#simulation-scenarios)
- [Optimization Engine](#optimization-engine)
- [Closed-Loop Controller](#closed-loop-controller)
- [Configuration](#configuration)
- [WebSocket Events](#websocket-events)

---

## Overview

The Digital Twin continuously scrapes metrics from **Prometheus** and traces from **Jaeger**, builds a live model of the system, detects anomalies using a hybrid statistical + ML pipeline, simulates what-if scenarios using queueing theory, and can autonomously scale Docker services through a closed-loop controller.

All events are streamed through **Apache Kafka** as an immutable Digital Thread, and a **React dashboard** with WebSocket push provides real-time visibility.

---

## Features

| Feature | Description |
|---------|-------------|
| **Real-time monitoring** | Golden signals (latency P99, throughput RPS, error rate) scraped from Prometheus every 15s |
| **Topology auto-discovery** | Service dependency graph built automatically from Jaeger distributed traces |
| **Hybrid anomaly detection** | Z-score + EWMA + linear regression (JS) combined with Isolation Forest (Python/ML) with automatic fallback |
| **30-min latency prediction** | Linear regression forecasts future latency and estimates SLA breach probability |
| **What-if simulation** | 6 scenarios modeled with M/M/c queueing theory — predict impact before it happens |
| **Optimization engine** | Rules-based recommendations (Level 1) + optimal replica count via M/M/c (Level 2) |
| **Closed-loop controller** | Autonomous Docker Swarm scaling with dry-run, cooldowns, and replica caps |
| **Digital Thread (Kafka)** | Immutable event log of all metrics, anomalies, simulations, and control actions |
| **Live dashboard** | React + WebSocket push with REST fallback — topology graph, charts, anomaly feed |
| **Demo mode** | Fully synthetic data — works without any live infrastructure |

---

## Architecture

### Data Flow

```
                     ┌─────────────────────────────────────────────────────┐
                     │                   Backend (Node.js)                  │
                     │                                                       │
  Prometheus ──────► │  prometheus-client.js ──► data-transformer.js        │
                     │         │                                             │
  Jaeger ──────────► │  jaeger-client.js ──► topology-discovery.js          │
                     │         │                                             │
                     │         ▼                                             │
                     │   collectMetrics() [every 15s]                        │
                     │         │                                             │
                     │    ┌────┴─────────────────────────────────────┐      │
                     │    │                                           │      │
                     │    ▼                                           ▼      │
                     │  AnomalyDetector.js               OptimizationEngine  │
                     │  (Z-score, EWMA, Trend)           (M/M/c + Rules)    │
                     │    │  HTTP POST /detect                │              │
                     │    ▼                                   │              │
                     │  ML Service (Python)                   │              │
                     │  Isolation Forest                      │              │
                     │    │                                   │              │
                     │    └──────────────┬────────────────────┘              │
                     │                  ▼                                    │
                     │           ControlService.js ──► Docker Swarm (scale) │
                     │                  │                                    │
                     │                  ▼                                    │
                     │  KafkaPublisher ──► twin.metrics.{svc}                │
                     │                    twin.anomalies                     │
                     │                    twin.actions                       │
                     │                    twin.simulations                   │
                     │                  │                                    │
                     │  KafkaConsumer ◄──┘ ──► StateManager (Redis)          │
                     │                              │                        │
                     │                              ▼                        │
                     │                         TimescaleDB                   │
                     └─────────────────────────────────────────────────────┘
                                    │ REST + WebSocket
                                    ▼
                             Frontend (React)
                             Dashboard / Charts / Topology
```

### Project Structure

```
digital-twin-microservices/
│
├── backend/                              # Node.js backend
│   ├── metrics-collector/
│   │   ├── api-server.js                 # Main entry point: Express REST + WebSocket hub
│   │   ├── prometheus-client.js          # PromQL queries (latency, RPS, errors, CPU, memory)
│   │   ├── jaeger-client.js              # Jaeger REST API client
│   │   ├── topology-discovery.js         # Auto-discovery of service dependencies from traces
│   │   └── data-transformer.js           # Normalizes raw Prometheus/Jaeger responses
│   │
│   ├── optimizer/
│   │   ├── anomaly-detector.js           # Hybrid detector: Z-score + EWMA + trend + ML sidecar
│   │   └── optimization-engine.js        # Rules-based recs + M/M/c optimal scaling (Levels 1 & 2)
│   │
│   ├── simulator/
│   │   ├── scenario-engine.js            # 6 what-if scenario handlers
│   │   ├── performance-model.js          # M/M/c queueing model + service profiles
│   │   └── load-injector.js              # Synthetic data generator (demo mode)
│   │
│   └── src/
│       ├── kafka/
│       │   ├── KafkaPublisher.js         # Publishes events to Kafka topics
│       │   └── KafkaConsumer.js          # Consumes metrics → triggers state updates
│       ├── state/
│       │   └── StateManager.js           # In-memory + Redis state store
│       ├── control/
│       │   └── ControlService.js         # Closed-loop Docker scaling controller
│       └── db/migrations/
│           └── 001_create_metrics_table.sql   # TimescaleDB hypertable schema
│
├── ml-service/                           # Python ML sidecar
│   ├── main.py                           # FastAPI app: /detect, /train, /health
│   ├── detector.py                       # Isolation Forest (one model per service)
│   ├── trainer.py                        # Periodic retraining from TimescaleDB (every 24h)
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/                             # React 18 + Vite dashboard
│   └── src/
│       ├── App.jsx                       # Main app with tab routing
│       ├── components/
│       │   ├── ServiceMap.jsx            # D3 force-directed topology graph
│       │   ├── MetricsPanel.jsx          # Golden signals overview cards
│       │   ├── PerformanceChart.jsx      # Time-series charts (Recharts)
│       │   ├── SimulatorControl.jsx      # What-if scenario UI
│       │   ├── OptimizePanel.jsx         # Optimization recommendations
│       │   ├── ControlPanel.jsx          # Closed-loop controller UI
│       │   └── anomalies/
│       │       ├── AnomalyFeed.jsx       # Live anomaly stream
│       │       ├── AnomalyCard.jsx       # Single anomaly detail card
│       │       ├── AnomalyHeatmap.jsx    # Heatmap by service × severity
│       │       └── AnomalyToast.jsx      # Real-time toast notifications
│       ├── hooks/
│       │   ├── useMetrics.js             # REST polling + WebSocket state sync
│       │   └── useWebSocket.js           # WebSocket connection manager
│       └── api/
│           └── client.js                # Axios API client (all endpoints)
│
├── config/
│   ├── jaeger-spm.yaml                   # Jaeger Service Performance Monitoring config
│   └── prometheus-hotrod.yml             # Prometheus scrape config for HotROD demo
│
├── docker-compose.yml                    # Full standalone stack (all services)
├── docker-compose.otel-demo.yml          # Connects to OpenTelemetry Demo (15 services)
├── docker-compose-hotrod.yml             # Connects to Jaeger HotROD demo app
├── docker-compose-sockshop.yml           # Connects to Weaveworks Sock Shop demo
├── otel-collector-config.yaml            # OpenTelemetry Collector pipeline config
├── prometheus.yml                        # Prometheus scrape config
└── ARCHITECTURE.md                       # Deep-dive architecture documentation
```

### Kafka Topics

| Topic | Producer | Consumer | Payload |
|-------|----------|----------|---------|
| `twin.metrics.{service}` | `KafkaPublisher` | `KafkaConsumer` → `StateManager` | Golden signals snapshot per service |
| `twin.anomalies` | `KafkaPublisher` | Dashboard / alerting | Anomaly alert with severity + method |
| `twin.actions` | `ControlService` | Audit log | Scaling decisions (dry-run or real) |
| `twin.simulations` | Simulation API | Analytics | What-if scenario results |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend runtime | Node.js 18, Express 4, ws (WebSocket) |
| ML service | Python 3.11, FastAPI, scikit-learn (Isolation Forest), joblib |
| Frontend | React 18, Vite, Recharts, D3.js, Lucide icons |
| Observability | Prometheus, Jaeger, OpenTelemetry Collector |
| Streaming | Apache Kafka 3.7 (KRaft mode — no Zookeeper), kafkajs |
| State | Redis 7 (current state), TimescaleDB / PostgreSQL 15 (history) |
| Infrastructure | Docker, Docker Compose, Docker Swarm (scaling), Dockerode |
| Dev tooling | nodemon, morgan, dotenv |

---

## Getting Started

### Prerequisites

- **Docker** and **Docker Compose** v2+
- **Node.js 18+** (local development only)
- **Python 3.11+** (local ML service only)

---

### Option 1: Connect to OpenTelemetry Demo (real metrics)

Connects the Digital Twin to the official OpenTelemetry Demo — a real 15-service microservices architecture with Prometheus and Jaeger already wired.

```bash
# Step 1 — Clone and start the OpenTelemetry Demo
git clone https://github.com/open-telemetry/opentelemetry-demo.git
cd opentelemetry-demo
docker compose -f compose.yaml -f compose.observability.yaml up -d

# Step 2 — Wait for all services to be ready (~2-3 min)
docker compose -f compose.yaml -f compose.observability.yaml ps

# Step 3 — Start the Digital Twin (in a new terminal)
cd /path/to/digital-twin-microservices
docker compose -f docker-compose.otel-demo.yml up --build
```

**Service URLs:**

| Service | URL | Notes |
|---------|-----|-------|
| Digital Twin Dashboard | http://localhost:3000 | React frontend |
| Backend API | http://localhost:3001/api | REST + WebSocket |
| ML Service | http://localhost:8001 | FastAPI (Isolation Forest) |
| Prometheus | http://localhost:9090 | Metrics storage |
| Kafka UI | http://localhost:8080 | Digital Thread viewer |
| TimescaleDB | localhost:5432 | Metrics history (psql) |
| OTel Demo Shop | http://localhost:8080 (OTel network) | Load generator |

> **Tip:** Increase load via the Locust generator.
> Find its port with: `docker port load-generator 8089`

**To stop:**
```bash
docker compose -f docker-compose.otel-demo.yml down
cd /path/to/opentelemetry-demo
docker compose -f compose.yaml -f compose.observability.yaml down
```

---

### Option 2: Demo Mode (synthetic data, no dependencies)

Runs the full stack with synthetic data — no Prometheus, Jaeger, or real services needed.
Ideal for development, demos, and presentations.

```bash
docker compose up --build
```

Or run locally:
```bash
# In backend/.env, set:
DEMO_MODE=true

cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

---

### Option 3: Local Development

Run each component individually for development with hot-reload.

```bash
# 1. Backend
cd backend
cp .env.example .env     # Edit with your Prometheus/Jaeger URLs
npm install
npm run dev              # nodemon with hot-reload on :3001

# 2. ML Service
cd ml-service
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001 --reload

# 3. Frontend
cd frontend
npm install
npm run dev              # Vite dev server on :5173
```

---

## API Reference

All REST endpoints are served at `http://localhost:3001`.

### Metrics & Topology

#### `GET /api/health`
Liveness probe.

```json
// Response
{ "status": "ok", "version": "1.0.0", "timestamp": 1718300000000 }
```

#### `GET /api/metrics/services`
Returns all discovered services with their current golden-signal metrics.

```json
// Response
{
  "collectedAt": 1718300000000,
  "services": [
    {
      "name": "frontend",
      "latencyP99Ms": 142,
      "throughputRps": 38.5,
      "errorRatePct": 0.2,
      "cpuPercent": 12.4,
      "memoryMib": 256
    }
  ],
  "topology": { "nodes": [...], "edges": [...] }
}
```

#### `GET /api/metrics/service/:name?duration=60`
Returns detailed metrics + time-series history for one service.

| Query param | Type | Default | Description |
|-------------|------|---------|-------------|
| `duration` | `number` | `60` | History window in minutes |

#### `GET /api/topology`
Returns the service dependency graph (nodes + directed edges).

#### `GET /api/topology/discover`
Forces a fresh topology re-discovery from Jaeger. Resets the in-memory cache.

#### `GET /api/metrics/prometheus/status`
Checks Prometheus connectivity.

#### `GET /api/metrics/jaeger/status`
Checks Jaeger connectivity and returns the current dependency map.

---

### Simulation

#### `POST /api/simulate`
Runs a what-if scenario against the current baseline metrics.

```json
// Request body
{
  "scenario": "load_spike",
  "service": "checkout",
  "intensity": 0.7,
  "config": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scenario` | `string` | ✅ | One of the 6 available scenarios (see below) |
| `service` | `string` | ❌ | Target service (null = all services) |
| `intensity` | `number` | ❌ | Scenario intensity 0–1, default `0.5` |
| `config` | `object` | ❌ | Scenario-specific overrides |

```json
// Response
{
  "scenario": "load_spike",
  "service": "checkout",
  "intensity": 0.7,
  "result": {
    "predictedLatencyMs": 890,
    "predictedErrorPct": 3.2,
    "affectedServices": ["checkout", "payment"]
  },
  "simulatedAt": 1718300000000
}
```

> The simulation result is also published to the `twin.simulations` Kafka topic.

#### `GET /api/simulate/scenarios`
Lists all available scenarios with descriptions and parameters.

---

### Optimization

#### `GET /api/optimize/recommendations`
Returns Level 1 rules-based recommendations for all services.

```json
// Response
{
  "recommendations": [
    {
      "service": "checkout",
      "severity": "critical",
      "type": "scale_up",
      "message": "Service saturé (ρ=87%) — Scale up à 3 replicas réduirait la latence de 62%",
      "details": {
        "currentLatencyMs": 820,
        "predictedLatencyMs": 312,
        "currentReplicas": 1,
        "recommendedReplicas": 3,
        "utilization": 87,
        "latencyReductionPct": 62
      }
    }
  ],
  "sla": { "maxLatencyMs": 500, "maxErrorPct": 1, "maxUtilization": 0.8 },
  "analyzedAt": 1718300000000
}
```

Recommendation types:

| Type | Trigger condition |
|------|------------------|
| `scale_up` | Latency > 500ms AND utilization > 80% |
| `scale_down` | Utilization < 30% AND latency < 250ms |
| `dependency_issue` | Latency > 500ms AND utilization < 30% (bottleneck is upstream) |
| `high_errors` | Error rate > 1% |

#### `GET /api/optimize/scaling`
Returns Level 2 M/M/c optimal scaling plan for all services.

```json
// Response
{
  "sla": { "maxLatencyMs": 500, "targetUtilization": 0.7 },
  "services": [
    {
      "name": "payment",
      "currentReplicas": 1,
      "optimalReplicas": 2,
      "action": "scale_up",
      "currentMetrics": { "latencyP99Ms": 620, "throughputRps": 45, "utilization": 85 },
      "predictedMetrics": { "latencyP99Ms": 210, "utilization": 42 },
      "model": { "arrivalRate": 45, "serviceRate": 26.3, "processingTimeMs": 38 }
    }
  ],
  "summary": { "totalCurrentReplicas": 8, "totalOptimalReplicas": 11, "savings": -3 },
  "computedAt": 1718300000000
}
```

---

### Anomalies

#### `GET /api/optimize/anomalies`
Returns all current anomaly alerts with service health status.

```json
// Response
{
  "anomalies": [
    {
      "service": "frontend",
      "type": "anomaly",
      "severity": "warning",
      "metric": "latency",
      "message": "Latence anormale (380ms, normale: ~120ms, z-score: 2.8)",
      "details": { "currentValue": 380, "mean": 120, "stdDev": 92, "zScore": 2.8 },
      "ml_score": -0.21,
      "ml_severity": "medium",
      "combined_verdict": "confirmed"
    }
  ],
  "serviceStatus": [
    { "name": "frontend", "status": "anomaly", "latencyZScore": 2.8, "trendSlopePerMin": 12 }
  ],
  "config": { "zScoreThreshold": 2.0, "ewmaAlpha": 0.3, "historySize": 30 },
  "analyzedAt": 1718300000000
}
```

`combined_verdict` values:

| Value | Meaning |
|-------|---------|
| `confirmed` | Statistical AND ML both flag it as anomaly |
| `statistical_only` | Stats fired, ML score is normal |
| `ml_only` | ML detected it, statistics missed it |

#### `GET /api/anomalies`
Alias for the anomaly endpoint — returns only the `anomalies` array.

---

### Control Service

#### `GET /api/control/status`
Returns the current state of the closed-loop controller.

```json
// Response
{
  "dry_run": true,
  "cooldowns": { "checkout": 0, "payment": 240 },
  "enabled_services": ["checkout", "payment"],
  "max_replicas": { "default": 5, "checkout": 8 }
}
```

#### `POST /api/control/scale`
Manually triggers a scaling action.

```json
// Request body
{ "service": "checkout", "replicas": 3, "reason": "manual_override" }
```

```json
// Response (dry_run = true)
{ "success": true, "action_taken": false, "message": "dry_run", "target_replicas": 3 }

// Response (dry_run = false, scale executed)
{
  "success": true,
  "action_taken": true,
  "previous_replicas": 1,
  "new_replicas": 3,
  "service": "checkout",
  "timestamp": 1718300000000
}
```

#### `POST /api/control/toggle-dryrun`
Toggles dry-run mode on/off at runtime.

```json
// Response
{ "dry_run": false }
```

---

### State & History

#### `GET /api/state/:serviceId`
Returns the latest persisted service state from Redis.

#### `GET /api/history/:serviceId?hours=24`
Returns time-series metrics history from TimescaleDB.

| Query param | Type | Default | Description |
|-------------|------|---------|-------------|
| `hours` | `number` | `24` | Lookback window in hours |

#### `GET /api/ml-status`
Proxies the ML service `/health` endpoint — shows which services have trained models.

```json
// Response
{
  "status": "ok",
  "models": {
    "frontend": { "is_trained": true, "last_trained_at": "2026-06-13T19:27:00Z", "n_samples": 312 },
    "checkout": { "is_trained": true, "last_trained_at": "2026-06-13T19:27:00Z", "n_samples": 278 }
  },
  "total_models": 2
}
```

---

### Kafka

#### `GET /api/kafka/status`
Returns Kafka connectivity, topic list, and consumer lag.

---

### ML Service (port 8001)

#### `POST /detect`
Runs Isolation Forest inference for a single service.

```json
// Request body
{
  "service_name": "checkout",
  "metrics": {
    "latency_p99": 820,
    "error_rate": 3.1,
    "throughput_rps": 45,
    "cpu_percent": 78,
    "memory_mb": 512
  }
}
```

```json
// Response
{
  "is_anomaly": true,
  "score": -0.31,
  "severity": "high",
  "trained": true,
  "method": "isolation_forest"
}
```

| Field | Description |
|-------|-------------|
| `is_anomaly` | `true` if model predicts anomaly |
| `score` | Decision function output — more negative = more anomalous |
| `severity` | `low` / `medium` / `high` based on score thresholds |
| `trained` | `false` if no model exists for this service yet |

#### `POST /train`
Triggers model retraining. If `service_name` is omitted, retrains all services.

```json
// Request body (optional)
{ "service_name": "checkout" }
```

#### `GET /health`
Returns model status for all loaded models.

---

## Anomaly Detection

The anomaly detector runs a **3-level hybrid pipeline** on every metrics scrape:

```
Metrics snapshot
      │
      ├──► L1: Z-score ──────────────────► point anomalies (current vs mean)
      │
      ├──► L2a: EWMA ────────────────────► sustained deviations from smoothed trend
      │
      ├──► L2b: Linear Regression ───────► SLA breach prediction (extrapolation)
      │
      └──► L3: Isolation Forest (ML) ────► multi-feature anomaly (HTTP call to ML service)
                                               │
                                        timeout 2s → fallback to stats-only
```

### Configuration (`anomaly-detector.js`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `historySize` | `30` | Circular buffer size (data points per service) |
| `zScoreThreshold` | `2.0` | Std deviations to trigger Z-score alert |
| `ewmaAlpha` | `0.3` | EWMA smoothing factor (0=fully smoothed, 1=no smoothing) |
| `trendWindowSize` | `10` | Points used for linear regression |
| `predictionHorizonMin` | `5` | Lookahead for SLA breach prediction (minutes) |

### Alert fields

```json
{
  "service": "payment",
  "type": "ewma_deviation",        // anomaly | trend | ewma_deviation | ml_anomaly
  "severity": "warning",           // critical | warning
  "metric": "latency",
  "message": "Human-readable description",
  "details": { ... },
  "ml_score": -0.18,               // present if ML service responded
  "ml_severity": "medium",
  "combined_verdict": "confirmed"  // confirmed | statistical_only | ml_only
}
```

---

## ML Service (Isolation Forest)

The `ml-service/` is a standalone Python **FastAPI** sidecar that runs one **Isolation Forest** model per service.

### How it works

1. **Training** — `trainer.py` queries the last 7 days (168h) from TimescaleDB and trains an Isolation Forest on 5 features: `latency_p99`, `error_rate`, `throughput_rps`, `cpu_percent`, `memory_mb`. Minimum 50 samples required.
2. **Persistence** — Models are saved to disk as `.joblib` files in `/models` and reloaded on startup.
3. **Inference** — `/detect` accepts a metrics dict, runs `model.decision_function()` and `model.predict()`, and returns a scored result.
4. **Retraining** — Background `asyncio` loop retrains all models every 24 hours automatically.

### Severity thresholds

| Score range | Severity |
|-------------|----------|
| `score > -0.15` | `low` |
| `-0.30 < score ≤ -0.15` | `medium` |
| `score ≤ -0.30` | `high` |

### Integration with backend

`anomaly-detector.js` calls `/detect` for every service on each scrape cycle with a **2-second timeout**. If the ML service is unavailable or hasn't trained a model yet (`trained: false`), the backend silently falls back to statistical detection only — zero downtime impact.

---

## Simulation Scenarios

The simulation engine applies each scenario to the current real baseline metrics using **M/M/c queueing theory** to predict outcomes.

| Scenario key | Description |
|--------------|-------------|
| `load_spike` | Sudden traffic surge — models latency and error rate under increased arrival rate λ |
| `service_failure` | Complete or partial outage with configurable cascade propagation to dependent services |
| `scale_up` | Add `n` replicas — predicts latency improvement via M/M/c with c servers |
| `network_partition` | Simulates packet loss between services — adds artificial latency and error rate |
| `memory_pressure` | GC pause spikes and OOM risk — models stop-the-world latency impact |
| `cache_miss` | Cache store failure — routes all requests to DB, models the fallback latency |

### How to run a simulation

```bash
curl -X POST http://localhost:3001/api/simulate \
  -H "Content-Type: application/json" \
  -d '{
    "scenario": "load_spike",
    "service": "checkout",
    "intensity": 0.8
  }'
```

`intensity` ranges from `0.0` (minimal impact) to `1.0` (worst case). The result is also published to `twin.simulations` Kafka topic.

---

## Optimization Engine

Two levels of optimization run automatically on every scrape cycle.

### Level 1 — Rules-based Recommendations

Compares live metrics against SLA thresholds and generates human-readable recommendations:

| Rule | Trigger | Recommendation type |
|------|---------|-------------------|
| High latency + high utilization | P99 > 500ms AND ρ > 80% | `scale_up` with predicted improvement |
| High latency + low utilization | P99 > 500ms AND ρ < 30% | `dependency_issue` — upstream bottleneck |
| High error rate | error% > 1% | `high_errors` — inspect dependencies |
| Low utilization | ρ < 30% AND P99 < 250ms | `scale_down` — cost saving opportunity |

### Level 2 — M/M/c Optimal Scaling

Finds the **minimum number of replicas** `c` such that:
- Utilization `ρ = λ / (c × μ) < 0.70`
- Predicted P99 latency `< 500ms`

```
λ = arrival rate (RPS)
μ = service rate per replica (1000 / baseProcTimeMs)
c = number of replicas (what we solve for)
```

---

## Closed-Loop Controller

`ControlService.js` can autonomously scale Docker Swarm services based on anomaly alerts and optimizer recommendations.

### Safety mechanisms

| Mechanism | Default | Description |
|-----------|---------|-------------|
| Dry-run mode | `true` | Logs decisions without executing Docker API calls |
| Cooldown | 5 min | Prevents scaling the same service more than once per cooldown window |
| Max replicas cap | 5 (default) | Per-service override via `DT_MAX_REPLICAS_{SERVICE}` |
| Service whitelist | `[]` (all) | Only services in `DT_ENABLED_SERVICES` are eligible for auto-scaling |
| Action log | `logs/control-actions.log` | JSONL file with every decision (SCALED, DRY_RUN, COOLDOWN, CAP, SKIP, ERROR) |
| Kafka publishing | `twin.actions` | All actions published as events for audit / replay |

### Decision flow

```
anomaly.severity == "critical" OR "high"
  + details.recommendedReplicas present
        │
        ▼
  ControlService.scaleService()
        │
   ┌────┴────────────────────────────────┐
   │  1. Whitelist check                  │
   │  2. Cooldown check                   │
   │  3. Cap to maxReplicas               │
   │  4. Dry-run? → log only              │
   │  5. Docker API: service.update()     │
   │  6. Emit 'action_taken' event        │
   │  7. Broadcast via WebSocket          │
   └─────────────────────────────────────┘
```

### Enabling real scaling

```bash
# In backend/.env or docker-compose.yml:
DT_DRY_RUN=false
DT_ENABLED_SERVICES=checkout,payment,frontend
```

Or toggle at runtime:
```bash
curl -X POST http://localhost:3001/api/control/toggle-dryrun
```

---

## Configuration

Full reference for `backend/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend HTTP server port |
| `NODE_ENV` | `development` | Node environment |
| `PROMETHEUS_URL` | `http://localhost:9090` | Prometheus query API URL |
| `JAEGER_URL` | `http://localhost:16686` | Jaeger query API URL |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated Kafka broker addresses |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/digitaltwin` | TimescaleDB connection string |
| `ML_SERVICE_URL` | `http://localhost:8001` | Python ML service base URL |
| `SCRAPE_INTERVAL_MS` | `15000` | Prometheus scrape interval in milliseconds |
| `DEMO_MODE` | `true` | Use synthetic data (no real infra needed) |
| `DT_DRY_RUN` | `true` | Closed-loop controller dry-run mode |
| `DT_ENABLED_SERVICES` | `` | Comma-separated service names eligible for auto-scaling |

---

## WebSocket Events

Connect to `ws://localhost:3001/ws`. On connect, the latest snapshot is immediately pushed.

| Event `type` | Trigger | Payload |
|-------------|---------|---------|
| `METRICS_UPDATE` | Every scrape cycle (15s) | Full services + topology snapshot |
| `PREDICTION` | Every scrape cycle, per service | 30-min latency forecast + breach probability |
| `CONTROL_ACTION` | On scaling decision | Service, action, replicas, dry_run flag |

```js
// Example WebSocket client
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onmessage = ({ data }) => {
  const { type, payload } = JSON.parse(data);
  if (type === 'METRICS_UPDATE') { /* update dashboard */ }
  if (type === 'PREDICTION')     { /* show forecast */ }
  if (type === 'CONTROL_ACTION') { /* show toast notification */ }
};
```
