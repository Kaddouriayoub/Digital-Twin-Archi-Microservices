# Digital Twin for Microservices

A real-time digital twin platform that visualizes and simulates microservices performance metrics. Built as a PFA (Projet de Fin d'Année) project at ENSIAS.

## Architecture

```
├── backend/                  # Node.js/Express API server
│   ├── metrics-collector/    # Prometheus metrics collection & REST API
│   └── simulator/            # Load injection & scenario simulation engine
├── frontend/                 # React + Vite dashboard
│   └── src/
│       ├── components/       # UI components (charts, graphs)
│       ├── hooks/            # Custom React hooks
│       └── api/              # API client
├── k8s-manifests/            # Kubernetes deployment manifests
└── docker-compose.yml        # Local development orchestration
```

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (ws), Prometheus client
- **Frontend:** React 18, Vite, Recharts, D3.js, Lucide icons
- **Infrastructure:** Docker, Kubernetes, Prometheus

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

Set `DEMO_MODE=true` in the backend `.env` to use synthetic data without a live Prometheus/Kubernetes cluster.

## API Endpoints

- `GET /api/health` — Health check
- Backend exposes metrics collection and simulation APIs on port 3001

## Configuration

See `backend/.env.example` for all available environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Backend server port |
| `PROMETHEUS_URL` | http://localhost:9090 | Prometheus instance URL |
| `SCRAPE_INTERVAL_MS` | 15000 | Metrics scrape interval (ms) |
| `DEMO_MODE` | true | Use synthetic data |
