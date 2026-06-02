// ============================================================
// data-transformer.js  — Layer 2: Normalize & Aggregate Metrics
// Converts raw Prometheus result arrays into clean domain objects
// that the frontend and simulator can consume directly.
// ============================================================
'use strict';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Pull a label value from an Istio or OTel metric result item. */
function extractServiceName(metricLabels) {
  return (
    metricLabels.destination_service_name ||
    metricLabels.exported_job             ||
    metricLabels.job                      ||
    metricLabels.app                      ||
    metricLabels.service                  ||
    'unknown'
  );
}

function extractPodName(metricLabels) {
  return metricLabels.pod || metricLabels.container || 'unknown';
}

/** Safe float parse — returns 0 when the value is NaN / null / undefined. */
function safeFloat(v, decimals = 4) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : parseFloat(n.toFixed(decimals));
}

// ─────────────────────────────────────────────────────────────
// Transformers
// ─────────────────────────────────────────────────────────────

/**
 * Transform P99 latency instant results.
 * Prometheus returns milliseconds (Istio) or seconds (OTel).
 * We normalise everything to milliseconds.
 *
 * @param {Array} results - raw Prometheus instant result array
 * @returns {Record<string, number>} - { serviceName: latencyMs }
 */
function transformLatencyP99(results) {
  const out = {};
  results.forEach(item => {
    const svc = extractServiceName(item.metric);
    let val = safeFloat(item.value[1]);
    // Only convert if value looks like seconds (< 1), otherwise assume ms
    if (val > 0 && val < 1) val = val * 1000;
    out[svc] = safeFloat(val, 2);
  });
  return out;
}

/**
 * Transform throughput (RPS) instant results.
 * @returns {Record<string, number>} - { serviceName: rps }
 */
function transformThroughput(results) {
  const out = {};
  results.forEach(item => {
    const svc = extractServiceName(item.metric);
    out[svc] = safeFloat(item.value[1], 2);
  });
  return out;
}

/**
 * Transform error rate instant results.
 * @returns {Record<string, number>} - { serviceName: errorRatePct } (0–100)
 */
function transformErrorRates(results) {
  const out = {};
  results.forEach(item => {
    const svc = extractServiceName(item.metric);
    out[svc] = safeFloat(item.value[1] * 100, 2);
  });
  return out;
}

/**
 * Transform CPU usage — group by pod, aggregate per service prefix.
 * @returns {Record<string, number>} - { serviceName: millicores }
 */
function transformCpuUsage(results) {
  const podMap = {};
  results.forEach(item => {
    const pod = extractPodName(item.metric);
    podMap[pod] = safeFloat(item.value[1], 1);
  });
  return podMap;
}

/**
 * Transform memory usage.
 * @returns {Record<string, number>} - { podName: mib }
 */
function transformMemoryUsage(results) {
  const podMap = {};
  results.forEach(item => {
    const pod = extractPodName(item.metric);
    podMap[pod] = safeFloat(item.value[1], 1);
  });
  return podMap;
}

/**
 * Transform topology edge data into a graph object.
 * @param {Array} results - raw Prometheus instant result
 * @returns {{ nodes: Array, edges: Array }}
 */
function transformTopology(results) {
  const nodeSet = new Set();
  const edges = [];

  results.forEach(item => {
    const src = item.metric.source_app || 'external';
    const dst = item.metric.destination_service_name || 'unknown';
    const rps = safeFloat(item.value[1], 2);

    if (rps === 0) return; // prune silent edges

    nodeSet.add(src);
    nodeSet.add(dst);
    edges.push({ source: src, target: dst, rps });
  });

  const nodes = Array.from(nodeSet).map(id => ({ id }));
  return { nodes, edges };
}

/**
 * Transform a range query result into chart-ready [timestamp, value] pairs.
 * @param {Array} results - range query result (usually 1 series)
 * @param {string} [unit='ms'] - 's' → convert to ms
 * @returns {Array<{ timestamp: number, value: number }>}
 */
function transformTimeSeries(results, unit = 'ms') {
  if (!results || results.length === 0) return [];
  // Take the first (or only) series
  const series = results[0];
  return series.values.map(([ts, val]) => {
    let v = safeFloat(val, 3);
    if (unit === 's') v = v * 1000; // convert seconds → ms
    return { timestamp: ts * 1000, value: v }; // epoch ms for JS Date
  });
}

// ─────────────────────────────────────────────────────────────
// Aggregated snapshot builder
// ─────────────────────────────────────────────────────────────

/**
 * Merge all metrics into a single service-centric snapshot.
 * Called by the API server after collecting all Prometheus data.
 *
 * @param {string[]}            services   - known service names
 * @param {Record<string,number>} latency  - from transformLatencyP99
 * @param {Record<string,number>} rps      - from transformThroughput
 * @param {Record<string,number>} errors   - from transformErrorRates
 * @param {Record<string,number>} cpuPods  - from transformCpuUsage
 * @param {Record<string,number>} memPods  - from transformMemoryUsage
 * @returns {Array<ServiceSnapshot>}
 */
function buildServiceSnapshots(services, latency, rps, errors, cpuPods, memPods) {
  return services.map(name => {
    // Match pod metrics by service name prefix
    const podCpuTotal = Object.entries(cpuPods)
      .filter(([pod]) => pod.startsWith(name))
      .reduce((acc, [, v]) => acc + v, 0);

    const podMemTotal = Object.entries(memPods)
      .filter(([pod]) => pod.startsWith(name))
      .reduce((acc, [, v]) => acc + v, 0);

    const latencyVal  = latency[name]  || 0;
    const rpsVal      = rps[name]      || 0;
    const errorVal    = errors[name]   || 0;

    return {
      name,
      latencyP99Ms: latencyVal,
      throughputRps: rpsVal,
      errorRatePct: errorVal,
      cpuMillicores: safeFloat(podCpuTotal, 1),
      memoryMib: safeFloat(podMemTotal, 1),
      health: computeHealthScore(latencyVal, errorVal, rpsVal),
      updatedAt: Date.now(),
    };
  });
}

/**
 * Simple rule-based health score (0 = critical, 100 = healthy).
 * Thresholds are calibrated for the Online Boutique demo.
 */
function computeHealthScore(latencyMs, errorPct, rps) {
  let score = 100;
  if (latencyMs > 500)  score -= 30;
  else if (latencyMs > 200) score -= 15;
  if (errorPct  > 5)    score -= 35;
  else if (errorPct > 1) score -= 15;
  if (rps === 0)        score -= 10; // service dark
  return Math.max(0, score);
}

module.exports = {
  transformLatencyP99,
  transformThroughput,
  transformErrorRates,
  transformCpuUsage,
  transformMemoryUsage,
  transformTopology,
  transformTimeSeries,
  buildServiceSnapshots,
  computeHealthScore,
  safeFloat,
};
