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
 * Returns all service names discovered from Prometheus metrics.
 */
async function getServiceList() {
  try {
    // Get unique service_name values from OTel Demo metrics
    const resp = await axios.get(`${PROMETHEUS_URL}/api/v1/label/service_name/values`, { timeout: 8000 });
    if (resp.data.status === 'success' && resp.data.data.length > 0) {
      const exclude = ['otelcol-contrib', 'jaeger', 'load-generator', 'frontend-proxy', 'frontend-web'];
      return resp.data.data.filter(s => !exclude.includes(s));
    }
    return [];
  } catch (err) {
    console.error('[PrometheusClient] getServiceList failed:', err.message);
    return [];
  }
}

/**
 * P99 request latency for all services (milliseconds).
 * Uses traces_span_metrics (generated from Jaeger spans) as universal source.
 */
async function getLatencyP99() {
  return queryInstant(
    `histogram_quantile(0.99, sum(rate(traces_span_metrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_SERVER"}[10m])) by (service_name, le))`
  );
}

/**
 * Request rate (RPS) per service.
 */
async function getThroughput() {
  return queryInstant(
    `sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}[10m])) by (service_name)`
  );
}

/**
 * Error rate per service (based on span status ERROR).
 */
async function getErrorRates() {
  return queryInstant(`
    sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}[10m])) by (service_name)
    /
    sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}[10m])) by (service_name)
  `);
}

/**
 * CPU usage per service (millicores) - uses container metrics from OTel collector.
 */
async function getCpuUsage() {
  return queryInstant(
    `sum(rate(container_cpu_usage_nanoseconds_total[5m])) by (service_name) / 1e6`
  );
}

/**
 * Memory usage per service (MiB).
 */
async function getMemoryUsage() {
  return queryInstant(
    `sum(container_memory_usage_total_bytes) by (service_name) / 1048576`
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
 */
async function getLatencyHistory(serviceName, durationMinutes = 60) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - durationMinutes * 60;
  return queryRange(
    `histogram_quantile(0.99, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="${serviceName}", span_kind="SPAN_KIND_SERVER"}[10m])) by (le))`,
    start, now, '1m'
  );
}

/**
 * Throughput history for a single service.
 */
async function getThroughputHistory(serviceName, durationMinutes = 60) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - durationMinutes * 60;
  return queryRange(
    `sum(rate(traces_span_metrics_calls_total{service_name="${serviceName}", span_kind="SPAN_KIND_SERVER"}[10m]))`,
    start, now, '1m'
  );
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
