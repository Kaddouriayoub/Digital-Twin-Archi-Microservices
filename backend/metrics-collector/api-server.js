// ============================================================
// api-server.js  — Layer 2: Express REST API + WebSocket hub
// The main entry point for the Digital Twin backend.
// ============================================================
'use strict';

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const morgan     = require('morgan');
const http       = require('http');
const WebSocket  = require('ws');
const NodeCache  = require('node-cache');

const prometheus  = require('./prometheus-client');
const transformer = require('./data-transformer');
const simulator   = require('../simulator/scenario-engine');
const loadInjector = require('../simulator/load-injector');

const DEMO_MODE = process.env.DEMO_MODE === 'true';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3001;
const SCRAPE_INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MS || '15000', 10);
const cache           = new NodeCache({ stdTTL: 60, checkperiod: 30 });

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

// ─────────────────────────────────────────────────────────────
// Core scrape + cache cycle
// ─────────────────────────────────────────────────────────────
let latestSnapshot = null;

async function collectMetrics() {
  try {
    if (DEMO_MODE) {
      // ── Synthetic (demo) path ──────────────────────────────
      const services  = loadInjector.generateSyntheticSnapshot();
      const topology  = loadInjector.generateSyntheticTopology();
      latestSnapshot  = { collectedAt: Date.now(), services, topology };
      cache.set('snapshot', latestSnapshot);
      broadcast({ type: 'METRICS_UPDATE', payload: latestSnapshot });
      console.log(`[Collector][DEMO] Generated synthetic snapshot for ${services.length} services`);
      return;
    }

    // ── Real Prometheus path ───────────────────────────────
    const [
      services,
      latencyRaw,
      rpsRaw,
      errorsRaw,
      cpuRaw,
      memRaw,
      topoRaw,
    ] = await Promise.all([
      prometheus.getServiceList(),
      prometheus.getLatencyP99(),
      prometheus.getThroughput(),
      prometheus.getErrorRates(),
      prometheus.getCpuUsage(),
      prometheus.getMemoryUsage(),
      prometheus.getTopologyEdges(),
    ]);

    const latency  = transformer.transformLatencyP99(latencyRaw);
    const rps      = transformer.transformThroughput(rpsRaw);
    const errors   = transformer.transformErrorRates(errorsRaw);
    const cpuPods  = transformer.transformCpuUsage(cpuRaw);
    const memPods  = transformer.transformMemoryUsage(memRaw);
    const topology = transformer.transformTopology(topoRaw);

    const serviceSnapshots = transformer.buildServiceSnapshots(
      services, latency, rps, errors, cpuPods, memPods
    );

    latestSnapshot = {
      collectedAt: Date.now(),
      services: serviceSnapshots,
      topology,
    };

    cache.set('snapshot', latestSnapshot);
    broadcast({ type: 'METRICS_UPDATE', payload: latestSnapshot });
    console.log(`[Collector] Scraped ${services.length} services @ ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[Collector] Collection cycle failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// WebSocket broadcast helper
// ─────────────────────────────────────────────────────────────
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  // Send the latest snapshot immediately on connect
  if (latestSnapshot) {
    ws.send(JSON.stringify({ type: 'METRICS_UPDATE', payload: latestSnapshot }));
  }
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ─────────────────────────────────────────────────────────────
// REST Routes
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Simple liveness probe.
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
});

/**
 * GET /api/metrics/services
 * Returns all services with their current golden-signal metrics.
 */
app.get('/api/metrics/services', (_req, res) => {
  const snapshot = cache.get('snapshot');
  if (!snapshot) {
    return res.status(503).json({ error: 'Metrics not yet collected — retry in a few seconds.' });
  }
  res.json(snapshot);
});

/**
 * GET /api/metrics/service/:name
 * Returns detailed metrics for one service including time-series history.
 */
app.get('/api/metrics/service/:name', async (req, res) => {
  const { name } = req.params;
  const durationMin = parseInt(req.query.duration || '60', 10);

  const snapshot = cache.get('snapshot');
  const serviceInfo = snapshot?.services?.find(s => s.name === name);

  if (!serviceInfo) {
    return res.status(404).json({ error: `Service "${name}" not found.` });
  }

  if (DEMO_MODE) {
    const latencyHistory = loadInjector.generateSyntheticHistory(name, 'latency', durationMin);
    const rpsHistory     = loadInjector.generateSyntheticHistory(name, 'throughput', durationMin);
    return res.json({
      ...serviceInfo,
      history: { latency: latencyHistory, throughput: rpsHistory },
    });
  }

  const [latencyHistory, rpsHistory] = await Promise.all([
    prometheus.getLatencyHistory(name, durationMin),
    prometheus.getThroughputHistory(name, durationMin),
  ]);

  res.json({
    ...serviceInfo,
    history: {
      latency:    transformer.transformTimeSeries(latencyHistory, 'ms'),
      throughput: transformer.transformTimeSeries(rpsHistory, 'rps'),
    },
  });
});

/**
 * GET /api/topology
 * Returns the service dependency graph (nodes + edges).
 */
app.get('/api/topology', (_req, res) => {
  const snapshot = cache.get('snapshot');
  if (!snapshot) {
    return res.status(503).json({ error: 'Topology not yet available.' });
  }
  res.json(snapshot.topology);
});

/**
 * POST /api/simulate
 * Body: { scenario: 'load_spike' | 'service_failure' | 'scale_up' | 'network_partition',
 *          service: string, intensity: number (0-1) }
 *
 * Returns the predicted metrics after applying the scenario to the current snapshot.
 */
app.post('/api/simulate', (req, res) => {
  const { scenario, service, intensity = 0.5, config = {} } = req.body;
  const snapshot = cache.get('snapshot');

  if (!snapshot) {
    return res.status(503).json({ error: 'No baseline metrics available for simulation.' });
  }

  if (!scenario) {
    return res.status(400).json({ error: 'Missing required field: scenario' });
  }

  try {
    const result = simulator.runScenario({
      scenario,
      service,
      intensity,
      config,
      baseline: snapshot.services,
    });
    res.json({ scenario, service, intensity, result, simulatedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/simulate/scenarios
 * Returns the list of available scenarios with descriptions.
 */
app.get('/api/simulate/scenarios', (_req, res) => {
  res.json(simulator.getAvailableScenarios());
});

/**
 * GET /api/metrics/prometheus/status
 * Checks Prometheus connectivity.
 */
app.get('/api/metrics/prometheus/status', async (_req, res) => {
  try {
    const resp = await require('axios').get(
      `${process.env.PROMETHEUS_URL || 'http://localhost:9090'}/-/ready`,
      { timeout: 5000 }
    );
    res.json({ connected: true, status: resp.status });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
async function start() {
  console.log(`[Server] Starting Digital Twin Backend on :${PORT}`);
  console.log(`[Server] Prometheus: ${process.env.PROMETHEUS_URL || 'http://localhost:9090'}`);
  console.log(`[Server] Scrape interval: ${SCRAPE_INTERVAL}ms`);

  // Initial collection
  await collectMetrics();

  // Recurring scrape cycle
  setInterval(collectMetrics, SCRAPE_INTERVAL);

  server.listen(PORT, () => {
    console.log(`[Server] REST API  → http://localhost:${PORT}/api`);
    console.log(`[Server] WebSocket → ws://localhost:${PORT}/ws`);
  });
}

start().catch(err => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
