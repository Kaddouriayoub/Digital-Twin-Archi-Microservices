// ============================================================
// src/components/SimulatorControl.jsx
// What-if scenario control panel.
// Lets the user pick a scenario, tune parameters, and view
// the diff between baseline and predicted metrics.
// ============================================================
import React, { useState, useEffect } from 'react';
import { Play, RotateCcw, ChevronDown, TrendingUp, TrendingDown, Minus } from 'lucide-react';

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

// ── Scenario descriptions icon map ────────────────────────────
const ICONS = {
  load_spike:        '⚡',
  service_failure:   '💥',
  scale_up:          '📈',
  network_partition: '🔌',
  memory_pressure:   '🧠',
  cache_miss:        '🗄️',
};

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

  const scenarioObj = scenarios.find(s => s.id === selectedScenario);
  const needsService  = selectedScenario !== 'cache_miss';
  const needsReplicas = selectedScenario === 'scale_up';

  function handleRun() {
    onRunSimulation({
      scenario:  selectedScenario,
      service:   needsService ? selectedService : undefined,
      intensity: needsReplicas ? intensity : intensity,
      config:    needsReplicas ? { replicas } : {},
    });
  }

  // ── Build diff table ──────────────────────────────────────
  const simResult  = simulationResult?.result || [];
  const topChanged = [...simResult]
    .filter(s => s.scenarioTag && s.scenarioTag !== 'normal')
    .sort((a, b) => {
      const da = Math.abs((a.predictedLatencyMs || 0) - (services.find(x => x.name === a.name)?.latencyP99Ms || 0));
      const db = Math.abs((b.predictedLatencyMs || 0) - (services.find(x => x.name === b.name)?.latencyP99Ms || 0));
      return db - da;
    })
    .slice(0, 6);

  return (
    <div className="simulator-control">
      {/* Header */}
      <div className="sim-header" onClick={() => setCollapsed(c => !c)}>
        <span className="sim-title">🔬 Scenario Simulator</span>
        <ChevronDown size={16} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: '0.2s' }} />
      </div>

      {!collapsed && (
        <div className="sim-body">
          {/* Scenario picker */}
          <div className="sim-section">
            <label className="sim-label">Scenario</label>
            <div className="scenario-cards">
              {scenarios.map(sc => (
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

          {/* Intensity slider */}
          {!needsReplicas && (
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

          {/* Results diff table */}
          {topChanged.length > 0 && (
            <div className="sim-results">
              <div className="results-title">Predicted Impact</div>
              <table className="results-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Status</th>
                    <th>P99 Latency</th>
                    <th>Error Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {topChanged.map(s => {
                    const base = services.find(x => x.name === s.name) || {};
                    return (
                      <tr key={s.name}>
                        <td className="svc-col">{s.name}</td>
                        <td>
                          <span className="status-pill" style={{
                            background: s.scenarioTag === 'failed' ? 'rgba(239,68,68,0.2)'
                                      : s.scenarioTag === 'scaled' ? 'rgba(59,130,246,0.2)'
                                      : 'rgba(249,115,22,0.2)',
                            color: s.scenarioTag === 'failed' ? 'var(--red)'
                                 : s.scenarioTag === 'scaled' ? 'var(--blue)'
                                 : 'var(--orange)',
                          }}>
                            {s.scenarioTag}
                          </span>
                        </td>
                        <td>
                          {Math.round(s.predictedLatencyMs ?? 0)} ms
                          <DeltaBadge baseline={base.latencyP99Ms} predicted={s.predictedLatencyMs} unit="ms" />
                        </td>
                        <td>
                          {(s.predictedErrorPct ?? 0).toFixed(2)}%
                          <DeltaBadge baseline={base.errorRatePct} predicted={s.predictedErrorPct} unit="pct" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
