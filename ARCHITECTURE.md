# Digital Twin for Microservices — Architecture & Implementation Guide

## Table of Contents

1. [Overview](#overview)
2. [Architecture Layers](#architecture-layers)
3. [Data Flow — End to End](#data-flow--end-to-end)
4. [Phase 1: Observability Layer](#phase-1-observability-layer)
5. [Phase 2: Persistent State (Redis + TimescaleDB)](#phase-2-persistent-state)
6. [Phase 3: ML Anomaly Detection (Python Sidecar)](#phase-3-ml-anomaly-detection)
7. [Phase 4: Closed-Loop Feedback (Control Service)](#phase-4-closed-loop-feedback)
8. [Kafka Digital Thread](#kafka-digital-thread)
9. [Simulation Engine (M/M/c)](#simulation-engine)
10. [Frontend Dashboard](#frontend-dashboard)
11. [Infrastructure (Docker Compose)](#infrastructure)
12. [API Reference](#api-reference)
13. [Safety & Resilience](#safety--resilience)

---

## Overview

This project is a **real-time Digital Twin platform** for microservices architectures. It creates a living virtual replica of your services that:

- **Observes** — Collects golden signals (latency, errors, throughput, CPU, memory) from Prometheus and topology from Jaeger
- **Remembers** — Persists current state in Redis and full history in TimescaleDB
- **Streams** — Publishes all events through Kafka as an immutable digital thread
- **Learns** — Detects anomalies using statistical methods (Z-score, EWMA) + ML (Isolation Forest)
- **Simulates** — Runs what-if scenarios using M/M/c queueing theory
- **Acts** — Scales services via Docker API based on anomalies and optimizer recommendations

The twin operates **in parallel** to your real services — it never modifies your business code.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        LAYER 5: FEEDBACK                                 │
│   ControlService → Docker API (scale replicas)                           │
│   Safety: dry-run, cooldown, max cap, whitelist                          │
└─────────────────────────────────────────────┬───────────────────────────┘
                                              │
┌─────────────────────────────────────────────┴───────────────────────────┐
│                     LAYER 4: ANALYTICS                                    │
│   Anomaly Detection (Z-score + EWMA + Isolation Forest)                  │
│   M/M/c Queueing Simulator (6 scenarios)                                 │
│   Optimization Engine (SLA-based replica calculation)                     │
└─────────────────────────────────────────────┬───────────────────────────┘
                                              │
┌─────────────────────────────────────────────┴───────────────────────────┐
│                     LAYER 3: DIGITAL THREAD (Kafka)                       │
│   twin.metrics.{service} │ twin.anomalies │ twin.actions │ twin.simulations│
│   Immutable event log — source of truth                                   │
└─────────────────────────────────────────────┬───────────────────────────┘
                                              │
┌─────────────────────────────────────────────┴───────────────────────────┐
│                     LAYER 2: STATE & PERSISTENCE                         │
│   Redis (current state, <1ms reads) + TimescaleDB (time-series history)  │
│   StateManager.js wraps all reads/writes                                  │
└─────────────────────────────────────────────┬───────────────────────────┘
                                              │
┌─────────────────────────────────────────────┴───────────────────────────┐
│                     LAYER 1: INGESTION                                    │
│   Prometheus polling (15s) + Jaeger topology auto-discovery               │
│   WebSocket push to React dashboard                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow — End to End

Here is the complete flow of data through the system, from the moment a metric is scraped to the moment an action is taken:

```
                    ┌─────────────┐
                    │  Prometheus │ ← scrapes real services every 15s
                    └──────┬──────┘
                           │ PromQL HTTP queries
                           ▼
              ┌────────────────────────┐
              │   Metrics Collector    │ (Node.js, runs every 15s)
              │   prometheus-client.js │
              └────────────┬───────────┘
                           │ Raw metrics
                           ▼
              ┌────────────────────────┐
              │   Data Transformer     │ Normalizes into ServiceSnapshot objects
              │   data-transformer.js  │ {name, latencyP99Ms, throughputRps, errorRatePct, ...}
              └────────────┬───────────┘
                           │
              ┌────────────┼─────────────────────────────────────┐
              │            │                                       │
              ▼            ▼                                       ▼
     ┌──────────────┐  ┌─────────────────┐              ┌──────────────────┐
     │ node-cache   │  │ StateManager    │              │ KafkaPublisher   │
     │ (in-memory)  │  │ Redis + Timescale│              │ twin.metrics.*   │
     └──────┬───────┘  └─────────────────┘              └────────┬─────────┘
            │                                                     │
            ▼                                                     ▼
     ┌──────────────┐                                    ┌──────────────────┐
     │  WebSocket   │ → React Dashboard                  │ KafkaConsumer    │
     │  broadcast   │                                    │ (state updater)  │
     └──────────────┘                                    └──────────────────┘
            │
            │ Same snapshot also feeds:
            ▼
     ┌──────────────────────────────────────────────────────────┐
     │                    ANALYTICS PIPELINE                      │
     ├──────────────────┬───────────────────┬───────────────────┤
     │ Anomaly Detector │  Optimizer Engine  │  Control Service  │
     │ Z-score + EWMA   │  M/M/c replicas   │  Scale decisions  │
     │ + ML (HTTP→8001) │  SLA constraints   │  Docker API       │
     └────────┬─────────┴─────────┬─────────┴─────────┬────────┘
              │                    │                    │
              ▼                    ▼                    ▼
       twin.anomalies      (recommendations)     twin.actions
              │                    │                    │
              └────────────────────┴────────────────────┘
                                   │
                                   ▼
                            WebSocket push
                            CONTROL_ACTION event
                                   │
                                   ▼
                           React Dashboard
```

### Timing of one collection cycle (every 15s):

1. **T+0ms** — Prometheus queries fire (parallel: latency, RPS, errors, CPU, memory, topology)
2. **T+50ms** — Raw results arrive, `data-transformer.js` normalizes them
3. **T+60ms** — `cache.set('snapshot')` + `stateManager.setState()` (Redis + TimescaleDB)
4. **T+70ms** — `kafkaPublisher.publishMetrics()` for each service
5. **T+80ms** — `anomalyDetector.detectAnomalies()` runs (Z-score, EWMA, trend)
6. **T+90ms** — Anomalies published to Kafka + sent to ML service (async)
7. **T+100ms** — `optimizer.generateRecommendations()` runs
8. **T+110ms** — `controlService.handleAnomaly()` + `handleOptimizerRecommendation()`
9. **T+120ms** — WebSocket broadcast to all connected frontend clients

---

## Phase 1: Observability Layer

### What it does
Polls Prometheus every 15 seconds for golden signals and queries Jaeger for service dependency topology.

### Key Files

| File | Role |
|------|------|
| `backend/metrics-collector/prometheus-client.js` | PromQL query builder — `queryInstant()` and `queryRange()` |
| `backend/metrics-collector/jaeger-client.js` | Jaeger REST API client |
| `backend/metrics-collector/topology-discovery.js` | Builds dependency graph from Jaeger traces |
| `backend/metrics-collector/data-transformer.js` | Normalizes raw Prometheus results into `ServiceSnapshot` objects |

### Metrics Collected

| Metric | PromQL | Unit |
|--------|--------|------|
| Latency P99 | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` | ms |
| Throughput | `sum(rate(http_requests_total[5m])) by (service)` | req/s |
| Error Rate | `sum(rate(http_requests_total{status=~"5.."}[5m]))` | % |
| CPU | `rate(process_cpu_seconds_total[5m]) * 100` | % |
| Memory | `process_resident_memory_bytes / 1024 / 1024` | MiB |

### Topology Discovery

Jaeger's dependency API is queried to build a directed graph:
```json
{
  "nodes": [{"id": "api-gateway", "type": "service"}],
  "edges": [{"source": "api-gateway", "target": "order-service", "callCount": 1523}]
}
```

Falls back to Prometheus-based topology if Jaeger is unavailable.

### Demo Mode

When `DEMO_MODE=true`, `load-injector.js` generates realistic synthetic data for 11 services without needing Prometheus/Jaeger infrastructure.

---

## Phase 2: Persistent State

### Problem Solved
Before: 30 data points in memory, lost on restart. After: unlimited history in TimescaleDB, instant reads from Redis.

### Key Files

| File | Role |
|------|------|
| `backend/src/state/StateManager.js` | Singleton wrapping Redis + TimescaleDB |
| `backend/src/db/migrations/001_create_metrics_table.sql` | TimescaleDB hypertable schema |

### Redis — Current State

```
Key: twin:state:{serviceName}
Type: HASH
Fields: service, latency_p99_ms, error_rate, throughput_rps, cpu_percent, memory_mb, updated_at
```

Read latency: **<1ms**. Used by the API for instant state queries.

### TimescaleDB — Time-Series History

```sql
CREATE TABLE service_metrics (
  time           TIMESTAMPTZ NOT NULL,
  service_name   TEXT NOT NULL,
  latency_p99    FLOAT,
  error_rate     FLOAT,
  throughput_rps FLOAT,
  cpu_percent    FLOAT,
  memory_mb      FLOAT
);
SELECT create_hypertable('service_metrics', 'time');
```

Indexed on `(service_name, time DESC)` for fast range queries.

### StateManager API

```javascript
await stateManager.setState('order-service', metrics);  // Writes to BOTH Redis + TimescaleDB
await stateManager.getState('order-service');            // Reads from Redis
await stateManager.getHistory('order-service', 24);     // Reads from TimescaleDB (last 24h)
```

### Graceful Degradation
If Redis or TimescaleDB are down, `StateManager` logs a warning and the system continues with in-memory cache only.

---

## Phase 3: ML Anomaly Detection

### Architecture

```
Node.js Backend                          Python Sidecar (port 8001)
┌──────────────────┐    HTTP POST        ┌─────────────────────────┐
│ anomaly-detector │ ──────────────────→ │ FastAPI /detect          │
│ detectWithML()   │                     │ IsolationForest.predict()│
│                  │ ←────────────────── │ {is_anomaly, score,      │
│ combines results │    JSON response    │  severity, method}       │
└──────────────────┘                     └─────────────────────────┘
                                                    │
                                                    │ loads training data
                                                    ▼
                                         ┌─────────────────────────┐
                                         │      TimescaleDB         │
                                         │  (7 days of history)     │
                                         └─────────────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `ml-service/detector.py` | `AnomalyDetector` class — one IsolationForest per service |
| `ml-service/trainer.py` | Loads history from TimescaleDB, retrains every 24h |
| `ml-service/main.py` | FastAPI app: `/detect`, `/train`, `/health` |

### How Isolation Forest Works Here

1. **Features**: `[latency_p99, error_rate, throughput_rps, cpu_percent, memory_mb]`
2. **Contamination**: 0.05 (assumes 5% of data points are anomalous)
3. **One model per service** — each service has different normal behavior
4. **Decision function score**: negative = more anomalous
   - score < -0.3 → severity `high`
   - score < -0.15 → severity `medium`
   - otherwise → severity `low`

### Combined Verdict (Node.js side)

The `detectWithML()` function in `anomaly-detector.js` combines both methods:

| Statistical | ML | Combined Verdict | Confidence |
|-------------|-----|-----------------|------------|
| ✅ anomaly | ✅ anomaly | `confirmed` | High |
| ✅ anomaly | ❌ normal | `statistical_only` | Medium |
| ❌ normal | ✅ anomaly | `ml_only` | Low (initially) |
| ❌ normal | ❌ normal | Normal | — |

### Retraining

- **Automatic**: Every 24h via asyncio background task
- **Manual**: `POST /train` endpoint
- **Minimum**: 50 data points required to train a model
- **Persistence**: Models saved to `/models/{service_name}.joblib`

---

## Phase 4: Closed-Loop Feedback

### Architecture

```
Anomaly Detected                    Optimizer Recommends
  severity: high                      scale_up: 3 replicas
       │                                    │
       ▼                                    ▼
┌─────────────────────────────────────────────────────┐
│                  ControlService.js                    │
│                                                      │
│  1. Whitelist check    → service in enabled list?    │
│  2. Cooldown check     → last action > 5min ago?     │
│  3. Max replicas cap   → never exceed hard limit     │
│  4. Dry run check      → DT_DRY_RUN=true? log only  │
│  5. Docker API call    → service.update(Replicas: n) │
│  6. Emit event         → WebSocket + Kafka           │
│  7. Log to file        → logs/control-actions.log    │
└─────────────────────────────────────────────────────┘
       │
       ▼
  Docker Swarm API
  Scale service replicas
```

### Safety Rails

| Protection | Implementation |
|-----------|----------------|
| **Dry run by default** | `DT_DRY_RUN !== 'false'` → always safe on first deploy |
| **Cooldown** | 5 minutes minimum between actions on same service |
| **Max replicas** | Hard cap (default: 5), never exceeded regardless of optimizer output |
| **Whitelist** | Only services in `DT_ENABLED_SERVICES` can be scaled |
| **No retry** | Docker API failure → log error, move on (no retry storm) |
| **Full audit trail** | Every decision logged as JSON to `logs/control-actions.log` |

### Operator Workflow

```
Day 1:  Deploy with DT_DRY_RUN=true (default)
        → All actions are logged but NOT executed
        → Review logs: docker logs dt-backend | grep "[Control]"

Day 2:  Confident the decisions are correct?
        → POST /api/control/toggle-dryrun
        → Or set DT_DRY_RUN=false in docker-compose.yml

Day 3+: Monitor via /api/control/status and Kafka UI
```

---

## Kafka Digital Thread

### Why Kafka

Kafka is a **distributed commit log** — events are immutable and persistent. This makes it the natural backbone for a Digital Twin's "digital thread": the bidirectional link between the physical and virtual worlds.

### Topics

| Topic | Publisher | Content |
|-------|-----------|---------|
| `twin.metrics.{service}` | Collector (every 15s) | Golden signals per service |
| `twin.anomalies` | Anomaly Detector | Z-score/EWMA/ML anomaly events |
| `twin.actions` | Control Service | Scale up/down decisions |
| `twin.simulations` | Simulator | What-if scenario results |

### Message Format Example

```json
// twin.metrics.order-service
{
  "service": "order-service",
  "timestamp": "2025-06-13T10:00:00.000Z",
  "latency_p99_ms": 120.5,
  "error_rate": 0.3,
  "throughput_rps": 48.2,
  "cpu_percent": 45,
  "memory_mb": 65,
  "replica_count": 1
}
```

### Resilience

- If Kafka is unreachable → warning logged, system continues in polling-only mode
- Background retry every 30 seconds
- Kafka failure **never** crashes the collector loop

### Kafka UI

Available at `http://localhost:8080` — shows all topics, messages, consumer groups, and lag in real-time.

---

## Simulation Engine

### M/M/c Queueing Model

The simulator uses **M/M/c queueing theory** to predict how services behave under different conditions:

- **M** = Markovian (Poisson) arrival process (requests)
- **M** = Markovian (exponential) service times
- **c** = Number of servers (replicas)

```
                    1000
Mean latency = ─────────────── × processing_time_ms
                     λ
               1 - ─────────
                   c × μ

Where:
  λ = arrival rate (requests/sec)
  μ = service rate per replica (1000 / processing_time_ms)
  c = number of replicas
```

### Available Scenarios

| Scenario | What it simulates |
|----------|-------------------|
| **Load Spike** | Sudden traffic surge — predicts latency explosion via M/M/c |
| **Service Failure** | Complete/partial outage — propagates cascading failures through dependency graph |
| **Scale Up** | Add replicas — predicts latency improvement |
| **Network Partition** | Packet loss between services — adds latency + errors to affected paths |
| **Memory Pressure** | GC pauses and OOM risk — models memory-induced latency spikes |
| **Cache Failure** | Cache store down — all services fall back to direct DB, models the latency impact |

### Cascading Failure Propagation

When a service fails, the simulator walks the dependency graph (from Jaeger) and applies penalties to all consumers:

```javascript
// Example: payment-service fails → who is impacted?
DEPENDENCY_MAP = {
  'order-service': ['payment-service', ...],  // order-service calls payment
  'api-gateway': ['order-service', ...],       // gateway calls order
}
// Impact: payment ×20 latency → order +500ms → gateway +250ms
```

---

## Frontend Dashboard

### Components

| Component | What it shows |
|-----------|--------------|
| `ServiceMap.jsx` | D3.js force-directed graph of service topology (live) |
| `MetricsPanel.jsx` | Golden signals for selected service with health score |
| `PerformanceChart.jsx` | Recharts time-series (latency, throughput) |
| `SimulatorControl.jsx` | What-if scenario launcher with parameter sliders |
| `OptimizePanel.jsx` | Optimizer recommendations + anomaly alerts |

### Data Flow to Frontend

```
Backend                              Frontend
┌──────────────┐    WebSocket        ┌────────────────┐
│ broadcast()  │ ─────────────────→  │ useWebSocket() │
│              │  METRICS_UPDATE      │                │
│              │  CONTROL_ACTION      │ useMetrics()   │
└──────────────┘                     └────────────────┘
                    REST (fallback)
                 ─────────────────→   api/client.js
                  GET /api/metrics/services
```

The frontend connects via WebSocket (`ws://localhost:3001/ws`) and receives push updates every 15 seconds. REST polling is the fallback if WebSocket disconnects.

---

## Infrastructure

### Docker Compose Services

| Service | Image | Port | Role |
|---------|-------|------|------|
| backend | Node.js (custom) | 3001 | REST API + WebSocket + Collector |
| frontend | React/Vite (custom) | 3000 | Dashboard UI |
| prometheus | prom/prometheus:v2.48.0 | 9090 | Metrics storage |
| jaeger | jaegertracing/all-in-one:1.52 | 16686 | Distributed tracing |
| otel-collector | otel/opentelemetry-collector-contrib | 8889 | Telemetry pipeline |
| kafka | bitnami/kafka:3.7 | 9092 | Event streaming (KRaft) |
| kafka-ui | provectuslabs/kafka-ui | 8080 | Kafka debug UI |
| redis | redis:7-alpine | 6379 | Current state store |
| timescaledb | timescale/timescaledb:latest-pg15 | 5432 | Time-series history |
| ml-service | Python FastAPI (custom) | 8001 | ML anomaly detection |

### Environment Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `PROMETHEUS_URL` | http://prometheus:9090 | Backend |
| `JAEGER_URL` | http://jaeger:16686 | Backend |
| `KAFKA_BROKERS` | kafka:9092 | Backend |
| `REDIS_URL` | redis://redis:6379 | Backend |
| `DATABASE_URL` | postgresql://postgres:postgres@timescaledb:5432/digitaltwin | Backend + ML |
| `ML_SERVICE_URL` | http://ml-service:8001 | Backend |
| `DT_DRY_RUN` | true | Backend (ControlService) |
| `DEMO_MODE` | false | Backend |
| `SCRAPE_INTERVAL_MS` | 15000 | Backend |

---

## API Reference

### Metrics & State

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Liveness probe |
| `/api/metrics/services` | GET | All services with current golden signals |
| `/api/metrics/service/:name` | GET | One service with time-series history |
| `/api/state/:serviceId` | GET | Current state from Redis |
| `/api/history/:serviceId?hours=24` | GET | Time-series from TimescaleDB |
| `/api/topology` | GET | Service dependency graph |
| `/api/topology/discover` | GET | Force Jaeger re-discovery |

### Simulation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/simulate` | POST | Run a what-if scenario |
| `/api/simulate/scenarios` | GET | List available scenarios |

### Optimization & Anomalies

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/optimize/recommendations` | GET | Rules-based recommendations |
| `/api/optimize/scaling` | GET | Optimal replica plan (M/M/c) |
| `/api/optimize/anomalies` | GET | Current anomalies + trend predictions |

### Control (Phase 4)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/control/status` | GET | Dry run state, cooldowns, enabled services |
| `/api/control/scale` | POST | Manual scale override |
| `/api/control/toggle-dryrun` | POST | Toggle dry run at runtime |

### Infrastructure Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/metrics/prometheus/status` | GET | Prometheus connectivity |
| `/api/metrics/jaeger/status` | GET | Jaeger connectivity + discovery info |
| `/api/kafka/status` | GET | Kafka connectivity, topics, consumer lag |
| `/api/ml-status` | GET | ML service model status |

---

## Safety & Resilience

### Graceful Degradation Matrix

Every external dependency is **optional**. The system degrades gracefully:

| Component Down | Impact | Behavior |
|---------------|--------|----------|
| Prometheus | No new metrics | Last snapshot served from cache |
| Jaeger | No topology updates | Static fallback dependency map used |
| Kafka | No event streaming | Polling continues, metrics still reach dashboard |
| Redis | No fast state reads | In-memory cache used as fallback |
| TimescaleDB | No history | 30-point in-memory history preserved |
| ML Service | No ML detection | Statistical methods (Z-score, EWMA) still run |
| Docker Socket | No scaling | Actions logged but not executed |

### Design Principles

1. **Additive, never blocking** — Each phase adds capability without creating a hard dependency
2. **Fail-open** — If any component is down, the system continues with reduced features
3. **Observe before acting** — DT_DRY_RUN=true by default; human reviews before enabling auto-scaling
4. **Immutable audit trail** — Kafka + log files record every decision for post-mortem analysis
5. **No retry storms** — Failed Docker/Kafka calls are logged and skipped, not retried in a loop

---

## Project Structure

```
digital-twin-microservices/
├── backend/
│   ├── metrics-collector/          # Layer 1: Data ingestion
│   │   ├── api-server.js              # Main entry (REST + WebSocket + orchestration)
│   │   ├── prometheus-client.js       # PromQL query builder
│   │   ├── jaeger-client.js           # Jaeger API client
│   │   ├── topology-discovery.js      # Dependency graph builder
│   │   └── data-transformer.js        # Raw → normalized metrics
│   ├── simulator/                  # Layer 4: What-if engine
│   │   ├── scenario-engine.js         # 6 scenario handlers
│   │   ├── performance-model.js       # M/M/c queueing model
│   │   └── load-injector.js           # Demo mode synthetic data
│   ├── optimizer/                  # Layer 4: Analytics
│   │   ├── optimization-engine.js     # SLA-based recommendations
│   │   └── anomaly-detector.js        # Z-score + EWMA + ML integration
│   ├── src/
│   │   ├── kafka/                  # Layer 3: Digital Thread
│   │   │   ├── KafkaPublisher.js      # Publish events to topics
│   │   │   └── KafkaConsumer.js       # Consume for state updates
│   │   ├── state/                  # Layer 2: Persistence
│   │   │   └── StateManager.js        # Redis + TimescaleDB wrapper
│   │   ├── control/                # Layer 5: Feedback
│   │   │   └── ControlService.js      # Docker scaling with safety rails
│   │   └── db/migrations/
│   │       └── 001_create_metrics_table.sql
│   ├── logs/                       # Persistent action audit trail
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   └── src/
│       ├── components/             # React UI (ServiceMap, Charts, Simulator)
│       ├── hooks/                  # useWebSocket, useMetrics
│       └── api/                    # REST client
├── ml-service/                     # Python ML sidecar
│   ├── detector.py                    # IsolationForest per service
│   ├── trainer.py                     # Periodic retraining from TimescaleDB
│   ├── main.py                        # FastAPI endpoints
│   ├── models/                        # Persisted .joblib models
│   ├── requirements.txt
│   └── Dockerfile
├── docker-compose.yml              # Full stack deployment
├── docker-compose.otel-demo.yml    # Connect to OpenTelemetry Demo
├── prometheus.yml                  # Prometheus scrape config
└── otel-collector-config.yaml      # OTel Collector pipeline
```

---

## Quick Start

```bash
# Full stack (demo mode with synthetic data)
docker compose up --build

# Connect to real OpenTelemetry Demo (15 instrumented services)
git clone https://github.com/open-telemetry/opentelemetry-demo.git
cd opentelemetry-demo && docker compose up -d
cd ../digital-twin-microservices && docker compose -f docker-compose.otel-demo.yml up --build
```

**URLs after startup:**

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001/api |
| Kafka UI | http://localhost:8080 |
| Prometheus | http://localhost:9090 |
| Jaeger UI | http://localhost:16686 |
