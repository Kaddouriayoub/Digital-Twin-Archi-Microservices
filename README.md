# Digital Twin for Microservices

A real-time digital twin platform that visualizes, monitors, and simulates microservices performance metrics. Designed to work with any OpenTelemetry-instrumented microservices architecture.

Built as a PFA (Projet de Fin d'Année) project at ENSIAS.

## Features

- **Real-time monitoring** — Golden signals (latency, throughput, errors) via Prometheus
- **Topology auto-discovery** — Service dependency graph from Jaeger traces
- **What-if simulation** — 6 scenarios (load spike, service failure, scale up, network partition, memory pressure, cache miss) using M/M/c queueing theory
- **Live dashboard** — WebSocket push updates with REST polling fallback
- **Demo mode** — Synthetic data for development without a live cluster

## Architecture

```
├── backend/                  # Node.js/Express API server
│   ├── metrics-collector/    # Prometheus & Jaeger data collection + REST API
│   │   ├── api-server.js        # Main entry point (REST + WebSocket)
│   │   ├── prometheus-client.js  # Prometheus PromQL queries
│   │   ├── jaeger-client.js      # Jaeger tracing API client
│   │   ├── topology-discovery.js # Auto-discovery of service dependencies
│   │   └── data-transformer.js   # Raw metrics normalization
│   └── simulator/            # What-if scenario simulation engine
│       ├── scenario-engine.js    # 6 scenario handlers
│       ├── performance-model.js  # M/M/c queueing model
│       └── load-injector.js      # Synthetic data for demo mode
├── frontend/                 # React + Vite dashboard
│   └── src/
│       ├── components/       # UI components (topology graph, charts, simulator)
│       ├── hooks/            # State management (WebSocket + REST)
│       └── api/              # API client
├── docker-compose.yml              # Standalone deployment (includes Prometheus + Jaeger)
└── docker-compose.otel-demo.yml    # Connect to OpenTelemetry Demo
```

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (ws), Prometheus client, Jaeger client
- **Frontend:** React 18, Vite, Recharts, D3.js (force-directed graph), Lucide icons
- **Observability:** Prometheus (metrics), Jaeger (tracing & topology), OpenTelemetry
- **Infrastructure:** Docker, Docker Compose

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (for local development only)

### Option 1: Connect to OpenTelemetry Demo (real metrics)

This connects the Digital Twin to a real instrumented microservices architecture (15 services).

```bash
# 1. Clone and start the OpenTelemetry Demo
git clone https://github.com/open-telemetry/opentelemetry-demo.git
cd opentelemetry-demo
docker compose -f compose.yaml -f compose.observability.yaml up -d

# 2. Wait for services to be ready (~2-3 min)
docker compose -f compose.yaml -f compose.observability.yaml ps

# 3. Start the Digital Twin
cd /path/to/Digital-Twin-Archi-Microservices
docker compose -f docker-compose.otel-demo.yml up --build
```

**URLs:**
| Service | URL |
|---------|-----|
| Digital Twin Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001/api |
| Prometheus | http://localhost:9090 |
| OTel Demo Shop | http://localhost:8080 |

> **Tip:** Increase traffic via the Locust load generator (check port with `docker port load-generator 8089`)

**To stop everything:**
```bash
cd /path/to/Digital-Twin-Archi-Microservices
docker compose -f docker-compose.otel-demo.yml down

cd /path/to/opentelemetry-demo
docker compose -f compose.yaml -f compose.observability.yaml down
```

### Option 2: Demo Mode (synthetic data, no dependencies)

```bash
docker compose up --build
```

Or set `DEMO_MODE=true` in `backend/.env` and run locally:
```bash
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

### Option 3: Local Development

```bash
# Backend
cd backend
cp .env.example .env
npm install
npm run dev

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/metrics/services` | GET | All services with golden-signal metrics |
| `/api/metrics/service/:name` | GET | Detailed metrics + history for one service |
| `/api/topology` | GET | Service dependency graph (nodes + edges) |
| `/api/topology/discover` | GET | Force topology re-discovery from Jaeger |
| `/api/simulate` | POST | Run a what-if scenario |
| `/api/simulate/scenarios` | GET | List available scenarios |
| `/api/metrics/prometheus/status` | GET | Prometheus connectivity check |
| `/api/metrics/jaeger/status` | GET | Jaeger connectivity + discovered dependencies |

## Simulation Scenarios

| Scenario | Description |
|----------|-------------|
| Load Spike | Sudden traffic surge — predicts latency/error impact |
| Service Failure | Complete/partial outage with cascading failure propagation |
| Scale Up | Add replicas — predicts latency improvement (M/M/c model) |
| Network Partition | Packet loss between services |
| Memory Pressure | GC pauses and OOM risk simulation |
| Cache Failure | Cache store down — fallback to direct DB calls |

## Configuration

See `backend/.env.example` for all environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Backend server port |
| `PROMETHEUS_URL` | http://localhost:9090 | Prometheus instance URL |
| `JAEGER_URL` | http://localhost:16686 | Jaeger query API URL |
| `SCRAPE_INTERVAL_MS` | 15000 | Metrics scrape interval (ms) |
| `DEMO_MODE` | true | Use synthetic data |
