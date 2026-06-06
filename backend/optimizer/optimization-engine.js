// ============================================================
// optimization-engine.js — Optimization Module (Levels 1 & 2)
// Level 1: Rules-based recommendations from live metrics
// Level 2: Optimal replica calculation using M/M/c queueing
// ============================================================
'use strict';

const { getProfile, mmcQueueLatency } = require('../simulator/performance-model');

// ─────────────────────────────────────────────────────────────
// Configuration — SLA thresholds
// ─────────────────────────────────────────────────────────────
const SLA = {
  maxLatencyMs: 500,       // P99 latency target
  maxErrorPct: 1,          // Max acceptable error rate
  maxUtilization: 0.8,     // ρ < 80% (queueing theory safe zone)
  targetUtilization: 0.7,  // Optimal target for scaling calculation
  minUtilization: 0.3,     // Below this → over-provisioned
};

// ─────────────────────────────────────────────────────────────
// Level 1: Rules-based Recommendations
// ─────────────────────────────────────────────────────────────

/**
 * Analyze current metrics and generate optimization recommendations.
 * @param {Array} services - current service snapshots
 * @param {{nodes, edges}} topology - service dependency graph
 * @returns {Array<Recommendation>}
 */
function generateRecommendations(services, topology) {
  const recommendations = [];

  for (const svc of services) {
    const profile = getProfile(svc.name);
    const rps = svc.throughputRps || 0;
    const serviceRate = 1000 / profile.baseProcTimeMs;
    const utilization = rps > 0 ? rps / serviceRate : 0;

    // Rule 1: High latency + high utilization → Scale up
    if (svc.latencyP99Ms > SLA.maxLatencyMs && utilization > SLA.maxUtilization) {
      const optimal = computeOptimalReplicas(svc.name, rps, profile);
      const predictedLatency = mmcQueueLatency(rps, profile.baseProcTimeMs, optimal);
      const gain = ((svc.latencyP99Ms - predictedLatency) / svc.latencyP99Ms * 100).toFixed(0);

      recommendations.push({
        service: svc.name,
        severity: 'critical',
        type: 'scale_up',
        message: `Service saturé (ρ=${(utilization * 100).toFixed(0)}%) — Scale up à ${optimal} replicas réduirait la latence de ${gain}%`,
        details: {
          currentLatencyMs: svc.latencyP99Ms,
          predictedLatencyMs: Math.round(predictedLatency),
          currentReplicas: 1,
          recommendedReplicas: optimal,
          utilization: Math.round(utilization * 100),
          latencyReductionPct: parseInt(gain),
        },
      });
    }
    // Rule 2: High latency but low utilization → dependency issue
    else if (svc.latencyP99Ms > SLA.maxLatencyMs && utilization < SLA.minUtilization) {
      const deps = findDependencies(svc.name, topology);
      recommendations.push({
        service: svc.name,
        severity: 'warning',
        type: 'dependency_issue',
        message: `Latence élevée (${Math.round(svc.latencyP99Ms)}ms) mais faible charge — problème probable sur une dépendance`,
        details: {
          currentLatencyMs: svc.latencyP99Ms,
          utilization: Math.round(utilization * 100),
          dependencies: deps,
        },
      });
    }

    // Rule 3: High error rate → investigate
    if (svc.errorRatePct > SLA.maxErrorPct) {
      const deps = findDependencies(svc.name, topology);
      recommendations.push({
        service: svc.name,
        severity: svc.errorRatePct > 10 ? 'critical' : 'warning',
        type: 'high_errors',
        message: `Taux d'erreur élevé (${svc.errorRatePct.toFixed(1)}%) — vérifier les dépendances: ${deps.join(', ') || 'aucune'}`,
        details: {
          errorRatePct: svc.errorRatePct,
          dependencies: deps,
          threshold: SLA.maxErrorPct,
        },
      });
    }

    // Rule 4: Under-utilized → scale down possible
    if (utilization < SLA.minUtilization && utilization > 0 && svc.latencyP99Ms < SLA.maxLatencyMs / 2) {
      recommendations.push({
        service: svc.name,
        severity: 'info',
        type: 'scale_down',
        message: `Sous-utilisé (ρ=${(utilization * 100).toFixed(0)}%) — réduction de ressources possible`,
        details: {
          utilization: Math.round(utilization * 100),
          currentLatencyMs: svc.latencyP99Ms,
        },
      });
    }
  }

  // Sort: critical first, then warning, then info
  const order = { critical: 0, warning: 1, info: 2 };
  recommendations.sort((a, b) => order[a.severity] - order[b.severity]);

  return recommendations;
}

// ─────────────────────────────────────────────────────────────
// Level 2: Optimal Scaling Calculation
// ─────────────────────────────────────────────────────────────

/**
 * Compute optimal replica count for a service to meet SLA.
 * Uses M/M/c model: find min(c) such that ρ < target and latency < SLA.
 *
 * @param {string} serviceName
 * @param {number} arrivalRate - current RPS (λ)
 * @param {object} [profile] - service profile override
 * @returns {number} optimal replica count
 */
function computeOptimalReplicas(serviceName, arrivalRate, profile) {
  profile = profile || getProfile(serviceName);
  const serviceRate = 1000 / profile.baseProcTimeMs; // μ per replica

  if (arrivalRate <= 0) return 1;

  // Find minimum replicas where ρ < target AND latency < SLA
  for (let c = 1; c <= 20; c++) {
    const utilization = arrivalRate / (c * serviceRate);
    const predictedLatency = mmcQueueLatency(arrivalRate, profile.baseProcTimeMs, c);

    if (utilization < SLA.targetUtilization && predictedLatency < SLA.maxLatencyMs) {
      return c;
    }
  }
  return 20; // max cap
}

/**
 * Calculate optimal scaling configuration for ALL services.
 * Minimizes total replicas while respecting SLA constraints.
 *
 * @param {Array} services - current service snapshots
 * @returns {object} scaling plan
 */
function computeOptimalScaling(services) {
  const plan = {
    sla: SLA,
    services: [],
    summary: { totalCurrentReplicas: 0, totalOptimalReplicas: 0, savings: 0 },
  };

  for (const svc of services) {
    const profile = getProfile(svc.name);
    const rps = svc.throughputRps || 0;
    const serviceRate = 1000 / profile.baseProcTimeMs;
    const currentUtilization = rps > 0 ? rps / serviceRate : 0;
    const optimalReplicas = computeOptimalReplicas(svc.name, rps, profile);
    const predictedLatency = mmcQueueLatency(rps, profile.baseProcTimeMs, optimalReplicas);
    const predictedUtilization = rps > 0 ? rps / (optimalReplicas * serviceRate) : 0;

    plan.services.push({
      name: svc.name,
      currentReplicas: 1,
      optimalReplicas,
      action: optimalReplicas > 1 ? 'scale_up' : 'no_change',
      currentMetrics: {
        latencyP99Ms: svc.latencyP99Ms,
        throughputRps: rps,
        errorRatePct: svc.errorRatePct,
        utilization: Math.round(currentUtilization * 100),
      },
      predictedMetrics: {
        latencyP99Ms: Math.round(predictedLatency),
        utilization: Math.round(predictedUtilization * 100),
      },
      model: {
        arrivalRate: rps,
        serviceRate: Math.round(serviceRate * 100) / 100,
        processingTimeMs: profile.baseProcTimeMs,
      },
    });

    plan.summary.totalCurrentReplicas += 1;
    plan.summary.totalOptimalReplicas += optimalReplicas;
  }

  plan.summary.savings = plan.summary.totalCurrentReplicas - plan.summary.totalOptimalReplicas;
  return plan;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function findDependencies(serviceName, topology) {
  if (!topology || !topology.edges) return [];
  return topology.edges
    .filter(e => e.source === serviceName)
    .map(e => e.target);
}

module.exports = {
  generateRecommendations,
  computeOptimalReplicas,
  computeOptimalScaling,
  SLA,
};
