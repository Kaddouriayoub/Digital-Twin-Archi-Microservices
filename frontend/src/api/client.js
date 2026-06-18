// ============================================================
// src/api/client.js — Layer 3: Frontend API client
// Wraps all backend REST calls with error handling.
// ============================================================

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

async function apiFetch(path, options = {}) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `API error ${resp.status}`);
  }
  return resp.json();
}

/** GET /api/metrics/services — full snapshot of all services */
export const fetchServicesSnapshot = () => apiFetch('/metrics/services');

/** GET /api/metrics/service/:name?duration=60 — one service detail */
export const fetchServiceDetail = (name, duration = 60) =>
  apiFetch(`/metrics/service/${name}?duration=${duration}`);

/** GET /api/topology — nodes + edges */
export const fetchTopology = () => apiFetch('/topology');

/** GET /api/simulate/scenarios — available what-if scenarios */
export const fetchScenarios = () => apiFetch('/simulate/scenarios');

/** POST /api/simulate — run a scenario */
export const runSimulation = (body) =>
  apiFetch('/simulate', { method: 'POST', body: JSON.stringify(body) });

/** GET /api/health */
export const fetchHealth = () => apiFetch('/health');

/** GET /api/metrics/prometheus/status */
export const fetchPrometheusStatus = () => apiFetch('/metrics/prometheus/status');

/** GET /api/kafka/status */
export const fetchKafkaStatus = () => apiFetch('/kafka/status');

/** GET /api/ml-status */
export const fetchMlStatus = () => apiFetch('/ml-status');

/** GET /api/control/status */
export const fetchControlStatus = () => apiFetch('/control/status');

/** POST /api/control/scale */
export const manualScale = (service, replicas, reason = 'manual') =>
  apiFetch('/control/scale', { method: 'POST', body: JSON.stringify({ service, replicas, reason }) });

/** POST /api/control/toggle-dryrun */
export const toggleDryRun = () => apiFetch('/control/toggle-dryrun', { method: 'POST' });

/** GET /api/history/:serviceId?hours=N */
export const fetchHistory = (serviceId, hours = 24) =>
  apiFetch(`/history/${serviceId}?hours=${hours}`);
