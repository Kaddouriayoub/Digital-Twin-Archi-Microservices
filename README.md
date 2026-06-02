# Digital Twin for Microservices

A real-time digital twin platform that visualizes, monitors, and simulates microservices performance metrics. Designed to work with any microservices architecture. Built as a PFA (Projet de Fin d'Année) project at ENSIAS.

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
├── k8s-manifests/            # Kubernetes deployment manifests
└── docker-compose.yml        # Local development orchestration
```

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (ws), Prometheus client, Jaeger client
- **Frontend:** React 18, Vite, Recharts, D3.js (force-directed graph), Lucide icons
- **Observability:** Prometheus (metrics), Jaeger (tracing & topology discovery), OpenTelemetry
- **Infrastructure:** Docker, Kubernetes, Nginx

## Getting Started

### Prerequisites

- Node.js 18+
- Docker & Docker Compose

### Quick Start (Docker)

```bash
docker-compose up --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001/api
- WebSocket: ws://localhost:3001/ws
- Jaeger UI: http://localhost:16686

### Local Development

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

### Demo Mode

Set `DEMO_MODE=true` in the backend `.env` to use synthetic data without a live Prometheus/Jaeger cluster.

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

## Configuration

See `backend/.env.example` for all available environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Backend server port |
| `PROMETHEUS_URL` | http://localhost:9090 | Prometheus instance URL |
| `JAEGER_URL` | http://localhost:16686 | Jaeger query API URL |
| `SCRAPE_INTERVAL_MS` | 15000 | Metrics scrape interval (ms) |
| `DEMO_MODE` | true | Use synthetic data |

## Connecting to a Real Architecture

To monitor a real microservices architecture:

1. Set `DEMO_MODE=false`
2. Point `PROMETHEUS_URL` to your Prometheus instance
3. Point `JAEGER_URL` to your Jaeger query endpoint
4. Your services must expose metrics via Istio or OpenTelemetry
5. The topology will be auto-discovered from Jaeger traces
