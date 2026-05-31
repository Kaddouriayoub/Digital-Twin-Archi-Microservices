// ============================================================
// load-injector.js  — Layer 4: Traffic Simulation Profiles
// Generates synthetic load patterns for offline/demo mode.
// Used when no real Prometheus endpoint is available.
// ============================================================
'use strict';

const ONLINE_BOUTIQUE_SERVICES = [
  'frontend', 'cartservice', 'productcatalogservice', 'currencyservice',
  'paymentservice', 'shippingservice', 'emailservice', 'checkoutservice',
  'recommendationservice', 'adservice', 'redis-cart',
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
    frontend:               { latency: 45,  rps: 60,  error: 0.3, cpu: 55,  mem: 90  },
    cartservice:            { latency: 8,   rps: 180, error: 0.1, cpu: 25,  mem: 45  },
    productcatalogservice:  { latency: 12,  rps: 210, error: 0.0, cpu: 35,  mem: 95  },
    currencyservice:        { latency: 4,   rps: 350, error: 0.0, cpu: 18,  mem: 32  },
    paymentservice:         { latency: 30,  rps: 55,  error: 0.5, cpu: 28,  mem: 55  },
    shippingservice:        { latency: 18,  rps: 90,  error: 0.1, cpu: 22,  mem: 42  },
    emailservice:           { latency: 80,  rps: 50,  error: 0.2, cpu: 12,  mem: 28  },
    checkoutservice:        { latency: 120, rps: 48,  error: 0.3, cpu: 45,  mem: 65  },
    recommendationservice:  { latency: 35,  rps: 95,  error: 0.0, cpu: 38,  mem: 72  },
    adservice:              { latency: 15,  rps: 280, error: 0.1, cpu: 210, mem: 310 },
    'redis-cart':           { latency: 1,   rps: 360, error: 0.0, cpu: 12,  mem: 52  },
  };

  return ONLINE_BOUTIQUE_SERVICES.map(name => {
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
    frontend:              { latency: 45,  throughput: 60,  errors: 0.3  },
    cartservice:           { latency: 8,   throughput: 180, errors: 0.1  },
    checkoutservice:       { latency: 120, throughput: 48,  errors: 0.3  },
    productcatalogservice: { latency: 12,  throughput: 210, errors: 0.0  },
    paymentservice:        { latency: 30,  throughput: 55,  errors: 0.5  },
    adservice:             { latency: 15,  throughput: 280, errors: 0.1  },
    recommendationservice: { latency: 35,  throughput: 95,  errors: 0.0  },
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
 * Mirrors the real Online Boutique dependency graph.
 */
function generateSyntheticTopology() {
  const nodes = ONLINE_BOUTIQUE_SERVICES.map(id => ({ id }));
  const edges = [
    { source: 'frontend',        target: 'cartservice',           rps: 60  },
    { source: 'frontend',        target: 'productcatalogservice', rps: 120 },
    { source: 'frontend',        target: 'currencyservice',       rps: 180 },
    { source: 'frontend',        target: 'adservice',             rps: 60  },
    { source: 'frontend',        target: 'recommendationservice', rps: 45  },
    { source: 'frontend',        target: 'checkoutservice',       rps: 48  },
    { source: 'checkoutservice', target: 'cartservice',           rps: 48  },
    { source: 'checkoutservice', target: 'productcatalogservice', rps: 96  },
    { source: 'checkoutservice', target: 'currencyservice',       rps: 144 },
    { source: 'checkoutservice', target: 'shippingservice',       rps: 48  },
    { source: 'checkoutservice', target: 'paymentservice',        rps: 48  },
    { source: 'checkoutservice', target: 'emailservice',          rps: 48  },
    { source: 'recommendationservice', target: 'productcatalogservice', rps: 45 },
    { source: 'cartservice',     target: 'redis-cart',            rps: 360 },
  ];
  return { nodes, edges };
}

module.exports = {
  generateSyntheticSnapshot,
  generateSyntheticHistory,
  generateSyntheticTopology,
  ONLINE_BOUTIQUE_SERVICES,
};
