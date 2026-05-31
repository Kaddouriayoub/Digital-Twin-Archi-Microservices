// ============================================================
// src/components/MetricsPanel.jsx
// Live service metrics cards — P99 latency, RPS, error rate,
// CPU, memory, and health score with colour-coded status.
// ============================================================
import React, { useState } from 'react';
import { Activity, Zap, AlertTriangle, Cpu, Database, Heart } from 'lucide-react';

// ── Utility helpers ──────────────────────────────────────────
function healthColor(score) {
  if (score >= 80) return 'var(--green)';
  if (score >= 50) return 'var(--yellow)';
  return 'var(--red)';
}

function tagColor(tag) {
  const map = {
    failed:          'var(--red)',
    cascading:       'var(--orange)',
    partitioned:     'var(--orange)',
    degraded:        'var(--yellow)',
    memory_pressure: 'var(--yellow)',
    scaled:          'var(--blue)',
    impacted:        'var(--orange)',
    normal:          'var(--green)',
  };
  return map[tag] || 'var(--muted)';
}

// ── Service Card ─────────────────────────────────────────────
function ServiceCard({ svc, simSvc, isSimMode }) {
  const [expanded, setExpanded] = useState(false);
  const health      = isSimMode ? simSvc?.health          : svc.health;
  const latency     = isSimMode ? simSvc?.predictedLatencyMs : svc.latencyP99Ms;
  const rps         = isSimMode ? simSvc?.projectedRps    : svc.throughputRps;
  const errorPct    = isSimMode ? simSvc?.predictedErrorPct : svc.errorRatePct;
  const cpu         = isSimMode ? simSvc?.predictedCpuMc  : svc.cpuMillicores;
  const mem         = isSimMode ? simSvc?.predictedMemMib  : svc.memoryMib;
  const tag         = simSvc?.scenarioTag;

  return (
    <div
      className="service-card"
      style={{ '--accent': healthColor(health ?? 100) }}
      onClick={() => setExpanded(e => !e)}
    >
      {/* Header */}
      <div className="card-header">
        <span className="svc-name">{svc.name}</span>
        <div className="card-header-right">
          {isSimMode && tag && (
            <span className="scenario-tag" style={{ background: tagColor(tag) }}>
              {tag.replace(/_/g, ' ')}
            </span>
          )}
          <span className="health-badge" style={{ color: healthColor(health ?? 100) }}>
            <Heart size={12} style={{ marginRight: 3 }} />
            {Math.round(health ?? 100)}
          </span>
        </div>
      </div>

      {/* Health bar */}
      <div className="health-bar-bg">
        <div
          className="health-bar-fill"
          style={{ width: `${health ?? 100}%`, background: healthColor(health ?? 100) }}
        />
      </div>

      {/* Primary metrics row */}
      <div className="metric-row">
        <MetricBadge icon={<Zap size={12} />}  label="P99"   value={`${Math.round(latency ?? 0)} ms`} warn={latency > 200} crit={latency > 500} />
        <MetricBadge icon={<Activity size={12} />} label="RPS"  value={`${(rps ?? 0).toFixed(1)}`} />
        <MetricBadge icon={<AlertTriangle size={12} />} label="Err" value={`${(errorPct ?? 0).toFixed(1)}%`} warn={errorPct > 1} crit={errorPct > 5} />
      </div>

      {/* Expandable resource metrics */}
      {expanded && (
        <div className="metric-row" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <MetricBadge icon={<Cpu size={12} />}      label="CPU"  value={`${Math.round(cpu ?? 0)} mc`} />
          <MetricBadge icon={<Database size={12} />} label="MEM"  value={`${Math.round(mem ?? 0)} MiB`} />
        </div>
      )}

      <div className="card-expand-hint">{expanded ? '▲ collapse' : '▼ expand'}</div>
    </div>
  );
}

function MetricBadge({ icon, label, value, warn, crit }) {
  const color = crit ? 'var(--red)' : warn ? 'var(--yellow)' : 'var(--text-secondary)';
  return (
    <div className="metric-badge">
      <span style={{ color, display: 'flex', alignItems: 'center', gap: 3 }}>{icon} {label}</span>
      <strong style={{ color: crit ? 'var(--red)' : warn ? 'var(--yellow)' : 'var(--text)' }}>{value}</strong>
    </div>
  );
}

// ── MetricsPanel ─────────────────────────────────────────────
export default function MetricsPanel({ services, simulationResult }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('health'); // health | latency | rps | error

  const simServices  = simulationResult?.result || [];
  const isSimMode    = simServices.length > 0;

  const displayed = services
    .filter(s => s.name.includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'health')   return (a.health   ?? 100) - (b.health   ?? 100);
      if (sortBy === 'latency')  return (b.latencyP99Ms ?? 0) - (a.latencyP99Ms ?? 0);
      if (sortBy === 'rps')      return (b.throughputRps ?? 0) - (a.throughputRps ?? 0);
      if (sortBy === 'error')    return (b.errorRatePct ?? 0) - (a.errorRatePct ?? 0);
      return 0;
    });

  return (
    <div className="metrics-panel">
      {/* Toolbar */}
      <div className="panel-toolbar">
        <input
          className="search-input"
          placeholder="Search services…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="sort-buttons">
          {['health', 'latency', 'rps', 'error'].map(k => (
            <button
              key={k}
              className={`sort-btn ${sortBy === k ? 'active' : ''}`}
              onClick={() => setSortBy(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {/* Summary bar */}
      <div className="summary-bar">
        <SummaryBadge label="Services"     value={services.length} />
        <SummaryBadge label="Healthy"      value={services.filter(s => (s.health ?? 100) >= 80).length} color="var(--green)" />
        <SummaryBadge label="Degraded"     value={services.filter(s => { const h = s.health ?? 100; return h >= 50 && h < 80; }).length} color="var(--yellow)" />
        <SummaryBadge label="Critical"     value={services.filter(s => (s.health ?? 100) < 50).length} color="var(--red)" />
        {isSimMode && <SummaryBadge label="SIM ACTIVE" value="▶" color="var(--blue)" />}
      </div>

      {/* Cards grid */}
      <div className="cards-grid">
        {displayed.map(svc => (
          <ServiceCard
            key={svc.name}
            svc={svc}
            simSvc={simServices.find(s => s.name === svc.name)}
            isSimMode={isSimMode}
          />
        ))}
      </div>
    </div>
  );
}

function SummaryBadge({ label, value, color }) {
  return (
    <div className="summary-badge">
      <span className="summary-label">{label}</span>
      <span className="summary-value" style={{ color }}>{value}</span>
    </div>
  );
}
