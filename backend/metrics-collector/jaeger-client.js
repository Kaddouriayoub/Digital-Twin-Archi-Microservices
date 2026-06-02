// ============================================================
// jaeger-client.js  — Jaeger Tracing API Client
// Queries the Jaeger HTTP API to retrieve services, traces,
// and span dependencies for automatic topology discovery.
// ============================================================
'use strict';

const axios = require('axios');

const JAEGER_URL = process.env.JAEGER_URL || 'http://localhost:16686';

/**
 * Get all services known to Jaeger.
 * @returns {Promise<string[]>}
 */
async function getServices() {
  try {
    const resp = await axios.get(`${JAEGER_URL}/api/services`, { timeout: 5000 });
    return (resp.data.data || []).filter(s => s !== 'jaeger-query');
  } catch (err) {
    console.error('[JaegerClient] getServices failed:', err.message);
    return [];
  }
}

/**
 * Get recent traces for a service.
 * @param {string} service
 * @param {number} limit
 * @param {number} lookbackMinutes
 * @returns {Promise<Array>} - array of trace objects
 */
async function getTraces(service, limit = 20, lookbackMinutes = 60) {
  try {
    const endTime = Date.now() * 1000; // microseconds
    const startTime = endTime - lookbackMinutes * 60 * 1000 * 1000;
    const resp = await axios.get(`${JAEGER_URL}/api/traces`, {
      params: { service, limit, start: startTime, end: endTime },
      timeout: 10000,
    });
    return resp.data.data || [];
  } catch (err) {
    console.error(`[JaegerClient] getTraces(${service}) failed:`, err.message);
    return [];
  }
}

/**
 * Get Jaeger's built-in dependency graph.
 * @param {number} lookbackMinutes
 * @returns {Promise<Array<{parent: string, child: string, callCount: number}>>}
 */
async function getDependencies(lookbackMinutes = 60) {
  try {
    const endTs = Date.now();
    const resp = await axios.get(`${JAEGER_URL}/api/dependencies`, {
      params: { endTs, lookback: lookbackMinutes * 60 * 1000 },
      timeout: 8000,
    });
    return resp.data.data || [];
  } catch (err) {
    console.error('[JaegerClient] getDependencies failed:', err.message);
    return [];
  }
}

/**
 * Check Jaeger connectivity.
 * @returns {Promise<{connected: boolean, error?: string}>}
 */
async function checkHealth() {
  try {
    await axios.get(`${JAEGER_URL}/api/services`, { timeout: 3000 });
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = {
  getServices,
  getTraces,
  getDependencies,
  checkHealth,
};
