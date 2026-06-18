// ============================================================
// StateManager.js — Persistent State: Redis + TimescaleDB
// Redis  = current state (HSET per service, fast reads)
// Timescale = time-series history (INSERT per scrape cycle)
// ============================================================
'use strict';

const Redis = require('ioredis');
const { Pool } = require('pg');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/digitaltwin';
const KEY_PREFIX = 'twin:state:';

class StateManager {
  constructor() {
    this.redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true, retryStrategy: () => null });
    this.redis.on('error', () => {}); // suppress unhandled connection errors
    this.pg = new Pool({ connectionString: DATABASE_URL, max: 5 });
    this.pg.on('error', () => {}); // suppress unhandled pool errors
    this.ready = false;
  }

  async connect() {
    try {
      await this.redis.connect();
      await this.pg.query('SELECT 1');
      this.ready = true;
      console.log('[StateManager] Redis + TimescaleDB connected');
    } catch (err) {
      console.warn(`[StateManager] Connection failed — running stateless (${err.message})`);
      this.ready = false;
    }
  }

  async setState(serviceName, metrics) {
    if (!this.ready) return;
    const now = new Date().toISOString();
    const flat = {
      service: serviceName,
      latency_p99_ms: String(metrics.latencyP99Ms || 0),
      error_rate: String(metrics.errorRatePct || 0),
      throughput_rps: String(metrics.throughputRps || 0),
      cpu_percent: String(metrics.cpuPercent || 0),
      memory_mb: String(metrics.memoryMib || 0),
      updated_at: now,
    };

    try {
      // Redis: current state
      await this.redis.hset(`${KEY_PREFIX}${serviceName}`, flat);

      // TimescaleDB: append to history
      await this.pg.query(
        `INSERT INTO service_metrics (time, service_name, latency_p99, error_rate, throughput_rps, cpu_percent, memory_mb)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [now, serviceName, metrics.latencyP99Ms || 0, metrics.errorRatePct || 0, metrics.throughputRps || 0, metrics.cpuPercent || 0, metrics.memoryMib || 0]
      );
    } catch (err) {
      console.warn(`[StateManager] Write failed for ${serviceName}: ${err.message}`);
    }
  }

  async getState(serviceName) {
    if (!this.ready) return null;
    try {
      const data = await this.redis.hgetall(`${KEY_PREFIX}${serviceName}`);
      if (!data || !data.service) return null;
      return {
        service: data.service,
        latencyP99Ms: parseFloat(data.latency_p99_ms),
        errorRatePct: parseFloat(data.error_rate),
        throughputRps: parseFloat(data.throughput_rps),
        cpuPercent: parseFloat(data.cpu_percent),
        memoryMib: parseFloat(data.memory_mb),
        updatedAt: data.updated_at,
      };
    } catch {
      return null;
    }
  }

  async getHistory(serviceName, hours = 24) {
    if (!this.ready) return [];
    try {
      const { rows } = await this.pg.query(
        `SELECT time, latency_p99, error_rate, throughput_rps, cpu_percent, memory_mb
         FROM service_metrics
         WHERE service_name = $1 AND time > NOW() - make_interval(hours => $2)
         ORDER BY time ASC`,
        [serviceName, hours]
      );
      return rows.map(r => ({
        time: r.time,
        latencyP99Ms: parseFloat(r.latency_p99),
        errorRatePct: parseFloat(r.error_rate),
        throughputRps: parseFloat(r.throughput_rps),
        cpuPercent: parseFloat(r.cpu_percent),
        memoryMib: parseFloat(r.memory_mb),
      }));
    } catch {
      return [];
    }
  }

  async disconnect() {
    try { this.redis.disconnect(); } catch {}
    try { await this.pg.end(); } catch {}
  }
}

module.exports = new StateManager();
