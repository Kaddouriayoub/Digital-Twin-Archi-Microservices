// ============================================================
// KafkaPublisher.js — Digital Thread: Event Publisher
// Publishes metrics, anomalies, actions, and simulation results
// to Kafka topics. Gracefully degrades if Kafka is unavailable.
// ============================================================
'use strict';

const { Kafka, logLevel } = require('kafkajs');

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const RETRY_INTERVAL_MS = 30000;

const TOPICS = {
  ANOMALIES: 'twin.anomalies',
  ACTIONS: 'twin.actions',
  SIMULATIONS: 'twin.simulations',
};

class KafkaPublisher {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'digital-twin-publisher',
      brokers: BROKERS,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 300, retries: 3 },
    });
    this.producer = this.kafka.producer();
    this.admin = this.kafka.admin();
    this.connected = false;
    this._retryTimer = null;
  }

  async connect() {
    try {
      await this.producer.connect();
      await this.admin.connect();
      await this._ensureTopics();
      this.connected = true;
      console.log('[Kafka] Publisher connected');
    } catch (err) {
      console.warn(`[Kafka] Unavailable — running in polling-only mode (${err.message})`);
      this.connected = false;
      this._scheduleRetry();
    }
  }

  async _ensureTopics() {
    const existing = (await this.admin.listTopics()) || [];
    const needed = [TOPICS.ANOMALIES, TOPICS.ACTIONS, TOPICS.SIMULATIONS];
    const toCreate = needed.filter(t => !existing.includes(t));
    if (toCreate.length > 0) {
      await this.admin.createTopics({
        topics: toCreate.map(topic => ({ topic, numPartitions: 1, replicationFactor: 1 })),
      });
      console.log(`[Kafka] Created topics: ${toCreate.join(', ')}`);
    }
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setInterval(async () => {
      if (this.connected) { clearInterval(this._retryTimer); this._retryTimer = null; return; }
      try {
        await this.producer.connect();
        await this.admin.connect();
        await this._ensureTopics();
        this.connected = true;
        clearInterval(this._retryTimer);
        this._retryTimer = null;
        console.log('[Kafka] Publisher reconnected');
      } catch { /* silent retry */ }
    }, RETRY_INTERVAL_MS);
  }

  async publish(topic, key, value) {
    if (!this.connected) return;
    try {
      await this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify({ ...value, timestamp: new Date().toISOString() }) }],
      });
    } catch (err) {
      console.warn(`[Kafka] Publish failed on ${topic}: ${err.message}`);
      this.connected = false;
      this._scheduleRetry();
    }
  }

  async publishMetrics(service, metrics) {
    const topic = `twin.metrics.${service}`;
    await this.publish(topic, service, {
      service,
      latency_p99_ms: metrics.latencyP99Ms,
      error_rate: metrics.errorRatePct,
      throughput_rps: metrics.throughputRps,
      cpu_percent: metrics.cpuPercent || 0,
      memory_mb: metrics.memoryMib || 0,
      replica_count: metrics.replicaCount || 1,
    });
  }

  async publishAnomaly(anomaly) {
    await this.publish(TOPICS.ANOMALIES, anomaly.service, {
      service: anomaly.service,
      severity: anomaly.severity,
      method: anomaly.type,
      score: anomaly.details?.zScore || anomaly.details?.deviationPct || 0,
      triggered_by: anomaly.metric,
      recommendation: anomaly.message,
    });
  }

  async publishAction(action) {
    await this.publish(TOPICS.ACTIONS, action.service, action);
  }

  async publishSimulation(simulation) {
    await this.publish(TOPICS.SIMULATIONS, simulation.scenario, {
      scenario: simulation.scenario,
      affected_services: simulation.result?.filter(s => s.scenarioTag !== 'normal').map(s => s.name) || [],
      results: simulation.result,
    });
  }

  async getStatus() {
    if (!this.connected) return { connected: false, topics: [], consumerLag: {} };
    try {
      const topics = await this.admin.listTopics();
      return { connected: true, topics, consumerLag: {} };
    } catch {
      return { connected: false, topics: [], consumerLag: {} };
    }
  }

  async disconnect() {
    if (this._retryTimer) clearInterval(this._retryTimer);
    try { await this.producer.disconnect(); } catch {}
    try { await this.admin.disconnect(); } catch {}
    this.connected = false;
  }
}

// Singleton
module.exports = new KafkaPublisher();
module.exports.TOPICS = TOPICS;
