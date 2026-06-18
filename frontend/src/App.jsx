// ============================================================
// src/App.jsx — Digital Twin Dashboard Shell
// Layout: Header → 3-panel grid (ServiceMap | MetricsPanel | right-col)
// UX: dark/light toggle, keyboard shortcuts, loading skeletons, empty states
// ============================================================
import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import useMetrics from './hooks/useMetrics';
import AnomalyToast     from './components/anomalies/AnomalyToast';
import {
  Activity, Wifi, WifiOff, RefreshCw, AlertCircle,
  BarChart2, Map, Sliders, Clock, Zap, Shield, Sun, Moon, HelpCircle
} from 'lucide-react';

// Lazy-load heavy tab components (D3, Recharts, etc.)
const ServiceMap       = lazy(() => import('./components/ServiceMap'));
const MetricsPanel     = lazy(() => import('./components/MetricsPanel'));
const PerformanceChart = lazy(() => import('./components/PerformanceChart'));
const SimulatorControl = lazy(() => import('./components/SimulatorControl'));
const OptimizePanel    = lazy(() => import('./components/OptimizePanel'));
const ControlPanel     = lazy(() => import('./components/ControlPanel'));

// ── Theme helpers ─────────────────────────────────────────────
function getStoredTheme() {
  return localStorage.getItem('dt_theme') || 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('dt_theme', theme);
}
// Apply immediately on module load (no flash)
applyTheme(getStoredTheme());

// ── Connection status pill ────────────────────────────────────
function WsStatus({ status }) {
  const map = {
    open:         { label: 'Live',        color: 'var(--green)',  Icon: Wifi },
    connecting:   { label: 'Connecting',  color: 'var(--yellow)', Icon: RefreshCw },
    closed:       { label: 'Reconnecting',color: 'var(--yellow)', Icon: RefreshCw },
    reconnecting: { label: 'Reconnecting',color: 'var(--yellow)', Icon: RefreshCw },
    error:        { label: 'Offline',     color: 'var(--red)',    Icon: WifiOff },
  };
  const { label, color, Icon } = map[status] || map.error;
  return (
    <div className="ws-status" style={{ color }}>
      <Icon size={13} className={status === 'connecting' || status === 'closed' || status === 'reconnecting' ? 'spin' : ''} />
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
  { id: 'control',  label: 'Control',  Icon: Shield },
];

// ── Keyboard shortcuts modal ──────────────────────────────────
function ShortcutsModal({ onClose }) {
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-modal" onClick={e => e.stopPropagation()}>
        <div className="shortcuts-header">
          <span>⌨️ Keyboard Shortcuts</span>
          <button className="detail-close" onClick={onClose}>✕</button>
        </div>
        <div className="shortcuts-list">
          <div className="shortcut-row"><kbd>1</kbd>–<kbd>6</kbd><span>Switch tabs</span></div>
          <div className="shortcut-row"><kbd>←</kbd> <kbd>→</kbd><span>Navigate tabs</span></div>
          <div className="shortcut-row"><kbd>R</kbd><span>Refresh data</span></div>
          <div className="shortcut-row"><kbd>Esc</kbd><span>Close panel / modal</span></div>
          <div className="shortcut-row"><kbd>?</kbd><span>Show this help</span></div>
        </div>
      </div>
    </div>
  );
}

// ── Loading skeleton for metric cards ─────────────────────────
function MetricsSkeleton() {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton-line w60" />
          <div className="skeleton-line w40" />
          <div className="skeleton-line w80" />
        </div>
      ))}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────
function EmptyState({ message }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">📡</div>
      <p>{message}</p>
    </div>
  );
}

export default function App() {
  const {
    services, topology, scenarios, simulationResult, wsStatus,
    loading, error, isSimulating, lastUpdated, controlActions,
    anomalies, dismissAnomaly,
    predictions,
    runSimulation, clearSimulation,
  } = useMetrics();

  const [activeTab, setActiveTab] = useState('topology');
  const [theme, setTheme] = useState(getStoredTheme);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // ── Dark/light toggle ───────────────────────────────────────
  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  }, [theme]);

  // ── Manual refresh ──────────────────────────────────────────
  const refreshData = useCallback(() => {
    // Trigger a re-fetch by toggling a dummy — useMetrics pollOnce handles it
    window.dispatchEvent(new Event('dt-refresh'));
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Don't fire when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      // Tab switching: 1-6
      if (e.key >= '1' && e.key <= '6') {
        e.preventDefault();
        setActiveTab(TABS[parseInt(e.key) - 1].id);
        return;
      }
      // Arrow keys: navigate tabs
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setActiveTab(prev => {
          const idx = TABS.findIndex(t => t.id === prev);
          return TABS[(idx + 1) % TABS.length].id;
        });
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setActiveTab(prev => {
          const idx = TABS.findIndex(t => t.id === prev);
          return TABS[(idx - 1 + TABS.length) % TABS.length].id;
        });
        return;
      }
      // R = refresh
      if (e.key === 'r' || e.key === 'R') {
        refreshData();
        return;
      }
      // Escape = close modals
      if (e.key === 'Escape') {
        setShowShortcuts(false);
        return;
      }
      // ? = show shortcuts
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts(s => !s);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [refreshData]);

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
          <RiskPill predictions={predictions} />
        </div>

        <div className="header-right">
          {/* Theme toggle */}
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          {/* Shortcuts help */}
          <button className="shortcuts-btn" onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts (?)">
            <HelpCircle size={14} />
          </button>
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
        {TABS.map(({ id, label, Icon }, idx) => (
          <button
            key={id}
            className={`tab-btn ${activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
            title={`${label} (${idx + 1})`}
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
          <MetricsSkeleton />
        ) : (
          <Suspense fallback={<MetricsSkeleton />}>
            {activeTab === 'topology' && (
              <div className="tab-content full-height">
                {topology.nodes.length === 0 ? (
                  <EmptyState message="No topology data yet — waiting for service discovery…" />
                ) : (
                  <ServiceMap
                    topology={topology}
                    services={services}
                    simulationResult={simulationResult}
                    onServiceSelect={(id) => {}}
                    onNavigateSimulate={(id) => setActiveTab('simulate')}
                  />
                )}
              </div>
            )}

            {activeTab === 'metrics' && (
              <div className="tab-content scrollable">
                {services.length === 0 ? (
                  <EmptyState message="No services discovered yet — metrics will appear once data flows in." />
                ) : (
                  <MetricsPanel services={services} simulationResult={simulationResult} anomalies={anomalies} onDismissAnomaly={dismissAnomaly} onNavigateSimulate={(svc) => setActiveTab('simulate')} />
                )}
              </div>
            )}

            {activeTab === 'charts' && (
              <div className="tab-content scrollable">
                {services.length === 0 ? (
                  <EmptyState message="No performance data available yet." />
                ) : (
                  <PerformanceChart services={services} predictions={predictions} />
                )}
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
                      onServiceSelect={(id) => {}}
                      onNavigateSimulate={(id) => {}}
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'optimize' && (
              <div className="tab-content scrollable">
                <OptimizePanel predictions={predictions} services={services} />
              </div>
            )}

            {activeTab === 'control' && (
              <div className="tab-content scrollable">
                <ControlPanel controlActions={controlActions} />
              </div>
            )}
          </Suspense>
        )}
      </main>

      {/* Anomaly toast notifications */}
      <AnomalyToast
        anomalies={anomalies}
        onDismiss={dismissAnomaly}
        onView={() => setActiveTab('metrics')}
      />

      {/* Shortcuts modal */}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
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

function RiskPill({ predictions }) {
  const preds = Object.values(predictions || {});
  if (preds.length === 0) return null;
  const RISK_ORDER = { high: 3, medium: 2, low: 1 };
  const RISK_COLORS = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--green)' };
  const maxRisk = preds.reduce((max, p) => (RISK_ORDER[p.risk_level] || 0) > (RISK_ORDER[max] || 0) ? p.risk_level : max, 'low');
  const contributing = preds.filter(p => p.risk_level === maxRisk).map(p => p.service);
  return (
    <div className="stat-pill risk-pill" title={`Contributing: ${contributing.join(', ')}`}>
      <span className="stat-label">System Risk</span>
      <span className="stat-value" style={{ color: RISK_COLORS[maxRisk] }}>{maxRisk.toUpperCase()}</span>
    </div>
  );
}
