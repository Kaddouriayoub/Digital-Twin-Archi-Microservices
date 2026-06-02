// ============================================================
// load-injector.js  — Layer 4: Traffic Simulation Profiles
// Generates synthetic load patterns for offline/demo mode.
// Used when no real Prometheus endpoint is available.
// ============================================================
'use strict';

const DEMO_SERVICES = [
  'api-gateway', 'cart-service', 'product-service', 'currency-service',
  'payment-service', 'shipping-service', 'notification-service', 'order-service',
  'recommendation-service', 'ad-service', 'cache-store',
];

/** Gaussian noise for realistic-looking time series. */
function jitter(base, pct = 0.1) {
  const delta = base * pct;
  return base + (Math.random() * 2 - 1) * delta;
}

/**
 * Generate a synthetic service snapshot array (demo/mock mode).
 * Mimics realistic Online Boutique metric ranges.
 *
 * @param {number} [loadFactor=1] - 1 = normal, 2 = 2× load
 * @returns {Array<ServiceSnapshot>}
 */
function generateSyntheticSnapshot(loadFactor = 1) {
  const baseMetrics = {
    'api-gateway':            { latency: 45,  rps: 60,  error: 0.3, cpu: 55,  mem: 90  },
    'cart-service':           { latency: 8,   rps: 180, error: 0.1, cpu: 25,  mem: 45  },
    'product-service':        { latency: 12,  rps: 210, error: 0.0, cpu: 35,  mem: 95  },
    'currency-service':       { latency: 4,   rps: 350, error: 0.0, cpu: 18,  mem: 32  },
    'payment-service':        { latency: 30,  rps: 55,  error: 0.5, cpu: 28,  mem: 55  },
    'shipping-service':       { latency: 18,  rps: 90,  error: 0.1, cpu: 22,  mem: 42  },
    'notification-service':   { latency: 80,  rps: 50,  error: 0.2, cpu: 12,  mem: 28  },
    'order-service':          { latency: 120, rps: 48,  error: 0.3, cpu: 45,  mem: 65  },
    'recommendation-service': { latency: 35,  rps: 95,  error: 0.0, cpu: 38,  mem: 72  },
    'ad-service':             { latency: 15,  rps: 280, error: 0.1, cpu: 210, mem: 310 },
    'cache-store':            { latency: 1,   rps: 360, error: 0.0, cpu: 12,  mem: 52  },
  };

  return DEMO_SERVICES.map(name => {
    const b = baseMetrics[name] || { latency: 20, rps: 100, error: 0.2, cpu: 30, mem: 50 };
    const latencyMs = jitter(b.latency * loadFactor, 0.15);
    const errorPct  = jitter(b.error + (loadFactor > 1.5 ? (loadFactor - 1.5) * 5 : 0), 0.2);
    return {
      name,
      latencyP99Ms:   Math.round(latencyMs * 10) / 10,
      throughputRps:  Math.round(jitter(b.rps * loadFactor, 0.1) * 10) / 10,
      errorRatePct:   Math.max(0, Math.round(errorPct * 100) / 100),
      cpuMillicores:  Math.round(jitter(b.cpu * loadFactor, 0.12)),
      memoryMib:      Math.round(jitter(b.mem, 0.05)),
      health:         computeHealth(latencyMs, errorPct),
      updatedAt:      Date.now(),
    };
  });
}

/**
 * Generate synthetic time-series history (60 data points).
 * Used in demo mode for the performance charts.
 *
 * @param {string} serviceName
 * @param {string} metric - 'latency' | 'throughput' | 'errors'
 * @param {number} durationMinutes
 */
function generateSyntheticHistory(serviceName, metric = 'latency', durationMinutes = 60) {
  const now    = Date.now();
  const points = [];
  const base   = getBaseValue(serviceName, metric);

  for (let i = durationMinutes; i >= 0; i--) {
    const ts    = now - i * 60 * 1000;
    const noise = jitter(base, 0.2);
    // Simulate a spike 30 minutes ago
    const spikeFactor = (i > 25 && i < 35) ? 1.8 : 1.0;
    points.push({ timestamp: ts, value: Math.max(0, noise * spikeFactor) });
  }
  return points;
}

function getBaseValue(serviceName, metric) {
  const map = {
    'api-gateway':            { latency: 45,  throughput: 60,  errors: 0.3  },
    'cart-service':           { latency: 8,   throughput: 180, errors: 0.1  },
    'order-service':          { latency: 120, throughput: 48,  errors: 0.3  },
    'product-service':        { latency: 12,  throughput: 210, errors: 0.0  },
    'payment-service':        { latency: 30,  throughput: 55,  errors: 0.5  },
    'ad-service':             { latency: 15,  throughput: 280, errors: 0.1  },
    'recommendation-service': { latency: 35,  throughput: 95,  errors: 0.0  },
  };
  return (map[serviceName]?.[metric]) || (metric === 'latency' ? 20 : metric === 'throughput' ? 100 : 0.2);
}

function computeHealth(latencyMs, errorPct) {
  let score = 100;
  if (latencyMs > 500) score -= 30; else if (latencyMs > 200) score -= 15;
  if (errorPct  > 5)   score -= 35; else if (errorPct > 1)    score -= 15;
  return Math.max(0, score);
}

/**
 * Generate a synthetic topology for demo mode.
 * Represents a generic e-commerce microservices dependency graph.
 */
function generateSyntheticTopology() {
  const nodes = DEMO_SERVICES.map(id => ({ id }));
  const edges = [
    { source: 'api-gateway',            target: 'cart-service',           rps: 60  },
    { source: 'api-gateway',            target: 'product-service',        rps: 120 },
    { source: 'api-gateway',            target: 'currency-service',       rps: 180 },
    { source: 'api-gateway',            target: 'ad-service',             rps: 60  },
    { source: 'api-gateway',            target: 'recommendation-service', rps: 45  },
    { source: 'api-gateway',            target: 'order-service',          rps: 48  },
    { source: 'order-service',          target: 'cart-service',           rps: 48  },
    { source: 'order-service',          target: 'product-service',        rps: 96  },
    { source: 'order-service',          target: 'currency-service',       rps: 144 },
    { source: 'order-service',          target: 'shipping-service',       rps: 48  },
    { source: 'order-service',          target: 'payment-service',        rps: 48  },
    { source: 'order-service',          target: 'notification-service',   rps: 48  },
    { source: 'recommendation-service', target: 'product-service',        rps: 45  },
    { source: 'cart-service',           target: 'cache-store',            rps: 360 },
  ];
  return { nodes, edges };
}

module.exports = {
  generateSyntheticSnapshot,
  generateSyntheticHistory,
  generateSyntheticTopology,
  DEMO_SERVICES,
};
