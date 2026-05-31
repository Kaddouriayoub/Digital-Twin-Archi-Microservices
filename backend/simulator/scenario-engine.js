// ============================================================
// scenario-engine.js  — Layer 4: What-If Scenario Engine
// Applies a named scenario to the current baseline and returns
// predicted metrics for ALL services in the architecture.
// ============================================================
'use strict';

const {
  predictServiceMetrics,
  propagateFailure,
  DEPENDENCY_MAP,
} = require('./performance-model');

// ─────────────────────────────────────────────────────────────
// Available scenarios catalogue
// ─────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    id:          'load_spike',
    name:        'Load Spike',
    description: 'Simulate a sudden surge in user traffic (e.g. flash sale, viral event).',
    params: [
      { key: 'intensity', label: 'Traffic Multiplier', type: 'range', min: 1, max: 10, default: 2 },
      { key: 'service',   label: 'Entry-point Service', type: 'service', default: 'frontend' },
    ],
  },
  {
    id:          'service_failure',
    name:        'Service Failure',
    description: 'Simulate a complete or partial outage of a chosen service and see the cascading impact.',
    params: [
      { key: 'service',   label: 'Failed Service',   type: 'service', default: 'paymentservice' },
      { key: 'intensity', label: 'Failure Severity',  type: 'range',   min: 0, max: 1, default: 1 },
    ],
  },
  {
    id:          'scale_up',
    name:        'Scale Up Replicas',
    description: 'Add replicas to a bottleneck service and see predicted latency/CPU improvement.',
    params: [
      { key: 'service',  label: 'Service to Scale', type: 'service', default: 'checkoutservice' },
      { key: 'replicas', label: 'New Replica Count', type: 'number',  min: 1, max: 20, default: 3 },
    ],
  },
  {
    id:          'network_partition',
    name:        'Network Partition',
    description: 'Simulate a network split causing packet loss between services.',
    params: [
      { key: 'service',   label: 'Isolated Service', type: 'service', default: 'cartservice' },
      { key: 'intensity', label: 'Packet-Loss %',     type: 'range',   min: 0, max: 100, default: 50 },
    ],
  },
  {
    id:          'memory_pressure',
    name:        'Memory Pressure',
    description: 'Simulate a memory leak causing GC pauses and OOM risk on a service.',
    params: [
      { key: 'service',   label: 'Affected Service', type: 'service', default: 'recommendationservice' },
      { key: 'intensity', label: 'Memory Pressure',  type: 'range',   min: 0, max: 1, default: 0.7 },
    ],
  },
  {
    id:          'cache_miss',
    name:        'Cache Failure (Redis Down)',
    description: 'Simulate Redis going down — cartservice must fall back to direct DB calls.',
    params: [],
  },
];

function getAvailableScenarios() {
  return SCENARIOS;
}

// ─────────────────────────────────────────────────────────────
// Scenario handlers
// ─────────────────────────────────────────────────────────────

function handleLoadSpike({ service = 'frontend', intensity = 2, baseline }) {
  // Propagate load through dependency chain
  const loadMultiplier = parseFloat(intensity);

  return baseline.map(svc => {
    // Services that are downstream of the entry point get more load
    const isEntryPoint  = svc.name === service;
    const isDependency  = (DEPENDENCY_MAP[service] || []).includes(svc.name);
    const factor = isEntryPoint ? loadMultiplier
                 : isDependency ? loadMultiplier * 0.8
                 : 1.0;

    const prediction = predictServiceMetrics(svc.name, svc, factor, 1);
    return {
      ...svc,
      ...prediction,
      scenarioTag: factor > 1 ? 'impacted' : 'normal',
    };
  });
}

function handleServiceFailure({ service, intensity = 1.0, baseline }) {
  const severity   = parseFloat(intensity);
  const cascades   = propagateFailure(service, baseline, severity);

  return baseline.map(svc => {
    if (svc.name === service) {
      // The failed service itself
      return {
        ...svc,
        predictedLatencyMs: svc.latencyP99Ms * (1 + severity * 20),
        predictedErrorPct:  Math.min(100, (svc.errorRatePct || 0) + severity * 80),
        projectedRps:       svc.throughputRps * (1 - severity),
        health:             Math.max(0, svc.health - severity * 100),
        scenarioTag:        'failed',
      };
    }

    const cascade = cascades[svc.name];
    if (cascade) {
      const newLatency = svc.latencyP99Ms + cascade.latencyDeltaMs;
      const newError   = Math.min(100, (svc.errorRatePct || 0) + cascade.errorDeltaPct);
      return {
        ...svc,
        predictedLatencyMs: newLatency,
        predictedErrorPct:  newError,
        health:             computeHealth(newLatency, newError),
        scenarioTag:        'cascading',
      };
    }

    return { ...svc, predictedLatencyMs: svc.latencyP99Ms, predictedErrorPct: svc.errorRatePct, scenarioTag: 'normal' };
  });
}

function handleScaleUp({ service, replicas = 3, intensity, baseline }) {
  const replicaCount = parseInt(replicas, 10);
  const currentLoad  = parseFloat(intensity || 1.5); // assume current load for comparison

  return baseline.map(svc => {
    if (svc.name === service) {
      const prediction = predictServiceMetrics(svc.name, svc, currentLoad, replicaCount);
      return { ...svc, ...prediction, replicas: replicaCount, scenarioTag: 'scaled' };
    }
    return { ...svc, predictedLatencyMs: svc.latencyP99Ms, predictedErrorPct: svc.errorRatePct, scenarioTag: 'normal' };
  });
}

function handleNetworkPartition({ service, intensity = 50, baseline }) {
  const lossRate   = parseFloat(intensity) / 100;
  const cascades   = propagateFailure(service, baseline, lossRate * 0.7);

  return baseline.map(svc => {
    if (svc.name === service) {
      const latency = svc.latencyP99Ms * (1 + lossRate * 5);
      const errors  = Math.min(100, (svc.errorRatePct || 0) + lossRate * 50);
      return {
        ...svc,
        predictedLatencyMs: latency,
        predictedErrorPct:  errors,
        health:             computeHealth(latency, errors),
        scenarioTag:        'partitioned',
      };
    }

    const cascade = cascades[svc.name];
    if (cascade) {
      const newLatency = svc.latencyP99Ms + cascade.latencyDeltaMs * 0.6;
      const newError   = Math.min(100, (svc.errorRatePct || 0) + cascade.errorDeltaPct * 0.5);
      return {
        ...svc,
        predictedLatencyMs: newLatency,
        predictedErrorPct:  newError,
        health:             computeHealth(newLatency, newError),
        scenarioTag:        'degraded',
      };
    }

    return { ...svc, predictedLatencyMs: svc.latencyP99Ms, predictedErrorPct: svc.errorRatePct, scenarioTag: 'normal' };
  });
}

function handleMemoryPressure({ service, intensity = 0.7, baseline }) {
  const pressure = parseFloat(intensity);
  return baseline.map(svc => {
    if (svc.name === service) {
      const latency = svc.latencyP99Ms * (1 + pressure * 4); // GC pauses
      const errors  = Math.min(100, (svc.errorRatePct || 0) + pressure * 20);
      const mem     = (svc.memoryMib || 50) * (1 + pressure * 2);
      return {
        ...svc,
        predictedLatencyMs: latency,
        predictedErrorPct:  errors,
        predictedMemMib:    mem,
        health:             computeHealth(latency, errors),
        scenarioTag:        'memory_pressure',
      };
    }
    return { ...svc, predictedLatencyMs: svc.latencyP99Ms, predictedErrorPct: svc.errorRatePct, scenarioTag: 'normal' };
  });
}

function handleCacheMiss({ baseline }) {
  return baseline.map(svc => {
    if (svc.name === 'redis-cart') {
      return { ...svc, predictedLatencyMs: 9999, predictedErrorPct: 100, health: 0, scenarioTag: 'failed' };
    }
    if (svc.name === 'cartservice') {
      return {
        ...svc,
        predictedLatencyMs: (svc.latencyP99Ms || 5) * 20,
        predictedErrorPct:  60,
        health:             10,
        scenarioTag:        'cascading',
      };
    }
    if (svc.name === 'checkoutservice' || svc.name === 'frontend') {
      return {
        ...svc,
        predictedLatencyMs: (svc.latencyP99Ms || 80) * 5,
        predictedErrorPct:  40,
        health:             30,
        scenarioTag:        'degraded',
      };
    }
    return { ...svc, predictedLatencyMs: svc.latencyP99Ms, predictedErrorPct: svc.errorRatePct, scenarioTag: 'normal' };
  });
}

// ─────────────────────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────────────────────
function runScenario({ scenario, service, intensity, config, baseline }) {
  switch (scenario) {
    case 'load_spike':         return handleLoadSpike({ service, intensity, baseline });
    case 'service_failure':    return handleServiceFailure({ service, intensity, baseline });
    case 'scale_up':           return handleScaleUp({ service, intensity, replicas: config.replicas || 3, baseline });
    case 'network_partition':  return handleNetworkPartition({ service, intensity, baseline });
    case 'memory_pressure':    return handleMemoryPressure({ service, intensity, baseline });
    case 'cache_miss':         return handleCacheMiss({ baseline });
    default:
      throw new Error(`Unknown scenario: "${scenario}". Available: ${SCENARIOS.map(s => s.id).join(', ')}`);
  }
}

function computeHealth(latencyMs, errorPct) {
  let score = 100;
  if (latencyMs > 500)  score -= 30;
  else if (latencyMs > 200) score -= 15;
  if (errorPct  > 5)    score -= 35;
  else if (errorPct > 1) score -= 15;
  return Math.max(0, score);
}

module.exports = { runScenario, getAvailableScenarios };
