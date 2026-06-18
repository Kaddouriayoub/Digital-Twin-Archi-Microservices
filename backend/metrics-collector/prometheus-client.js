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
 * Merge results from multiple metric sources, preferring non-zero values.
 * Supports both service_name and job labels.
 */
function mergeResults(...arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const item of arr) {
      const name = item.metric.service_name || item.metric.job;
      if (!name) continue;
      const val = parseFloat(item.value[1]);
      if (!map.has(name) || (val > 0 && parseFloat(map.get(name).value[1]) === 0)) {
        // Normalize: ensure service_name exists
        if (!item.metric.service_name) item.metric.service_name = name;
        map.set(name, item);
      }
    }
  }
  return [...map.values()];
}

/**
 * Returns all service names discovered from Prometheus metrics.
 */
async function getServiceList() {
  try {
    // Strategy 1: spanmetrics (HotROD/Jaeger)
    const results = await queryInstant(
      `count(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}) by (service_name)`
    );
    if (results.length > 0) {
      const exclude = ['jaeger', 'otelcol-contrib'];
      return results
        .map(r => r.metric.service_name)
        .filter(s => s && !exclude.includes(s));
    }
    // Strategy 2: OTel service_name label
    const resp = await axios.get(`${PROMETHEUS_URL}/api/v1/label/service_name/values`, { timeout: 8000 });
    if (resp.data.status === 'success' && resp.data.data.length > 0) {
      const exclude = ['otelcol-contrib', 'jaeger', 'load-generator', 'frontend-proxy', 'frontend-web'];
      return resp.data.data.filter(s => !exclude.includes(s));
    }
    // Strategy 3: Sock Shop style — job label from request_duration_seconds
    const sockShop = await queryInstant(`count(request_duration_seconds_count) by (job)`);
    if (sockShop.length > 0) {
      const exclude = ['node-exporter'];
      return sockShop.map(r => r.metric.job).filter(s => s && !exclude.includes(s));
    }
    return [];
  } catch (err) {
    console.error('[PrometheusClient] getServiceList failed:', err.message);
    return [];
  }
}

/**
 * P99 request latency for all services (milliseconds).
 * Combines HTTP and gRPC server metrics from OTel Demo + spanmetrics from Jaeger.
 */
async function getLatencyP99() {
  const [httpSec, rpcSec, httpMs, rpcMs, spanMs, sockShop] = await Promise.all([
    queryInstant(
      `histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket[5m])) by (service_name, le)) * 1000`
    ),
    queryInstant(
      `histogram_quantile(0.99, sum(rate(rpc_server_call_duration_seconds_bucket[5m])) by (service_name, le)) * 1000`
    ),
    queryInstant(
      `histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket[5m])) by (service_name, le))`
    ),
    queryInstant(
      `histogram_quantile(0.99, sum(rate(rpc_server_duration_milliseconds_bucket[5m])) by (service_name, le))`
    ),
    queryInstant(
      `histogram_quantile(0.99, sum(rate(traces_span_metrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_SERVER"}[5m])) by (service_name, le))`
    ),
    queryInstant(
      `histogram_quantile(0.99, sum(rate(request_duration_seconds_bucket[5m])) by (job, le)) * 1000`
    ),
  ]);
  return mergeResults(httpSec, rpcSec, httpMs, rpcMs, spanMs, sockShop);
}

/**
 * Request rate (RPS) per service.
 */
async function getThroughput() {
  const [httpSec, rpcSec, httpMs, rpcMs, spanCalls, sockShop] = await Promise.all([
    queryInstant(
      `sum(rate(http_server_request_duration_seconds_count[5m])) by (service_name)`
    ),
    queryInstant(
      `sum(rate(rpc_server_call_duration_seconds_count[5m])) by (service_name)`
    ),
    queryInstant(
      `sum(rate(http_server_duration_milliseconds_count[5m])) by (service_name)`
    ),
    queryInstant(
      `sum(rate(rpc_server_duration_milliseconds_count[5m])) by (service_name)`
    ),
    queryInstant(
      `sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m])) by (service_name)`
    ),
    queryInstant(
      `sum(rate(request_duration_seconds_count[5m])) by (job)`
    ),
  ]);
  return mergeResults(httpSec, rpcSec, httpMs, rpcMs, spanCalls, sockShop);
}

/**
 * Error rate per service (HTTP 5xx / total).
 */
async function getErrorRates() {
  const [http, rpc, httpMs, rpcMs, spanErr, sockShop] = await Promise.all([
    queryInstant(`
      sum(rate(http_server_request_duration_seconds_count{http_status_code=~"5.."}[5m])) by (service_name)
      /
      sum(rate(http_server_request_duration_seconds_count[5m])) by (service_name)
    `),
    queryInstant(`
      sum(rate(rpc_server_call_duration_seconds_count{rpc_grpc_status_code!="0"}[5m])) by (service_name)
      /
      sum(rate(rpc_server_call_duration_seconds_count[5m])) by (service_name)
    `),
    queryInstant(`
      sum(rate(http_server_duration_milliseconds_count{http_status_code=~"5.."}[5m])) by (service_name)
      /
      sum(rate(http_server_duration_milliseconds_count[5m])) by (service_name)
    `),
    queryInstant(`
      sum(rate(rpc_server_duration_milliseconds_count{rpc_grpc_status_code!="0"}[5m])) by (service_name)
      /
      sum(rate(rpc_server_duration_milliseconds_count[5m])) by (service_name)
    `),
    queryInstant(`
      sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER",status_code="STATUS_CODE_ERROR"}[5m])) by (service_name)
      /
      sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m])) by (service_name)
    `),
    queryInstant(`
      sum(rate(request_duration_seconds_count{status_code=~"5.."}[5m])) by (job)
      /
      sum(rate(request_duration_seconds_count[5m])) by (job)
    `),
  ]);
  return mergeResults(http, rpc, httpMs, rpcMs, spanErr, sockShop);
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
  const [httpSec, rpcSec, httpMs, rpcMs, spanMs] = await Promise.all([
    queryRange(
      `histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket{service_name="${serviceName}"}[5m])) by (le)) * 1000`,
      start, now, '1m'
    ),
    queryRange(
      `histogram_quantile(0.99, sum(rate(rpc_server_call_duration_seconds_bucket{service_name="${serviceName}"}[5m])) by (le)) * 1000`,
      start, now, '1m'
    ),
    queryRange(
      `histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{service_name="${serviceName}"}[5m])) by (le))`,
      start, now, '1m'
    ),
    queryRange(
      `histogram_quantile(0.99, sum(rate(rpc_server_duration_milliseconds_bucket{service_name="${serviceName}"}[5m])) by (le))`,
      start, now, '1m'
    ),
    queryRange(
      `histogram_quantile(0.99, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="${serviceName}",span_kind="SPAN_KIND_SERVER"}[5m])) by (le))`,
      start, now, '1m'
    ),
  ]);
  return httpSec.length > 0 ? httpSec : rpcSec.length > 0 ? rpcSec : httpMs.length > 0 ? httpMs : rpcMs.length > 0 ? rpcMs : spanMs;
}

/**
 * Throughput history for a single service.
 */
async function getThroughputHistory(serviceName, durationMinutes = 60) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - durationMinutes * 60;
  const [httpSec, rpcSec, httpMs, rpcMs, spanCalls] = await Promise.all([
    queryRange(
      `sum(rate(http_server_request_duration_seconds_count{service_name="${serviceName}"}[5m]))`,
      start, now, '1m'
    ),
    queryRange(
      `sum(rate(rpc_server_call_duration_seconds_count{service_name="${serviceName}"}[5m]))`,
      start, now, '1m'
    ),
    queryRange(
      `sum(rate(http_server_duration_milliseconds_count{service_name="${serviceName}"}[5m]))`,
      start, now, '1m'
    ),
    queryRange(
      `sum(rate(rpc_server_duration_milliseconds_count{service_name="${serviceName}"}[5m]))`,
      start, now, '1m'
    ),
    queryRange(
      `sum(rate(traces_span_metrics_calls_total{service_name="${serviceName}",span_kind="SPAN_KIND_SERVER"}[5m]))`,
      start, now, '1m'
    ),
  ]);
  return httpSec.length > 0 ? httpSec : rpcSec.length > 0 ? rpcSec : httpMs.length > 0 ? httpMs : rpcMs.length > 0 ? rpcMs : spanCalls;
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
