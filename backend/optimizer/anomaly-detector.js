// ============================================================
// anomaly-detector.js — Level 3: Anomaly Detection & Prediction
// Detects abnormal metric behavior using Z-score, EWMA, and
// linear trend prediction. Alerts before SLA violations occur.
// ============================================================
'use strict';

const { SLA } = require('./optimization-engine');

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  historySize: 30,          // Number of data points to keep per service
  zScoreThreshold: 2.0,     // Standard deviations for anomaly
  ewmaAlpha: 0.3,           // EWMA smoothing factor (0-1, higher = more reactive)
  trendWindowSize: 10,      // Points used for linear regression
  predictionHorizonMin: 5,  // How far ahead to predict (minutes)
};

// ─────────────────────────────────────────────────────────────
// In-memory metric history (circular buffer per service)
// ─────────────────────────────────────────────────────────────
const history = {}; // { serviceName: { latency: [], rps: [], errors: [] } }

/**
 * Record a new metric snapshot for a service.
 * @param {string} name
 * @param {object} metrics - { latencyP99Ms, throughputRps, errorRatePct }
 */
function recordMetrics(name, metrics) {
  if (!history[name]) {
    history[name] = { latency: [], rps: [], errors: [], timestamps: [] };
  }
  const h = history[name];
  h.latency.push(metrics.latencyP99Ms || 0);
  h.rps.push(metrics.throughputRps || 0);
  h.errors.push(metrics.errorRatePct || 0);
  h.timestamps.push(Date.now());

  // Keep circular buffer
  if (h.latency.length > CONFIG.historySize) {
    h.latency.shift();
    h.rps.shift();
    h.errors.shift();
    h.timestamps.shift();
  }
}

/**
 * Record metrics for all services from a snapshot.
 * @param {Array} services
 */
function recordSnapshot(services) {
  for (const svc of services) {
    recordMetrics(svc.name, svc);
  }
}

// ─────────────────────────────────────────────────────────────
// Statistical functions
// ─────────────────────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Z-score: how many standard deviations the current value is from the mean.
 */
function zScore(arr, current) {
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  return (current - m) / s;
}

/**
 * EWMA: Exponentially Weighted Moving Average.
 * Returns the smoothed series and the current EWMA value.
 */
function ewma(arr, alpha = CONFIG.ewmaAlpha) {
  if (arr.length === 0) return 0;
  let s = arr[0];
  for (let i = 1; i < arr.length; i++) {
    s = alpha * arr[i] + (1 - alpha) * s;
  }
  return s;
}

/**
 * Linear regression (least squares) on the last N points.
 * Returns { slope, intercept } where slope is the rate of change per point.
 */
function linearRegression(arr) {
  const n = arr.length;
  if (n < 3) return { slope: 0, intercept: arr[n - 1] || 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += arr[i];
    sumXY += i * arr[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope: isFinite(slope) ? slope : 0, intercept };
}

// ─────────────────────────────────────────────────────────────
// Anomaly Detection
// ─────────────────────────────────────────────────────────────

/**
 * Analyze all services and return anomaly alerts.
 * @param {Array} services - current service snapshots
 * @returns {Array<AnomalyAlert>}
 */
function detectAnomalies(services) {
  const alerts = [];

  for (const svc of services) {
    const h = history[svc.name];
    if (!h || h.latency.length < 5) continue; // Need minimum history

    // ── Z-score anomaly detection (latency) ──────────────
    const latencyZ = zScore(h.latency.slice(0, -1), svc.latencyP99Ms);
    if (Math.abs(latencyZ) > CONFIG.zScoreThreshold && svc.latencyP99Ms > 50) {
      alerts.push({
        service: svc.name,
        type: 'anomaly',
        severity: Math.abs(latencyZ) > 3 ? 'critical' : 'warning',
        metric: 'latency',
        message: `Latence anormale (${Math.round(svc.latencyP99Ms)}ms, normale: ~${Math.round(mean(h.latency))}ms, z-score: ${latencyZ.toFixed(1)})`,
        details: {
          currentValue: svc.latencyP99Ms,
          mean: Math.round(mean(h.latency)),
          stdDev: Math.round(stdDev(h.latency)),
          zScore: parseFloat(latencyZ.toFixed(2)),
        },
      });
    }

    // ── Z-score anomaly detection (errors) ───────────────
    const errorZ = zScore(h.errors.slice(0, -1), svc.errorRatePct);
    if (errorZ > CONFIG.zScoreThreshold && svc.errorRatePct > 1) {
      alerts.push({
        service: svc.name,
        type: 'anomaly',
        severity: svc.errorRatePct > 10 ? 'critical' : 'warning',
        metric: 'errors',
        message: `Taux d'erreur anormal (${svc.errorRatePct.toFixed(1)}%, normal: ~${mean(h.errors).toFixed(1)}%, z-score: ${errorZ.toFixed(1)})`,
        details: {
          currentValue: svc.errorRatePct,
          mean: parseFloat(mean(h.errors).toFixed(2)),
          zScore: parseFloat(errorZ.toFixed(2)),
        },
      });
    }

    // ── Trend detection (linear regression on latency) ────
    const window = h.latency.slice(-CONFIG.trendWindowSize);
    if (window.length >= 5) {
      const { slope } = linearRegression(window);
      const scrapeIntervalMin = 15 / 60; // 15s in minutes
      const slopePerMin = slope / scrapeIntervalMin;

      // If latency is rising significantly
      if (slopePerMin > 5 && svc.latencyP99Ms < SLA.maxLatencyMs) {
        const current = svc.latencyP99Ms;
        const timeToSLA = (SLA.maxLatencyMs - current) / slopePerMin;

        if (timeToSLA > 0 && timeToSLA < 30) { // Will breach within 30 min
          alerts.push({
            service: svc.name,
            type: 'trend',
            severity: timeToSLA < 5 ? 'critical' : 'warning',
            metric: 'latency',
            message: `Latence en hausse (+${Math.round(slopePerMin)}ms/min) — dépassement SLA prévu dans ~${Math.round(timeToSLA)} min`,
            details: {
              currentValue: current,
              slopePerMin: Math.round(slopePerMin),
              timeToSLABreachMin: Math.round(timeToSLA),
              slaThreshold: SLA.maxLatencyMs,
            },
          });
        }
      }
    }

    // ── EWMA deviation (smoothed trend divergence) ────────
    if (h.latency.length >= 10) {
      const ewmaValue = ewma(h.latency);
      const currentDeviation = (svc.latencyP99Ms - ewmaValue) / (ewmaValue || 1);

      if (currentDeviation > 0.5 && svc.latencyP99Ms > 100) { // 50% above EWMA
        alerts.push({
          service: svc.name,
          type: 'ewma_deviation',
          severity: currentDeviation > 1 ? 'critical' : 'warning',
          metric: 'latency',
          message: `Latence ${Math.round(currentDeviation * 100)}% au-dessus de la tendance lissée (EWMA: ${Math.round(ewmaValue)}ms, actuel: ${Math.round(svc.latencyP99Ms)}ms)`,
          details: {
            currentValue: svc.latencyP99Ms,
            ewmaValue: Math.round(ewmaValue),
            deviationPct: Math.round(currentDeviation * 100),
          },
        });
      }
    }
  }

  // Sort by severity
  const order = { critical: 0, warning: 1 };
  alerts.sort((a, b) => (order[a.severity] ?? 2) - (order[b.severity] ?? 2));

  return alerts;
}

/**
 * Get service health status summary with anomaly context.
 */
function getServiceStatus(services) {
  return services.map(svc => {
    const h = history[svc.name];
    if (!h || h.latency.length < 3) {
      return { name: svc.name, status: 'insufficient_data' };
    }

    const latencyZ = Math.abs(zScore(h.latency.slice(0, -1), svc.latencyP99Ms));
    const window = h.latency.slice(-CONFIG.trendWindowSize);
    const { slope } = linearRegression(window);
    const slopePerMin = slope / (15 / 60);

    let status = 'stable';
    if (latencyZ > CONFIG.zScoreThreshold) status = 'anomaly';
    else if (slopePerMin > 5) status = 'degrading';

    return {
      name: svc.name,
      status,
      latencyZScore: parseFloat(latencyZ.toFixed(2)),
      trendSlopePerMin: Math.round(slopePerMin),
      historyLength: h.latency.length,
    };
  });
}

module.exports = {
  recordMetrics,
  recordSnapshot,
  detectAnomalies,
  getServiceStatus,
  CONFIG,
  // Exported for testing
  zScore,
  ewma,
  linearRegression,
  mean,
  stdDev,
};
