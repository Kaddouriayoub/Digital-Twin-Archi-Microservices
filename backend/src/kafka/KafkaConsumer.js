// ============================================================
// KafkaConsumer.js — Digital Thread: State Update Consumer
// Subscribes to twin.metrics.* and feeds StateManager (Phase 2).
// Creates the closed loop: poll → Kafka → consume → state update.
// ============================================================
'use strict';

const { Kafka, logLevel } = require('kafkajs');

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const GROUP_ID = 'digital-twin-state';
const RETRY_INTERVAL_MS = 30000;

class KafkaConsumer {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'digital-twin-consumer',
      brokers: BROKERS,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 300, retries: 3 },
    });
    this.consumer = this.kafka.consumer({ groupId: GROUP_ID });
    this.connected = false;
    this._retryTimer = null;
    this._handler = null;
  }

  /**
   * Start consuming. Handler receives parsed messages.
   * @param {(topic: string, message: object) => void} handler
   */
  async start(handler) {
    this._handler = handler;
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topics: [/^twin\.metrics\..+/], fromBeginning: false });
      await this.consumer.run({
        eachMessage: async ({ topic, message }) => {
          try {
            const value = JSON.parse(message.value.toString());
            this._handler(topic, value);
          } catch { /* skip malformed messages */ }
        },
      });
      this.connected = true;
      console.log('[Kafka] Consumer started (group: digital-twin-state)');
    } catch (err) {
      console.warn(`[Kafka] Consumer unavailable — state updates from polling only (${err.message})`);
      this.connected = false;
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setInterval(async () => {
      if (this.connected) { clearInterval(this._retryTimer); this._retryTimer = null; return; }
      try {
        await this.start(this._handler);
        clearInterval(this._retryTimer);
        this._retryTimer = null;
      } catch { /* silent retry */ }
    }, RETRY_INTERVAL_MS);
  }

  async getConsumerLag() {
    if (!this.connected) return {};
    try {
      const admin = this.kafka.admin();
      await admin.connect();
      const topics = (await admin.listTopics()).filter(t => t.startsWith('twin.metrics.'));
      const lag = {};
      for (const topic of topics) {
        const offsets = await admin.fetchTopicOffsets(topic);
        const groupOffsets = await admin.fetchOffsets({ groupId: GROUP_ID, topics: [topic] });
        const latest = parseInt(offsets[0]?.offset || '0', 10);
        const current = parseInt(groupOffsets[0]?.partitions?.[0]?.offset || '0', 10);
        lag[topic] = Math.max(0, latest - current);
      }
      await admin.disconnect();
      return lag;
    } catch {
      return {};
    }
  }

  async disconnect() {
    if (this._retryTimer) clearInterval(this._retryTimer);
    try { await this.consumer.disconnect(); } catch {}
    this.connected = false;
  }
}

module.exports = new KafkaConsumer();
