// ============================================================
// topology-discovery.js  — Automatic Topology Discovery
// Builds the service dependency graph from Jaeger traces,
// replacing the hardcoded DEPENDENCY_MAP.
// Falls back to Prometheus istio metrics if Jaeger unavailable.
// ============================================================
'use strict';

const jaeger = require('./jaeger-client');

let cachedTopology = null;
let cachedDependencyMap = null;
let lastDiscoveryTime = 0;
const DISCOVERY_TTL_MS = 30000; // refresh every 30s

/**
 * Discover topology from Jaeger's dependency API.
 * Returns { nodes, edges } + updates the dependency map.
 * @param {number} lookbackMinutes
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
async function discoverTopology(lookbackMinutes = 60) {
  const now = Date.now();
  if (cachedTopology && (now - lastDiscoveryTime) < DISCOVERY_TTL_MS) {
    return cachedTopology;
  }

  const deps = await jaeger.getDependencies(lookbackMinutes);

  if (deps.length === 0) {
    return cachedTopology || { nodes: [], edges: [] };
  }

  const nodeSet = new Set();
  const edges = [];
  const depMap = {};

  deps.forEach(({ parent, child, callCount }) => {
    nodeSet.add(parent);
    nodeSet.add(child);
    edges.push({ source: parent, target: child, rps: Math.round(callCount / (lookbackMinutes * 60) * 10) / 10 });

    // Build dependency map: parent depends on child
    if (!depMap[parent]) depMap[parent] = [];
    if (!depMap[parent].includes(child)) depMap[parent].push(child);
  });

  const nodes = Array.from(nodeSet).map(id => ({ id }));

  cachedTopology = { nodes, edges };
  cachedDependencyMap = depMap;
  lastDiscoveryTime = now;

  console.log(`[TopologyDiscovery] Discovered ${nodes.length} services, ${edges.length} edges from Jaeger`);
  return cachedTopology;
}

/**
 * Discover topology by analyzing individual traces (deeper analysis).
 * Extracts parent-child relationships from span references.
 * @param {string[]} services - list of services to query
 * @param {number} tracesPerService
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
async function discoverFromTraces(services, tracesPerService = 10) {
  const nodeSet = new Set();
  const edgeMap = {}; // "source→target" → callCount
  const depMap = {};

  for (const service of services) {
    const traces = await jaeger.getTraces(service, tracesPerService, 60);

    for (const trace of traces) {
      const spanMap = {};
      // Index spans by spanID
      for (const span of trace.spans) {
        spanMap[span.spanID] = span;
      }

      // Find parent-child relationships
      for (const span of trace.spans) {
        const childService = span.processID
          ? trace.processes[span.processID]?.serviceName
          : null;
        if (!childService) continue;

        for (const ref of (span.references || [])) {
          if (ref.refType === 'CHILD_OF') {
            const parentSpan = spanMap[ref.spanID];
            if (!parentSpan) continue;
            const parentService = parentSpan.processID
              ? trace.processes[parentSpan.processID]?.serviceName
              : null;
            if (!parentService || parentService === childService) continue;

            nodeSet.add(parentService);
            nodeSet.add(childService);

            const key = `${parentService}→${childService}`;
            edgeMap[key] = (edgeMap[key] || 0) + 1;

            if (!depMap[parentService]) depMap[parentService] = [];
            if (!depMap[parentService].includes(childService)) {
              depMap[parentService].push(childService);
            }
          }
        }
      }
    }
  }

  const nodes = Array.from(nodeSet).map(id => ({ id }));
  const edges = Object.entries(edgeMap).map(([key, count]) => {
    const [source, target] = key.split('→');
    return { source, target, rps: count };
  });

  if (nodes.length > 0) {
    cachedTopology = { nodes, edges };
    cachedDependencyMap = depMap;
    lastDiscoveryTime = Date.now();
  }

  return cachedTopology || { nodes: [], edges: [] };
}

/**
 * Get the current dependency map (for use by performance-model).
 * @returns {Record<string, string[]>}
 */
function getDependencyMap() {
  return cachedDependencyMap || {};
}

/**
 * Check if Jaeger-based discovery is available.
 */
async function isAvailable() {
  const health = await jaeger.checkHealth();
  return health.connected;
}

/**
 * Reset cache (for testing or forced refresh).
 */
function resetCache() {
  cachedTopology = null;
  cachedDependencyMap = null;
  lastDiscoveryTime = 0;
}

module.exports = {
  discoverTopology,
  discoverFromTraces,
  getDependencyMap,
  isAvailable,
  resetCache,
};
