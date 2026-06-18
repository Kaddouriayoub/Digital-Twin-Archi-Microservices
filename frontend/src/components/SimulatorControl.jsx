// ============================================================
// src/components/SimulatorControl.jsx
// What-if scenario control panel.
// Lets the user pick a scenario, tune parameters, and view
// the diff between baseline and predicted metrics.
//
// Enhancements:
//  1. Visual results panel (impact bar, before/after table, recommendations)
//  2. Simulation history (localStorage)
//  3. Canary deploy scenario with GO/NO-GO verdict
// ============================================================
import React, { useState, useEffect, useCallback } from 'react';
import { Play, RotateCcw, ChevronDown, TrendingUp, TrendingDown, Minus, Loader2 } from 'lucide-react';
import { manualScale } from '../api/client';

// ── Helpers ──────────────────────────────────────────────────
function DeltaBadge({ baseline, predicted, unit = 'ms', invert = false }) {
  if (predicted == null || baseline == null) return null;
  const delta = predicted - baseline;
  const pct   = baseline !== 0 ? ((delta / baseline) * 100).toFixed(1) : '∞';
  const worse = invert ? delta < 0 : delta > 0;
  const color = Math.abs(delta) < 0.01 ? 'var(--text-secondary)'
              : worse ? 'var(--red)' : 'var(--green)';
  const Icon  = Math.abs(delta) < 0.01 ? Minus : worse ? TrendingUp : TrendingDown;
  return (
    <span className="delta-badge" style={{ color }}>
      <Icon size={11} />
      {delta > 0 ? '+' : ''}{pct}%
    </span>
  );
}

function statusBadge(health, errorPct, latencyMs, slaLatency = 500) {
  if (health != null && health < 20) return { label: 'CRITICAL', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' };
  if (errorPct > 5 || latencyMs > slaLatency) return { label: 'BREACH', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
  if (health != null && health < 60) return { label: 'DEGRADED', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
  return { label: 'OK', color: '#10b981', bg: 'rgba(16,185,129,0.12)' };
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Constants ────────────────────────────────────────────────
const ICONS = {
  load_spike:        '⚡',
  service_failure:   '💥',
  scale_up:          '📈',
  network_partition: '🔌',
  memory_pressure:   '🧠',
  cache_miss:        '🗄️',
  canary_deploy:     '🐤',
};

const HISTORY_KEY = 'dt_sim_history';
const MAX_HISTORY = 5;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function saveHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
}

// ── SimulatorControl ─────────────────────────────────────────
export default function SimulatorControl({
  scenarios,
  services,
  simulationResult,
  isSimulating,
  onRunSimulation,
  onClearSimulation,
}) {
  const [selectedScenario, setSelectedScenario] = useState('');
  const [selectedService,  setSelectedService]  = useState('');
  const [intensity,        setIntensity]        = useState(2);
  const [replicas,         setReplicas]         = useState(3);
  const [collapsed,        setCollapsed]        = useState(false);
  const [history,          setHistory]          = useState(loadHistory);
  const [appliedRecs,      setAppliedRecs]      = useState({}); // recIdx → 'loading'|'done'

  // Canary-specific params
  const [canaryLatencyDelta, setCanaryLatencyDelta] = useState(50);
  const [canaryErrorDelta,   setCanaryErrorDelta]   = useState(1);
  const [canaryTraffic,      setCanaryTraffic]      = useState(10);

  // Auto-select first scenario
  useEffect(() => {
    if (scenarios.length > 0 && !selectedScenario) {
      setSelectedScenario(scenarios[0].id);
    }
  }, [scenarios]);

  // Auto-select first service
  useEffect(() => {
    if (services.length > 0 && !selectedService) {
      setSelectedService(services[0].name);
    }
  }, [services]);

  // Augment scenarios with canary if not present
  const allScenarios = scenarios.find(s => s.id === 'canary_deploy')
    ? scenarios
    : [...scenarios, { id: 'canary_deploy', name: 'Canary Deploy', description: 'Simulate canary deployment with partial traffic shift and observe impact.' }];

  const scenarioObj   = allScenarios.find(s => s.id === selectedScenario);
  const needsService  = selectedScenario !== 'cache_miss';
  const needsReplicas = selectedScenario === 'scale_up';
  const isCanary      = selectedScenario === 'canary_deploy';

  function handleRun() {
    const params = {
      scenario:  selectedScenario,
      service:   needsService ? selectedService : undefined,
      intensity: needsReplicas ? intensity : intensity,
      config:    needsReplicas ? { replicas }
               : isCanary ? { latency_delta: canaryLatencyDelta, error_rate_delta: canaryErrorDelta, traffic_percent: canaryTraffic }
               : {},
    };
    onRunSimulation(params);

    // Save to history after a short delay (result will be available via effect)
    setTimeout(() => {
      const result = simulationResult; // closure won't have it yet, handled in effect
    }, 0);
  }

  // Save to history when simulation completes
  useEffect(() => {
    if (!simulationResult || !simulationResult.result) return;
    const simResult = simulationResult.result;
    const affected = simResult.filter(s => s.scenarioTag && s.scenarioTag !== 'normal');
    const impactScore = computeImpactScore(affected, services);
    const entry = {
      id: generateId(),
      scenario: simulationResult.scenario || selectedScenario,
      params: { service: selectedService, intensity, replicas },
      timestamp: Date.now(),
      impact_score: impactScore,
      affected_count: affected.length,
    };
    saveHistory(entry);
    setHistory(loadHistory());
    setAppliedRecs({});
  }, [simulationResult]);

  // ── Impact score computation ─────────────────────────────
  function computeImpactScore(affected, allServices) {
    const affectedRatio = allServices.length ? (affected.length / allServices.length) * 50 : 0;
    let maxLatencyIncrease = 0;
    affected.forEach(s => {
      const base = services.find(x => x.name === s.name);
      if (base && base.latencyP99Ms > 0) {
        const inc = ((s.predictedLatencyMs || 0) - base.latencyP99Ms) / base.latencyP99Ms * 100;
        if (inc > maxLatencyIncrease) maxLatencyIncrease = inc;
      }
    });
    return Math.min(100, Math.round(affectedRatio + maxLatencyIncrease / 10));
  }

  // ── Apply recommendation ──────────────────────────────────
  const applyRecommendation = useCallback(async (rec, idx) => {
    setAppliedRecs(prev => ({ ...prev, [idx]: 'loading' }));
    try {
      await manualScale(rec.service, rec.recommended, 'simulation_recommendation');
      setAppliedRecs(prev => ({ ...prev, [idx]: 'done' }));
    } catch {
      setAppliedRecs(prev => ({ ...prev, [idx]: 'error' }));
    }
  }, []);

  // ── Replay history entry ──────────────────────────────────
  function replayHistory(entry) {
    setSelectedScenario(entry.scenario);
    if (entry.params.service) setSelectedService(entry.params.service);
    setIntensity(entry.params.intensity || 2);
    setReplicas(entry.params.replicas || 3);
    // Auto-submit
    setTimeout(() => {
      onRunSimulation({
        scenario: entry.scenario,
        service: entry.params.service,
        intensity: entry.params.intensity || 2,
        config: entry.scenario === 'scale_up' ? { replicas: entry.params.replicas || 3 } : {},
      });
    }, 100);
  }

  // ── Build results data ────────────────────────────────────
  const simResult  = simulationResult?.result || [];
  const affectedServices = simResult.filter(s => s.scenarioTag && s.scenarioTag !== 'normal');
  const impactScore = simulationResult ? computeImpactScore(affectedServices, services) : 0;
  const slaBreaches = affectedServices.filter(s => (s.predictedLatencyMs || 0) > 500 || (s.predictedErrorPct || 0) > 5).length;

  // Recommendations from simulation result
  const recommendations = simulationResult?.recommendations || [];

  // Canary GO/NO-GO
  const canaryVerdict = isCanary && simulationResult ? (() => {
    const hasBreach = slaBreaches > 0;
    const maxError = Math.max(...affectedServices.map(s => s.predictedErrorPct || 0), 0);
    if (hasBreach || maxError > 1) {
      const reason = hasBreach ? `${slaBreaches} SLA breach(es) detected` : `Error rate ${maxError.toFixed(2)}% > 1%`;
      return { safe: false, reason };
    }
    return { safe: true };
  })() : null;

  const impactColor = impactScore <= 30 ? '#10b981' : impactScore <= 70 ? '#f59e0b' : '#ef4444';

  return (
    <div className="simulator-control">
      {/* Header */}
      <div className="sim-header" onClick={() => setCollapsed(c => !c)}>
        <span className="sim-title">🔬 Scenario Simulator</span>
        <ChevronDown size={16} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: '0.2s' }} />
      </div>

      {!collapsed && (
        <div className="sim-body">

          {/* ── History chips (Feature 2) ────────────────── */}
          {history.length > 0 && (
            <div className="sim-history-chips">
              {history.map(h => (
                <button key={h.id} className="history-chip" onClick={() => replayHistory(h)} title="Click to re-run">
                  {ICONS[h.scenario] || '🔧'} {h.scenario.replace(/_/g, ' ')} — {timeAgo(h.timestamp)}
                </button>
              ))}
            </div>
          )}

          {/* Scenario picker */}
          <div className="sim-section">
            <label className="sim-label">Scenario</label>
            <div className="scenario-cards">
              {allScenarios.map(sc => (
                <button
                  key={sc.id}
                  className={`scenario-card ${selectedScenario === sc.id ? 'active' : ''}`}
                  onClick={() => setSelectedScenario(sc.id)}
                  title={sc.description}
                >
                  <span className="scenario-icon">{ICONS[sc.id] || '🔧'}</span>
                  <span className="scenario-name">{sc.name}</span>
                </button>
              ))}
            </div>
            {scenarioObj && (
              <p className="scenario-desc">{scenarioObj.description}</p>
            )}
          </div>

          {/* Service selector */}
          {needsService && (
            <div className="sim-section">
              <label className="sim-label">Target Service</label>
              <select
                className="sim-select"
                value={selectedService}
                onChange={e => setSelectedService(e.target.value)}
              >
                {services.map(s => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Intensity slider (non-canary, non-replicas) */}
          {!needsReplicas && !isCanary && (
            <div className="sim-section">
              <label className="sim-label">
                {selectedScenario === 'load_spike' ? `Traffic Multiplier: ${intensity}×`
                 : selectedScenario === 'network_partition' ? `Packet Loss: ${Math.round(intensity * 10)}%`
                 : `Severity: ${Math.round(intensity * 100)}%`}
              </label>
              <input
                type="range"
                className="sim-slider"
                min={selectedScenario === 'load_spike' ? 1 : 0}
                max={selectedScenario === 'load_spike' ? 10 : 1}
                step={selectedScenario === 'load_spike' ? 0.5 : 0.1}
                value={intensity}
                onChange={e => setIntensity(parseFloat(e.target.value))}
              />
              <div className="slider-labels">
                <span>Low</span><span>High</span>
              </div>
            </div>
          )}

          {/* Replicas (scale_up only) */}
          {needsReplicas && (
            <div className="sim-section">
              <label className="sim-label">New Replica Count: {replicas}</label>
              <input
                type="range" className="sim-slider"
                min={1} max={20} step={1}
                value={replicas}
                onChange={e => setReplicas(parseInt(e.target.value))}
              />
              <div className="slider-labels"><span>1</span><span>20</span></div>
            </div>
          )}

          {/* ── Canary-specific params (Feature 3) ─────── */}
          {isCanary && (
            <div className="sim-section canary-params">
              <label className="sim-label">Latency Delta: +{canaryLatencyDelta}%</label>
              <input type="range" className="sim-slider" min={0} max={200} step={5}
                value={canaryLatencyDelta} onChange={e => setCanaryLatencyDelta(parseInt(e.target.value))} />
              <label className="sim-label">Error Rate Delta: +{canaryErrorDelta}%</label>
              <input type="range" className="sim-slider" min={0} max={10} step={0.5}
                value={canaryErrorDelta} onChange={e => setCanaryErrorDelta(parseFloat(e.target.value))} />
              <label className="sim-label">Traffic Percent</label>
              <div className="canary-traffic-btns">
                {[5, 10, 25, 50].map(pct => (
                  <button key={pct}
                    className={`canary-pct-btn ${canaryTraffic === pct ? 'active' : ''}`}
                    onClick={() => setCanaryTraffic(pct)}
                  >{pct}%</button>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="sim-actions">
            <button
              className="btn-run"
              onClick={handleRun}
              disabled={isSimulating || !selectedScenario}
            >
              <Play size={14} /> {isSimulating ? 'Running…' : 'Run Simulation'}
            </button>
            {simulationResult && (
              <button className="btn-reset" onClick={onClearSimulation}>
                <RotateCcw size={14} /> Reset
              </button>
            )}
          </div>

          {/* ══════════════════════════════════════════════════
              RESULTS PANEL (Feature 1)
              ══════════════════════════════════════════════════ */}
          {simulationResult && affectedServices.length > 0 && (
            <div className="sim-results-enhanced">

              {/* A) Impact Summary Bar */}
              <div className="impact-summary">
                <div className="impact-bar-label">Impact Score</div>
                <div className="impact-bar-track">
                  <div className="impact-bar-fill" style={{ width: `${impactScore}%`, background: impactColor }} />
                </div>
                <div className="impact-bar-value" style={{ color: impactColor }}>{impactScore}/100</div>
                <div className="impact-meta">
                  {affectedServices.length} services impacted · {slaBreaches} SLA breaches predicted
                </div>
              </div>

              {/* Canary GO/NO-GO verdict (Feature 3) */}
              {canaryVerdict && (
                <div className={`canary-verdict ${canaryVerdict.safe ? 'go' : 'nogo'}`}>
                  {canaryVerdict.safe
                    ? '✓ SAFE TO DEPLOY'
                    : `✗ DO NOT DEPLOY — ${canaryVerdict.reason}`}
                </div>
              )}

              {/* B) Before/After Table */}
              <div className="sim-results">
                <div className="results-title">Before / After Comparison</div>
                <div className="results-table-scroll">
                  <table className="results-table">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th>Metric</th>
                        <th>Before</th>
                        <th>After</th>
                        <th>Delta</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {affectedServices.map(s => {
                        const base = services.find(x => x.name === s.name) || {};
                        const st = statusBadge(s.health, s.predictedErrorPct || 0, s.predictedLatencyMs || 0);
                        const rows = [
                          { metric: 'Latency P99', before: `${Math.round(base.latencyP99Ms || 0)} ms`, after: `${Math.round(s.predictedLatencyMs || 0)} ms`, delta: s.predictedLatencyMs - (base.latencyP99Ms || 0), worse: true },
                          { metric: 'Error Rate', before: `${(base.errorRatePct || 0).toFixed(2)}%`, after: `${(s.predictedErrorPct || 0).toFixed(2)}%`, delta: (s.predictedErrorPct || 0) - (base.errorRatePct || 0), worse: true },
                          { metric: 'Throughput', before: `${(base.throughputRps || 0).toFixed(1)} rps`, after: `${(s.projectedRps || 0).toFixed(1)} rps`, delta: (s.projectedRps || 0) - (base.throughputRps || 0), worse: false },
                        ];
                        return rows.map((r, i) => (
                          <tr key={`${s.name}-${r.metric}`}>
                            {i === 0 && <td className="svc-col" rowSpan={rows.length}>{s.name}</td>}
                            <td>{r.metric}</td>
                            <td className="mono-cell">{r.before}</td>
                            <td className="mono-cell">{r.after}</td>
                            <td>
                              <span style={{ color: Math.abs(r.delta) < 0.01 ? 'var(--text-secondary)' : (r.worse ? (r.delta > 0 ? 'var(--red)' : 'var(--green)') : (r.delta < 0 ? 'var(--red)' : 'var(--green)')) }}>
                                {r.delta > 0 ? '+' : ''}{r.metric.includes('Rate') ? r.delta.toFixed(2) + '%' : r.metric.includes('Latency') ? Math.round(r.delta) + ' ms' : r.delta.toFixed(1) + ' rps'}
                              </span>
                            </td>
                            {i === 0 && (
                              <td rowSpan={rows.length}>
                                <span className="status-pill" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                              </td>
                            )}
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* C) Recommendations */}
              {recommendations.length > 0 && (
                <div className="sim-recommendations">
                  <div className="results-title">Recommendations</div>
                  {recommendations.map((rec, idx) => {
                    const actionLabel = rec.action === 'scale' ? (rec.recommended > (rec.current || 1) ? 'SCALE UP' : 'SCALE DOWN')
                                      : rec.action === 'circuit_break' ? 'CIRCUIT BREAK' : rec.action?.toUpperCase() || 'ACTION';
                    const actionColor = actionLabel.includes('UP') ? 'var(--blue)' : actionLabel.includes('DOWN') ? 'var(--orange)' : 'var(--yellow)';
                    const state = appliedRecs[idx];
                    return (
                      <div key={idx} className="rec-card-sim">
                        <div className="rec-priority">#{rec.priority || idx + 1}</div>
                        <div className="rec-body">
                          <div className="rec-top">
                            <span className="rec-service">{rec.service}</span>
                            <span className="rec-action-badge" style={{ color: actionColor, borderColor: actionColor }}>{actionLabel}</span>
                          </div>
                          {rec.current != null && rec.recommended != null && (
                            <div className="rec-detail">{rec.current} → {rec.recommended} replicas</div>
                          )}
                          <div className="rec-reason">{rec.reason}</div>
                        </div>
                        <div className="rec-apply">
                          {state === 'done' ? (
                            <span className="rec-applied">Applied ✓</span>
                          ) : (
                            <button
                              className="rec-apply-btn"
                              disabled={state === 'loading'}
                              onClick={() => applyRecommendation(rec, idx)}
                            >
                              {state === 'loading' ? <Loader2 size={12} className="spin" /> : 'Apply'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
