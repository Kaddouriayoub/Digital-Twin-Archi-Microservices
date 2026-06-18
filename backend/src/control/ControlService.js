// ============================================================
// ControlService.js — Phase 4: Closed-Loop Feedback Controller
// Scales Docker services based on anomaly detection + optimizer.
// Safety: DRY_RUN by default, cooldowns, max replicas cap.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const ACTION_LOG = path.join(__dirname, '../../logs/control-actions.log');

class ControlService extends EventEmitter {
  constructor(dockerClient, config = {}) {
    super();
    this.docker = dockerClient;
    this.config = {
      maxReplicas: { default: 5, ...(config.maxReplicas || {}) },
      cooldownMinutes: config.cooldownMinutes || 5,
      dryRun: config.dryRun !== undefined ? config.dryRun : true,
      enabledServices: config.enabledServices || [],
    };
    this.lastActionTime = new Map();
    fs.mkdirSync(path.dirname(ACTION_LOG), { recursive: true });
  }

  _log(entry) {
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(ACTION_LOG, line);
    console.log(`[Control] ${entry.decision}: ${entry.service} — ${entry.message}`);
  }

  _getMaxReplicas(service) {
    return this.config.maxReplicas[service] || this.config.maxReplicas.default;
  }

  _cooldownRemaining(service) {
    const last = this.lastActionTime.get(service);
    if (!last) return 0;
    const elapsed = (Date.now() - last) / 1000;
    const cooldown = this.config.cooldownMinutes * 60;
    return Math.max(0, Math.round(cooldown - elapsed));
  }

  async scaleService(serviceName, targetReplicas, reason) {
    // 1. Whitelist check
    if (this.config.enabledServices.length > 0 && !this.config.enabledServices.includes(serviceName)) {
      this._log({ decision: 'SKIP', service: serviceName, message: `Not in enabled services whitelist`, reason });
      return { success: false, action_taken: false, message: 'service_not_enabled' };
    }

    // 2. Cooldown check
    const remaining = this._cooldownRemaining(serviceName);
    if (remaining > 0) {
      this._log({ decision: 'COOLDOWN', service: serviceName, message: `Cooldown active (${remaining}s remaining)`, reason });
      return { success: false, action_taken: false, message: `cooldown_active_${remaining}s` };
    }

    // 3. Cap max replicas
    const max = this._getMaxReplicas(serviceName);
    let replicas = Math.min(targetReplicas, max);
    if (targetReplicas > max) {
      this._log({ decision: 'CAP', service: serviceName, message: `Capped from ${targetReplicas} to ${max}`, reason });
    }
    replicas = Math.max(1, replicas);

    // 4. Dry run
    if (this.config.dryRun) {
      this._log({ decision: 'DRY_RUN', service: serviceName, message: `Would scale to ${replicas} replicas. Reason: ${reason}`, reason, targetReplicas: replicas });
      this.emit('action_taken', { service: serviceName, action: 'scale', to_replicas: replicas, reason, dry_run: true });
      return { success: true, action_taken: false, message: 'dry_run', target_replicas: replicas };
    }

    // 5. Execute Docker scale
    try {
      const service = this.docker.getService(serviceName);
      const info = await service.inspect();
      const previous = info.Spec?.Mode?.Replicated?.Replicas || 1;

      if (previous === replicas) {
        this._log({ decision: 'SKIP', service: serviceName, message: `Already at ${replicas} replicas`, reason });
        return { success: true, action_taken: false, message: 'already_at_target' };
      }

      await service.update({
        ...info.Spec,
        version: info.Version.Index,
        Mode: { Replicated: { Replicas: replicas } },
      });

      this.lastActionTime.set(serviceName, Date.now());
      this._log({ decision: 'SCALED', service: serviceName, message: `${previous} → ${replicas} replicas`, reason, previous, replicas });
      this.emit('action_taken', { service: serviceName, action: 'scale', from_replicas: previous, to_replicas: replicas, reason, dry_run: false });
      return { success: true, action_taken: true, previous_replicas: previous, new_replicas: replicas, service: serviceName, timestamp: Date.now() };
    } catch (err) {
      this._log({ decision: 'ERROR', service: serviceName, message: `Docker API failed: ${err.message}`, reason });
      return { success: false, action_taken: false, message: err.message };
    }
  }

  async handleAnomaly(anomalyEvent) {
    if (!anomalyEvent || !anomalyEvent.service) return;
    if (anomalyEvent.severity === 'high' || anomalyEvent.severity === 'critical') {
      const target = anomalyEvent.details?.recommendedReplicas || anomalyEvent.recommendation?.targetReplicas;
      if (target) {
        return this.scaleService(anomalyEvent.service, target, 'anomaly_high_severity');
      }
    }
    if (anomalyEvent.severity === 'medium') {
      this._log({ decision: 'SUGGEST', service: anomalyEvent.service, message: `Medium anomaly — logging only`, reason: 'anomaly_medium' });
    }
  }

  async handleOptimizerRecommendation(recommendation) {
    if (!recommendation || recommendation.action !== 'scale_up') return;
    const current = recommendation.details?.currentReplicas || 1;
    const optimal = recommendation.details?.recommendedReplicas;
    if (!optimal || Math.abs(optimal - current) <= 1) return;
    return this.scaleService(recommendation.service, optimal, 'optimizer_recommendation');
  }

  getStatus() {
    const cooldowns = {};
    for (const [svc, _] of this.lastActionTime) {
      cooldowns[svc] = this._cooldownRemaining(svc);
    }
    return {
      dry_run: this.config.dryRun,
      cooldowns,
      enabled_services: this.config.enabledServices,
      max_replicas: this.config.maxReplicas,
    };
  }

  toggleDryRun() {
    this.config.dryRun = !this.config.dryRun;
    this._log({ decision: 'CONFIG', service: '*', message: `DRY_RUN toggled to ${this.config.dryRun}`, reason: 'manual_toggle' });
    return this.config.dryRun;
  }
}

module.exports = ControlService;
