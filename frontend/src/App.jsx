// ============================================================
// src/App.jsx — Digital Twin Dashboard Shell
// Layout: Header → 3-panel grid (ServiceMap | MetricsPanel | right-col)
// ============================================================
import React, { useState } from 'react';
import useMetrics from './hooks/useMetrics';
import ServiceMap       from './components/ServiceMap';
import MetricsPanel     from './components/MetricsPanel';
import PerformanceChart from './components/PerformanceChart';
import SimulatorControl from './components/SimulatorControl';
import OptimizePanel    from './components/OptimizePanel';
import {
  Activity, Wifi, WifiOff, RefreshCw, AlertCircle,
  BarChart2, Map, Sliders, Clock, Zap
} from 'lucide-react';

// ── Connection status pill ────────────────────────────────────
function WsStatus({ status }) {
  const map = {
    open:       { label: 'Live',        color: 'var(--green)',  Icon: Wifi },
    connecting: { label: 'Connecting',  color: 'var(--yellow)', Icon: RefreshCw },
    closed:     { label: 'Reconnecting',color: 'var(--yellow)', Icon: RefreshCw },
    error:      { label: 'Offline',     color: 'var(--red)',    Icon: WifiOff },
  };
  const { label, color, Icon } = map[status] || map.error;
  return (
    <div className="ws-status" style={{ color }}>
      <Icon size={13} className={status === 'connecting' || status === 'closed' ? 'spin' : ''} />
      <span>{label}</span>
    </div>
  );
}

// ── Tab navigation ─────────────────────────────────────────────
const TABS = [
  { id: 'topology', label: 'Topology', Icon: Map },
  { id: 'metrics',  label: 'Metrics',  Icon: BarChart2 },
  { id: 'charts',   label: 'Charts',   Icon: Activity },
  { id: 'simulate', label: 'Simulate', Icon: Sliders },
  { id: 'optimize', label: 'Optimize', Icon: Zap },
];

export default function App() {
  const {
    services, topology, scenarios, simulationResult, wsStatus,
    loading, error, isSimulating, lastUpdated,
    runSimulation, clearSimulation,
  } = useMetrics();

  const [activeTab, setActiveTab] = useState('topology');

  // Global summary stats
  const healthyCount  = services.filter(s => (s.health ?? 100) >= 80).length;
  const criticalCount = services.filter(s => (s.health ?? 100) < 50).length;
  const avgLatency    = services.length
    ? (services.reduce((a, s) => a + (s.latencyP99Ms || 0), 0) / services.length).toFixed(0)
    : '—';
  const totalRps      = services.reduce((a, s) => a + (s.throughputRps || 0), 0).toFixed(0);

  return (
    <div className="app">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-icon">
            <Activity size={20} />
          </div>
          <div>
            <h1 className="brand-title">Digital Twin</h1>
            <p className="brand-subtitle">Microservices Observatory</p>
          </div>
        </div>

        <div className="header-stats">
          <StatPill label="Services"  value={services.length} />
          <StatPill label="Healthy"   value={healthyCount}  color="var(--green)" />
          <StatPill label="Critical"  value={criticalCount} color={criticalCount > 0 ? 'var(--red)' : undefined} />
          <StatPill label="Avg P99"   value={`${avgLatency} ms`} />
          <StatPill label="Total RPS" value={totalRps} />
        </div>

        <div className="header-right">
          <WsStatus status={wsStatus} />
          {lastUpdated && (
            <div className="last-updated">
              <Clock size={12} />
              <span>{lastUpdated.toLocaleTimeString()}</span>
            </div>
          )}
          {simulationResult && (
            <div className="sim-active-badge">
              🔬 Simulation Active
            </div>
          )}
        </div>
      </header>

      {/* ── Error banner ───────────────────────────────────── */}
      {error && (
        <div className="error-banner">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* ── Tab nav ────────────────────────────────────────── */}
      <nav className="tab-nav">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`tab-btn ${activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={15} />
            <span>{label}</span>
            {id === 'simulate' && simulationResult && <span className="tab-dot" />}
          </button>
        ))}
      </nav>

      {/* ── Main content ───────────────────────────────────── */}
      <main className="app-main">
        {loading && services.length === 0 ? (
          <div className="loading-screen">
            <div className="loading-spinner" />
            <p>Collecting metrics from your cluster…</p>
          </div>
        ) : (
          <>
            {activeTab === 'topology' && (
              <div className="tab-content full-height">
                <ServiceMap
                  topology={topology}
                  services={services}
                  simulationResult={simulationResult}
                />
              </div>
            )}

            {activeTab === 'metrics' && (
              <div className="tab-content scrollable">
                <MetricsPanel services={services} simulationResult={simulationResult} />
              </div>
            )}

            {activeTab === 'charts' && (
              <div className="tab-content scrollable">
                <PerformanceChart services={services} />
              </div>
            )}

            {activeTab === 'simulate' && (
              <div className="tab-content scrollable">
                <div className="simulate-layout">
                  <SimulatorControl
                    scenarios={scenarios}
                    services={services}
                    simulationResult={simulationResult}
                    isSimulating={isSimulating}
                    onRunSimulation={runSimulation}
                    onClearSimulation={clearSimulation}
                  />
                  <div className="sim-topology-preview">
                    <div className="section-title">
                      {simulationResult ? 'Impact Preview — Service Topology' : 'Live Topology'}
                    </div>
                    <ServiceMap
                      topology={topology}
                      services={services}
                      simulationResult={simulationResult}
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'optimize' && (
              <div className="tab-content scrollable">
                <OptimizePanel />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div className="stat-pill">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ color }}>{value}</span>
    </div>
  );
}
