// ============================================================
// prometheus-client.js  — Layer 2: Prometheus Query Builder
// Queries the Prometheus HTTP API and returns raw metric data.
// ============================================================
'use strict';

const axios = require('axios');

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';

// ──────────────────────────────────────────────
// Low-level helpers
// ──────────────────────────────────────────────

/**
 * Run an instant PromQL query.
 * @param {string} query - PromQL expression
 * @returns {Promise<Array>} - result array
 */
async function queryInstant(query) {
  try {
    const resp = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
      params: { query },
      timeout: 10000,
    });
    if (resp.data.status !== 'success') {
      throw new Error(`Prometheus error: ${resp.data.error}`);
    }
    return resp.data.data.result;
  } catch (err) {
    console.error(`[PrometheusClient] queryInstant failed — ${query}: ${err.message}`);
    return [];
  }
}

/**
 * Run a range PromQL query.
 * @param {string} query
 * @param {number} startSec - unix seconds
 * @param {number} endSec
 * @param {string} step   - e.g. "15s", "1m"
 */
async function queryRange(query, startSec, endSec, step = '15s') {
  try {
    const resp = await axios.get(`${PROMETHEUS_URL}/api/v1/query_range`, {
      params: { query, start: startSec, end: endSec, step },
      timeout: 15000,
    });
    if (resp.data.status !== 'success') {
      throw new Error(`Prometheus error: ${resp.data.error}`);
    }
    return resp.data.data.result;
  } catch (err) {
    console.error(`[PrometheusClient] queryRange failed — ${query}: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────
// Exported high-level query functions
// ──────────────────────────────────────────────

/**
 * Returns all service names discovered from Prometheus targets.
 */
async function getServiceList() {
  try {
    const resp = await axios.get(`${PROMETHEUS_URL}/api/v1/targets`, { timeout: 8000 });
    const activeTargets = resp.data.data.activeTargets || [];
    const services = new Set();
    activeTargets.forEach(t => {
      const app = t.labels.app || t.labels.job || t.labels.service;
      if (app) services.add(app);
    });
    return Array.from(services);
  } catch (err) {
    console.error('[PrometheusClient] getServiceList failed:', err.message);
    // Fallback: return the known Online Boutique service list
    return [
      'frontend', 'cartservice', 'productcatalogservice', 'currencyservice',
      'paymentservice', 'shippingservice', 'emailservice', 'checkoutservice',
      'recommendationservice', 'adservice', 'redis-cart',
    ];
  }
}

/**
 * P99 request latency for all services (seconds).
 * Expects Istio or OpenTelemetry metrics.
 */
async function getLatencyP99() {
  // Istio sidecar metric
  const query = `histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket[5m])) by (destination_service_name, le))`;
  const results = await queryInstant(query);
  if (results.length > 0) return results;

  // Fallback: generic OTEL http server histogram
  return queryInstant(
    `histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket[5m])) by (job, le))`
  );
}

/**
 * Request rate (RPS) per service.
 */
async function getThroughput() {
  const query = `sum(rate(istio_requests_total[1m])) by (destination_service_name)`;
  const results = await queryInstant(query);
  if (results.length > 0) return results;

  return queryInstant(`sum(rate(http_server_requests_total[1m])) by (job)`);
}

/**
 * Error rate (4xx + 5xx) per service.
 */
async function getErrorRates() {
  const query = `
    sum(rate(istio_requests_total{response_code=~"[45][0-9][0-9]"}[5m])) by (destination_service_name)
    /
    sum(rate(istio_requests_total[5m])) by (destination_service_name)
  `;
  const results = await queryInstant(query);
  if (results.length > 0) return results;

  return queryInstant(
    `sum(rate(http_server_requests_total{status=~"[45][0-9][0-9]"}[5m])) by (job)
     /
     sum(rate(http_server_requests_total[5m])) by (job)`
  );
}

/**
 * CPU usage per Pod (millicores).
 */
async function getCpuUsage() {
  return queryInstant(
    `sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (pod) * 1000`
  );
}

/**
 * Memory usage per Pod (MiB).
 */
async function getMemoryUsage() {
  return queryInstant(
    `sum(container_memory_working_set_bytes{container!=""}) by (pod) / 1048576`
  );
}

/**
 * Service-to-service request rate topology.
 * Returns edges: source → destination.
 */
async function getTopologyEdges() {
  const query = `sum(rate(istio_requests_total[5m])) by (source_app, destination_service_name)`;
  return queryInstant(query);
}

/**
 * P99 latency over a time range for a single service (for charts).
 * @param {string} serviceName
 * @param {number} durationMinutes - how far back
 */
async function getLatencyHistory(serviceName, durationMinutes = 60) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - durationMinutes * 60;
  const query = `histogram_quantile(0.99,
    sum(rate(istio_request_duration_milliseconds_bucket{destination_service_name="${serviceName}"}[5m])) by (le)
  )`;
  return queryRange(query, start, now, '1m');
}

/**
 * Throughput history for a single service.
 */
async function getThroughputHistory(serviceName, durationMinutes = 60) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - durationMinutes * 60;
  const query = `sum(rate(istio_requests_total{destination_service_name="${serviceName}"}[1m]))`;
  return queryRange(query, start, now, '1m');
}

module.exports = {
  queryInstant,
  queryRange,
  getServiceList,
  getLatencyP99,
  getThroughput,
  getErrorRates,
  getCpuUsage,
  getMemoryUsage,
  getTopologyEdges,
  getLatencyHistory,
  getThroughputHistory,
};
