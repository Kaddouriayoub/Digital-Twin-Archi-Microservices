# How It Works — Technical Deep Dive

> A detailed explanation of every subsystem in the Digital Twin platform: data collection, anomaly detection, machine learning, simulation engine, optimization, and the closed-loop controller.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Metrics Collection Pipeline](#2-metrics-collection-pipeline)
3. [Topology Auto-Discovery](#3-topology-auto-discovery)
4. [Anomaly Detection — Statistical Layer](#4-anomaly-detection--statistical-layer)
   - [Z-Score](#41-z-score)
   - [EWMA](#42-ewma-exponentially-weighted-moving-average)
   - [Linear Regression & SLA Prediction](#43-linear-regression--sla-prediction)
5. [Machine Learning — Isolation Forest](#5-machine-learning--isolation-forest)
   - [What is Isolation Forest?](#51-what-is-isolation-forest)
   - [Training Pipeline](#52-training-pipeline)
   - [Inference Pipeline](#53-inference-pipeline)
   - [Model Persistence](#54-model-persistence)
   - [Automatic Retraining](#55-automatic-retraining)
   - [Integration with the Backend](#56-integration-with-the-backend)
   - [Combined Verdict Logic](#57-combined-verdict-logic)
6. [Simulation Engine (What-If)](#6-simulation-engine-what-if)
   - [M/M/c Queueing Theory](#61-mmc-queueing-theory)
   - [Service Profiles](#62-service-profiles)
   - [Scenarios](#63-scenarios)
7. [Optimization Engine](#7-optimization-engine)
   - [Level 1 — Rules-Based](#71-level-1--rules-based)
   - [Level 2 — M/M/c Optimal Scaling](#72-level-2--mmc-optimal-scaling)
8. [Closed-Loop Controller](#8-closed-loop-controller)
9. [Event-Driven Architecture (Kafka)](#9-event-driven-architecture-kafka)
10. [State Management](#10-state-management)
11. [Real-Time Dashboard](#11-real-time-dashboard)
12. [Demo Mode](#12-demo-mode)

---

## 1. System Overview

The system runs a continuous scrape cycle every **15 seconds**. Each cycle:

1. Queries **Prometheus** for golden-signal metrics (latency, throughput, errors, CPU, memory)
2. Queries **Jaeger** to build or update the service dependency graph
3. Runs the **anomaly detection pipeline** (stats + ML) on the fresh snapshot
4. Runs the **optimization engine** to generate scaling recommendations
5. Feeds results into the **closed-loop controller**, which may trigger Docker scaling
6. Publishes everything to **Apache Kafka** as an immutable event log
7. Broadcasts the snapshot to all connected **WebSocket clients** (React dashboard)
8. Persists current state to **Redis** and metrics history to **TimescaleDB**

```
Every 15 seconds:
  Prometheus + Jaeger
       │
       ▼
  collectMetrics()
       │
       ├──► AnomalyDetector ──► ML Service (Isolation Forest)
       │         │
       │         ▼
       ├──► OptimizationEngine (M/M/c)
       │         │
       │         ▼
       ├──► ControlService ──► Docker API
       │
       ├──► KafkaPublisher ──► twin.metrics.* / twin.anomalies / twin.actions
       │
       ├──► StateManager ──► Redis + TimescaleDB
       │
       └──► WebSocket broadcast ──► React Dashboard
```

---

## 2. Metrics Collection Pipeline

### What metrics are collected?

The backend queries Prometheus with PromQL for five **golden signals**:

| Metric | PromQL concept | Unit |
|--------|---------------|------|
| Latency P99 | `histogram_quantile(0.99, ...)` | milliseconds |
| Throughput | `rate(requests_total[1m])` | requests/second |
| Error rate | `rate(errors_total[1m]) / rate(requests_total[1m])` | percentage |
| CPU usage | `container_cpu_usage_seconds_total` | millicores |
| Memory usage | `container_memory_usage_bytes` | MiB |

### Data normalization (`data-transformer.js`)

Raw Prometheus results are nested Prometheus JSON — they get normalized into a flat `ServiceSnapshot`:

```js
{
  name: "checkout",
  latencyP99Ms: 142.5,
  throughputRps: 38.5,
  errorRatePct: 0.2,
  cpuMillicores: 120,
  memoryMib: 256,
  health: 85,
  updatedAt: 1718300000000
}
```

`health` is a composite score 0–100 computed from latency and error rate:
- Latency > 500ms → −30 pts
- Latency > 200ms → −15 pts
- Errors > 5% → −35 pts
- Errors > 1% → −15 pts

---

## 3. Topology Auto-Discovery

### Source: Jaeger traces

The topology (which service calls which) is discovered automatically from **distributed tracing data** in Jaeger. The `topology-discovery.js` module calls Jaeger's `/api/dependencies` endpoint, which returns span relationships.

```
GET http://jaeger:16686/api/dependencies?endTs=...&lookback=3600000
```

Response example:
```json
[
  { "parent": "frontend",  "child": "cart-service",     "callCount": 1203 },
  { "parent": "frontend",  "child": "product-service",  "callCount": 980  },
  { "parent": "cart-service", "child": "cache-store",   "callCount": 4500 }
]
```

This is transformed into a graph `{ nodes: [...], edges: [...] }` for the D3 force-directed visualization.

### Fallback

If Jaeger is unavailable, the topology falls back to a **static dependency map** hardcoded in `performance-model.js` based on the standard Online Boutique service graph.

---

## 4. Anomaly Detection — Statistical Layer

Before the ML model runs, three statistical methods analyze the metrics history. Each service maintains a **circular buffer of 30 data points** in memory.

### 4.1 Z-Score

**What it is:** measures how many standard deviations the current value is from the historical mean.

```
z = (current - mean) / stdDev
```

**Trigger condition:** `|z| > 2.0` AND current value is above a minimum threshold (avoids noise on idle services).

**Implementation:**
```js
function zScore(arr, current) {
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  return (current - m) / s;
}
```

**What it catches:** sudden point anomalies — a single data point that is far from the norm (e.g., a brief latency spike).

**Severity mapping:**
- `|z| > 3.0` → `critical`
- `2.0 < |z| ≤ 3.0` → `warning`

---

### 4.2 EWMA (Exponentially Weighted Moving Average)

**What it is:** a smoothed version of the time series that gives more weight to recent observations. The formula is:

```
S_t = α × x_t + (1 - α) × S_{t-1}
```

where `α = 0.3` (configurable). A value closer to 1 makes the EWMA more reactive to recent changes; closer to 0 makes it smoother.

**Trigger condition:** current value is more than **50% above** the EWMA (i.e., deviation > 0.5).

**Implementation:**
```js
function ewma(arr, alpha = 0.3) {
  let s = arr[0];
  for (let i = 1; i < arr.length; i++) {
    s = alpha * arr[i] + (1 - alpha) * s;
  }
  return s;
}
```

**What it catches:** sustained deviations that Z-score misses. If latency gradually climbs over several scrape cycles, Z-score may not fire (mean shifts), but EWMA stays anchored to the smoothed trend.

**Example alert message:**
```
Latence 85% au-dessus de la tendance lissée (EWMA: 120ms, actuel: 222ms)
```

---

### 4.3 Linear Regression & SLA Prediction

**What it is:** fits a least-squares line through the last 10 data points and extrapolates forward.

```
slope = (n·ΣxY - ΣxΣy) / (n·Σx² - (Σx)²)
```

**Trigger condition:** slope > 5ms/min AND predicted latency will breach the SLA (500ms) within 30 minutes.

```js
const timeToSLA = (SLA.maxLatencyMs - current) / slopePerMin;
if (timeToSLA > 0 && timeToSLA < 30) {
  // fire alert
}
```

**What it catches:** degradation trends that haven't yet crossed the SLA threshold. Gives operators a warning before the violation.

**Example alert message:**
```
Latence en hausse (+12ms/min) — dépassement SLA prévu dans ~18 min
```

**30-minute forecast (WebSocket PREDICTION event):**

In addition to alerts, every scrape cycle emits a `PREDICTION` WebSocket event with:
- `predicted_latency_p99`: extrapolated value 30 min from now
- `breach_probability`: 0–1 probability of hitting the SLA
- `risk_level`: `low` / `medium` / `high`

---

## 5. Machine Learning — Isolation Forest

### 5.1 What is Isolation Forest?

Isolation Forest is an **unsupervised anomaly detection algorithm** that works by randomly partitioning the feature space with decision trees. The key insight is:

> **Anomalies are easier to isolate than normal points.**

A normal data point requires many random cuts to be separated. An anomalous point (outlier) is isolated with very few cuts — it ends up with a **shorter path length** in the tree.

The algorithm:
1. Build an ensemble of `n_estimators=100` random **isolation trees**
2. For each point, compute the average path length across all trees
3. Normalize to an **anomaly score** between −1 and +1:
   - Score near **0** → normal
   - Score near **−1** → very anomalous

```
          Feature Space (latency vs error_rate)
          
          ●  ●  ●  ●              ← normal cluster (many cuts needed)
          ●  ●  ●
          ●  ●  ●  ●
          
                           ★     ← anomaly (isolated in 2-3 cuts)
```

**Why Isolation Forest for microservices?**
- No need to label what "anomaly" means — it's unsupervised
- Works well with multiple correlated features (latency, CPU, errors, throughput, memory)
- Fast inference — suitable for 2-second timeout constraint
- One model per service — each service learns its own normal behavior

---

### 5.2 Training Pipeline

**Source of training data:** TimescaleDB, which stores all historical metrics.

**Schema (TimescaleDB hypertable):**
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

**Training procedure (`trainer.py`):**

```python
def load_history(service_name: str, hours: int = 168) -> np.ndarray:
    # Query last 7 days from TimescaleDB
    cur.execute("""
        SELECT latency_p99, error_rate, throughput_rps, cpu_percent, memory_mb
        FROM service_metrics
        WHERE service_name = %s AND time > NOW() - make_interval(hours => %s)
        ORDER BY time ASC
    """, (service_name, hours))
    rows = cur.fetchall()
    return np.array(rows, dtype=np.float64)
```

Steps:
1. Query last **168 hours (7 days)** per service
2. Require **minimum 50 samples** — skip if insufficient data
3. Build a feature matrix `X` of shape `(n_samples, 5)`
4. Fit `IsolationForest(contamination=0.05, n_estimators=100, random_state=42)`
   - `contamination=0.05` → model expects ~5% of training data to be anomalous
5. Save model to `/models/{service_name}.joblib`

**Features used:**

| Feature | Description | Why it matters |
|---------|-------------|----------------|
| `latency_p99` | P99 latency in ms | Core performance signal |
| `error_rate` | Error percentage | Service health indicator |
| `throughput_rps` | Requests per second | Load signal |
| `cpu_percent` | CPU usage % | Resource saturation |
| `memory_mb` | Memory usage in MB | Resource saturation |

---

### 5.3 Inference Pipeline

When the backend calls `/detect`, the following happens:

```python
def predict(self, service_name: str, metrics: dict) -> dict:
    model = self.models.get(service_name)
    if model is None:
        return {"is_anomaly": False, "score": 0.0, "severity": "none", "trained": False}

    # Build feature vector in the correct order
    X = np.array([[metrics.get(f, 0.0) for f in FEATURES]])
    #              [latency_p99, error_rate, throughput_rps, cpu_percent, memory_mb]

    # decision_function returns raw anomaly score
    score = float(model.decision_function(X)[0])

    # predict returns +1 (normal) or -1 (anomaly)
    is_anomaly = bool(model.predict(X)[0] == -1)

    severity = "low"
    if is_anomaly:
        severity = "high"   if score < -0.30 else \
                   "medium" if score < -0.15 else \
                   "low"

    return {
        "is_anomaly": is_anomaly,
        "score": round(score, 4),
        "severity": severity,
        "trained": True
    }
```

**Score interpretation:**

```
    +0.5          0          -0.15        -0.30        -1.0
      │            │            │            │            │
      ▼            ▼            ▼            ▼            ▼
   clearly      normal       low          medium        high
   normal                   anomaly      anomaly       anomaly
```

**Example response:**
```json
{
  "is_anomaly": true,
  "score": -0.31,
  "severity": "high",
  "trained": true,
  "method": "isolation_forest"
}
```

---

### 5.4 Model Persistence

Models are serialized with `joblib` (Python's efficient binary serializer for scikit-learn objects):

```python
def save_model(self, service_name: str) -> None:
    path = f"/models/{service_name}.joblib"
    joblib.dump(self.models[service_name], path)

def load_model(self, service_name: str) -> bool:
    path = f"/models/{service_name}.joblib"
    if not os.path.exists(path):
        return False
    self.models[service_name] = joblib.load(path)
    return True
```

On **startup**, all existing `.joblib` files are loaded automatically — no cold start. The `/models` directory is mounted as a Docker volume so models survive container restarts.

```
docker-compose.yml:
  ml-service:
    volumes:
      - ./ml-service/models:/models
```

---

### 5.5 Automatic Retraining

A background `asyncio` task runs inside the FastAPI service and retrains all models every **24 hours**:

```python
async def retraining_loop(detector: AnomalyDetector):
    while True:
        await asyncio.sleep(24 * 3600)   # non-blocking sleep
        retrain_all(detector)            # query DB + fit all models
```

This means the models continuously adapt to the system's evolving behavior — if a service naturally gets slower over time (new features), the model adjusts and won't keep firing false alarms.

You can also trigger retraining manually via the API:
```bash
# Retrain one service
curl -X POST http://localhost:8001/train \
  -H "Content-Type: application/json" \
  -d '{"service_name": "checkout"}'

# Retrain all services
curl -X POST http://localhost:8001/train \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

### 5.6 Integration with the Backend

`anomaly-detector.js` calls the ML service for every service on each scrape cycle. The calls are **parallel** (via `Promise.all`) with a strict **2-second timeout**:

```js
async function detectWithML(services) {
  const statAlerts = detectAnomalies(services);   // statistical methods first
  const mlResults = {};

  await Promise.all(services.map(async (svc) => {
    try {
      const { data } = await axios.post(`${ML_SERVICE_URL}/detect`, {
        service_name: svc.name,
        metrics: {
          latency_p99:    svc.latencyP99Ms   || 0,
          error_rate:     svc.errorRatePct   || 0,
          throughput_rps: svc.throughputRps  || 0,
          cpu_percent:    svc.cpuPercent     || 0,
          memory_mb:      svc.memoryMib      || 0,
        },
      }, { timeout: 2000 });     // ← 2 second hard timeout
      mlResults[svc.name] = data;
    } catch { /* ML unavailable — skip silently */ }
  }));

  // ... merge results
}
```

If the ML service is **down, slow, or hasn't trained a model yet** — the system silently falls back to statistical-only detection. Zero service disruption.

---

### 5.7 Combined Verdict Logic

After both pipelines run, results are merged:

```
Statistical alert + ML result → combined_verdict
```

**Case 1: Statistical alert, ML also flags it**
```json
{ "combined_verdict": "confirmed", "ml_score": -0.28 }
```
→ High confidence. Both systems agree.

**Case 2: Statistical alert, ML disagrees**
```json
{ "combined_verdict": "statistical_only", "ml_score": 0.05 }
```
→ Possible false positive. May be a pattern the model has seen before as normal.

**Case 3: ML anomaly, statistics missed it**
```json
{
  "type": "ml_anomaly",
  "combined_verdict": "ml_only",
  "message": "ML détecte une anomalie (score: -0.22, sévérité: medium)"
}
```
→ Multi-feature anomaly. Individually each metric looks normal, but together they form an unusual pattern.

---

## 6. Simulation Engine (What-If)

### 6.1 M/M/c Queueing Theory

The simulation is based on **M/M/c queueing theory** — a mathematical model for a queue with:
- **M** (Markovian) arrival process: Poisson-distributed request arrivals with rate **λ** (req/s)
- **M** service process: exponentially distributed service times with rate **μ** per server
- **c** servers: `c` replicas handling requests in parallel

**Utilization per server:**
```
ρ = λ / (c × μ)
```

**Mean response time (M/M/1 approximation used here):**
```
W = procTimeMs / (1 - ρ)     where ρ < 1
```

When `ρ ≥ 1` (saturated), the queue grows unboundedly. The code models this as:
```js
if (utilisation >= 1) {
  return procTimeMs * (1 + utilisation * 10);  // dramatic latency increase
}
return procTimeMs / Math.max(1 - utilisation, 0.001);
```

**Why M/M/c?** It's the simplest queueing model that captures the key insight: latency does not scale linearly with load. Below ~70% utilization, latency is roughly stable. Above 80%, latency grows superlinearly. This matches real-world microservice behavior.

---

### 6.2 Service Profiles

Each known service has a calibrated profile:

```js
const SERVICE_PROFILES = {
  'payment-service':  { baseProcTimeMs: 20, maxRps: 150 },
  'cart-service':     { baseProcTimeMs: 5,  maxRps: 500 },
  'order-service':    { baseProcTimeMs: 80, maxRps: 100 },
  'cache-store':      { baseProcTimeMs: 1,  maxRps: 5000 },
  // ...
  default:            { baseProcTimeMs: 15, maxRps: 300 },
};
```

`baseProcTimeMs` is the processing time per request at baseline load (μ = 1000 / baseProcTimeMs req/s).

---

### 6.3 Scenarios

#### Load Spike
Multiplies the arrival rate λ by `intensity` at the entry-point service, then propagates 80% of that load to direct dependencies:

```js
const factor = isEntryPoint  ? loadMultiplier
             : isDependency  ? loadMultiplier * 0.8
             : 1.0;
```

Calls `predictServiceMetrics(svc, factor, 1)` which computes the new M/M/c latency.

#### Service Failure
Uses `propagateFailure()` to find all upstream consumers of the failed service and adds:
- `latencyDeltaMs = 500 × severity + baseline.latency × severity × 0.5`
- `errorDeltaPct = 30 × severity`

#### Scale Up
Calls `predictServiceMetrics(svc, currentLoad, replicaCount)` — the M/M/c model with `c` servers, which lowers utilization per server and reduces queue wait.

#### Network Partition
Applies packet-loss-induced latency and errors to the isolated service, then propagates 60% of the cascade effect to consumers.

#### Memory Pressure
Models GC (Garbage Collection) pauses: latency multiplied by `(1 + pressure × 4)`. At full pressure, latency is 5× baseline. Memory usage doubles.

#### Cache Failure
Hardcoded cascade: `cache-store` → 100% error, `cart-service` → 20× latency, `order-service` / `api-gateway` → 5× latency + 40% errors.

---

## 7. Optimization Engine

### 7.1 Level 1 — Rules-Based

At each scrape cycle, `optimization-engine.js` evaluates 4 rules:

```
SLA thresholds:
  maxLatencyMs    = 500ms
  maxErrorPct     = 1%
  maxUtilization  = 80%
  minUtilization  = 30%
```

| Rule | Condition | Output |
|------|-----------|--------|
| Scale up | latency > 500ms AND ρ > 80% | `scale_up` with predicted latency after scaling |
| Dependency issue | latency > 500ms AND ρ < 30% | `dependency_issue` — problem is upstream |
| High errors | error > 1% | `high_errors` |
| Scale down | ρ < 30% AND latency < 250ms | `scale_down` — cost saving |

For `scale_up`, the engine also computes the **predicted latency after scaling** using the M/M/c model, and the improvement percentage:
```js
const predictedLatency = mmcQueueLatency(rps, profile.baseProcTimeMs, optimal);
const gain = ((current - predicted) / current * 100).toFixed(0);
// → "Scale up à 3 replicas réduirait la latence de 62%"
```

---

### 7.2 Level 2 — M/M/c Optimal Scaling

Finds the **minimum** number of replicas `c` such that:
- `ρ = λ / (c × μ) < 0.70`
- `predicted P99 latency < 500ms`

```js
for (let c = 1; c <= 20; c++) {
  const utilization      = arrivalRate / (c * serviceRate);
  const predictedLatency = mmcQueueLatency(arrivalRate, profile.baseProcTimeMs, c);

  if (utilization < 0.70 && predictedLatency < 500) {
    return c;   // minimum viable replica count
  }
}
```

This produces a **full scaling plan** across all services with a summary:
```json
{
  "summary": {
    "totalCurrentReplicas": 8,
    "totalOptimalReplicas": 11,
    "savings": -3
  }
}
```

---

## 8. Closed-Loop Controller

`ControlService.js` acts on anomaly alerts and optimizer recommendations to autonomously scale Docker Swarm services.

### Decision trigger

```
anomaly.severity == "critical" OR "high"
  AND anomaly.details.recommendedReplicas is set
    → scaleService(service, targetReplicas, "anomaly_high_severity")

OR

recommendation.action == "scale_up"
  AND |optimal - current| > 1
    → scaleService(service, optimal, "optimizer_recommendation")
```

### Safety checks (in order)

```
1. Whitelist check
   Is the service in DT_ENABLED_SERVICES?
   If not → decision: SKIP

2. Cooldown check
   Has this service been scaled in the last 5 minutes?
   If yes → decision: COOLDOWN (logs remaining seconds)

3. Max replicas cap
   Cap target at min(target, maxReplicas[service] or 5)
   decision: CAP (if capped)

4. Dry-run check
   If DT_DRY_RUN=true → decision: DRY_RUN (log only, no Docker call)

5. Docker API
   docker.getService(name).update({ Replicated: { Replicas: n } })
   decision: SCALED or ERROR
```

### Action log

Every decision is written to `logs/control-actions.log` as JSONL:
```json
{ "decision": "SCALED",   "service": "checkout", "previous": 1, "replicas": 3, "reason": "anomaly_high_severity", "timestamp": "2026-06-13T19:30:00Z" }
{ "decision": "DRY_RUN",  "service": "payment",  "message": "Would scale to 2 replicas", "timestamp": "2026-06-13T19:30:15Z" }
{ "decision": "COOLDOWN", "service": "checkout", "message": "Cooldown active (240s remaining)", "timestamp": "2026-06-13T19:31:00Z" }
```

All decisions are also published to the `twin.actions` Kafka topic and broadcast to WebSocket clients as a `CONTROL_ACTION` event.

---

## 9. Event-Driven Architecture (Kafka)

Apache Kafka (KRaft mode — no Zookeeper) serves as the **Digital Thread**: an immutable ordered log of every significant event.

### Topic breakdown

| Topic | Published by | When | Message example |
|-------|-------------|------|-----------------|
| `twin.metrics.{service}` | `KafkaPublisher.publishMetrics()` | Every 15s per service | `{ name, latencyP99Ms, throughputRps, errorRatePct, ... }` |
| `twin.anomalies` | `KafkaPublisher.publishAnomaly()` | When anomaly detected | `{ service, type, severity, combined_verdict, ... }` |
| `twin.actions` | `ControlService` via `KafkaPublisher.publishAction()` | On scaling decision | `{ service, decision, previous, replicas, dry_run, ... }` |
| `twin.simulations` | `KafkaPublisher.publishSimulation()` | On POST /api/simulate | `{ scenario, service, intensity, result, ... }` |

### Consumer

`KafkaConsumer` consumes `twin.metrics.*` and calls `StateManager.setState()` — creating a secondary write path separate from the in-memory cache. This enables state replay after a crash.

---

## 10. State Management

Two layers:

**Redis (current state)**
- Key: `dt:state:{serviceName}`
- Value: JSON blob of the latest `ServiceSnapshot`
- TTL: none (always keep latest)
- Used for: fast reads of current service state via `GET /api/state/:id`

**TimescaleDB (history)**
- Table: `service_metrics` (hypertable partitioned by time)
- Retention: no automatic retention configured (all history kept)
- Index: `(service_name, time DESC)` for fast per-service range queries
- Used for: `GET /api/history/:id?hours=24` and ML model training

---

## 11. Real-Time Dashboard

The React frontend connects to the backend via two channels:

### WebSocket (primary)

```js
const ws = new WebSocket('ws://localhost:3001/ws');
ws.onmessage = ({ data }) => {
  const { type, payload } = JSON.parse(data);
  // type: METRICS_UPDATE | PREDICTION | CONTROL_ACTION
};
```

On connect, the backend immediately sends the latest snapshot. After that, updates are pushed every 15 seconds (on each scrape cycle).

### REST polling (fallback)

`useMetrics.js` also polls `GET /api/metrics/services` every 30 seconds as a fallback if the WebSocket connection drops.

### Components

| Component | What it shows |
|-----------|--------------|
| `ServiceMap.jsx` | D3 force-directed graph of service dependencies (nodes = services, edges = call relationships) |
| `MetricsPanel.jsx` | Cards with golden signals per service, color-coded by health score |
| `PerformanceChart.jsx` | Time-series charts for latency, throughput, and error rate (Recharts) |
| `SimulatorControl.jsx` | Scenario selector + intensity slider + before/after comparison |
| `OptimizePanel.jsx` | Rules-based recommendations + M/M/c scaling plan |
| `ControlPanel.jsx` | Closed-loop controller status, dry-run toggle, manual scale |
| `AnomalyFeed.jsx` | Live stream of anomaly alerts sorted by severity |
| `AnomalyHeatmap.jsx` | Service × severity heatmap across time |
| `AnomalyToast.jsx` | Real-time toast notifications for new anomalies |

---

## 12. Demo Mode

When `DEMO_MODE=true`, the backend skips Prometheus and Jaeger entirely and uses `load-injector.js` to generate synthetic data.

**Synthetic snapshot** (`generateSyntheticSnapshot()`):
- Generates realistic baseline metrics for 11 services with Gaussian noise (`±10%`)
- Models load-driven latency increase and error rate increase above 1.5× load

**Synthetic history** (`generateSyntheticHistory()`):
- 60 data points over the requested duration
- Includes a simulated spike 25–35 minutes ago for visual interest

**Synthetic topology** (`generateSyntheticTopology()`):
- Returns a hardcoded graph representing a typical e-commerce microservices architecture
- Same graph as the static `DEPENDENCY_MAP` used by the simulation engine

This means the full pipeline — anomaly detection, ML inference, optimization, simulation — works identically in demo mode. Only the data source changes.
