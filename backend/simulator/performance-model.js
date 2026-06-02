// ============================================================
// performance-model.js  — Layer 4: Service Performance Model
// Models how a microservice's latency/errors/throughput respond
// to changes in load, replica count, and dependency failures.
//
// The model uses M/M/c queueing theory + empirical correction
// factors derived from the Online Boutique baseline.
// ============================================================
'use strict';

const { safeFloat } = require('../metrics-collector/data-transformer');
const topologyDiscovery = require('../metrics-collector/topology-discovery');

// ─────────────────────────────────────────────────────────────
// Service-specific calibration constants
// Based on typical Online Boutique behaviour under nominal load.
// ─────────────────────────────────────────────────────────────
const SERVICE_PROFILES = {
  'api-gateway':            { baseCpuMc: 50,  baseMemMib: 80,  baseProcTimeMs: 15,  maxRps: 200 },
  'cart-service':           { baseCpuMc: 20,  baseMemMib: 40,  baseProcTimeMs: 5,   maxRps: 500 },
  'product-service':        { baseCpuMc: 30,  baseMemMib: 90,  baseProcTimeMs: 8,   maxRps: 400 },
  'currency-service':       { baseCpuMc: 15,  baseMemMib: 30,  baseProcTimeMs: 3,   maxRps: 1000 },
  'payment-service':        { baseCpuMc: 25,  baseMemMib: 50,  baseProcTimeMs: 20,  maxRps: 150 },
  'shipping-service':       { baseCpuMc: 20,  baseMemMib: 40,  baseProcTimeMs: 10,  maxRps: 300 },
  'notification-service':   { baseCpuMc: 10,  baseMemMib: 25,  baseProcTimeMs: 50,  maxRps: 100 },
  'order-service':          { baseCpuMc: 40,  baseMemMib: 60,  baseProcTimeMs: 80,  maxRps: 100 },
  'recommendation-service': { baseCpuMc: 35,  baseMemMib: 70,  baseProcTimeMs: 25,  maxRps: 200 },
  'ad-service':             { baseCpuMc: 200, baseMemMib: 300, baseProcTimeMs: 10,  maxRps: 600 },
  'cache-store':            { baseCpuMc: 10,  baseMemMib: 50,  baseProcTimeMs: 1,   maxRps: 5000 },
  default:                  { baseCpuMc: 30,  baseMemMib: 50,  baseProcTimeMs: 15,  maxRps: 300 },
};

// Upstream dependency graph — fallback when Jaeger is unavailable
const STATIC_DEPENDENCY_MAP = {
  'api-gateway':            ['order-service', 'cart-service', 'product-service', 'currency-service', 'ad-service', 'recommendation-service'],
  'order-service':          ['cart-service', 'product-service', 'currency-service', 'shipping-service', 'notification-service', 'payment-service'],
  'recommendation-service': ['product-service'],
  'cart-service':           ['cache-store'],
};

/**
 * Get the active dependency map.
 * Prefers Jaeger-discovered topology, falls back to static map.
 */
function getActiveDependencyMap() {
  const discovered = topologyDiscovery.getDependencyMap();
  if (Object.keys(discovered).length > 0) return discovered;
  return STATIC_DEPENDENCY_MAP;
}

// Exported as DEPENDENCY_MAP for backward compatibility
const DEPENDENCY_MAP = new Proxy({}, {
  get(_, prop) { return getActiveDependencyMap()[prop]; },
  ownKeys()   { return Object.keys(getActiveDependencyMap()); },
  has(_, prop) { return prop in getActiveDependencyMap(); },
  getOwnPropertyDescriptor(_, prop) {
    const map = getActiveDependencyMap();
    if (prop in map) return { configurable: true, enumerable: true, value: map[prop] };
  },
});

/**
 * Get or default the service profile.
 */
function getProfile(serviceName) {
  return SERVICE_PROFILES[serviceName] || SERVICE_PROFILES.default;
}

/**
 * M/M/1 queue approximation — estimates mean latency given:
 *  - arrivalRate   λ (req/s)
 *  - serviceRate   μ (req/s) = 1 / processingTimeSeconds
 *  - replicas      c
 *
 * Returns mean queue wait in ms (0 if underloaded).
 */
function mmcQueueLatency(arrivalRateRps, procTimeMs, replicas = 1) {
  const serviceRatePerReplica = 1000 / procTimeMs; // req/s per instance
  const totalServiceRate      = serviceRatePerReplica * replicas;
  const utilisation           = arrivalRateRps / totalServiceRate;

  if (utilisation >= 1) {
    // Saturated — latency explodes
    return procTimeMs * (1 + utilisation * 10);
  }

  // M/M/1 mean response time = procTime / (1 - utilisation)
  return procTimeMs / Math.max(1 - utilisation, 0.001);
}

/**
 * Predict service behaviour under a given load + replica count.
 *
 * @param {string} serviceName
 * @param {object} baseline   - current ServiceSnapshot
 * @param {number} loadFactor - multiplier on current RPS (e.g. 2.0 = 2× load)
 * @param {number} replicas   - number of replicas to simulate
 * @returns {object} - predicted metrics
 */
function predictServiceMetrics(serviceName, baseline, loadFactor = 1.0, replicas = 1) {
  const profile         = getProfile(serviceName);
  const currentRps      = baseline?.throughputRps || 10;
  const projectedRps    = currentRps * loadFactor;

  const predictedLatency    = mmcQueueLatency(projectedRps, profile.baseProcTimeMs, replicas);
  const predictedCpu        = safeFloat(profile.baseCpuMc * loadFactor / replicas, 1);
  const predictedMem        = safeFloat(profile.baseMemMib * 1.1, 1); // memory scales slowly
  const saturationRatio     = projectedRps / (profile.maxRps * replicas);

  let predictedErrorPct = baseline?.errorRatePct || 0;
  if (saturationRatio > 0.9) predictedErrorPct += (saturationRatio - 0.9) * 200; // steep ramp
  predictedErrorPct = Math.min(predictedErrorPct, 100);

  return {
    name: serviceName,
    projectedRps:      safeFloat(projectedRps, 2),
    predictedLatencyMs: safeFloat(predictedLatency, 2),
    predictedErrorPct: safeFloat(predictedErrorPct, 2),
    predictedCpuMc:    predictedCpu,
    predictedMemMib:   predictedMem,
    saturationRatio:   safeFloat(Math.min(saturationRatio, 1), 3),
    health:            scoreHealth(predictedLatency, predictedErrorPct),
  };
}

function scoreHealth(latencyMs, errorPct) {
  let score = 100;
  if (latencyMs > 500)  score -= 30;
  else if (latencyMs > 200) score -= 15;
  if (errorPct  > 5)    score -= 35;
  else if (errorPct > 1) score -= 15;
  return Math.max(0, score);
}

/**
 * Propagate impact of a failing service to its consumers.
 * Adds cascading latency / error penalty to impacted services.
 *
 * @param {string}   failedService
 * @param {Array}    allServices   - array of ServiceSnapshot
 * @param {number}   severity      - 0–1, 1 = complete outage
 * @returns {Record<string, {latencyDeltaMs, errorDeltaPct}>}
 */
function propagateFailure(failedService, allServices, severity = 1.0) {
  const impact = {};
  const depMap = getActiveDependencyMap();

  Object.entries(depMap).forEach(([consumer, deps]) => {
    if (deps.includes(failedService)) {
      const consumerBaseline = allServices.find(s => s.name === consumer);
      const addedLatency = 500 * severity + (consumerBaseline?.latencyP99Ms || 0) * severity * 0.5;
      const addedError   = 30 * severity;
      impact[consumer] = { latencyDeltaMs: addedLatency, errorDeltaPct: addedError };
    }
  });

  return impact;
}

module.exports = {
  getProfile,
  predictServiceMetrics,
  propagateFailure,
  mmcQueueLatency,
  SERVICE_PROFILES,
  DEPENDENCY_MAP,
  getActiveDependencyMap,
};
