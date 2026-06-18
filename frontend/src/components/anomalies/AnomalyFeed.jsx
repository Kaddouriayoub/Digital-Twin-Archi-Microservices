// ============================================================
// src/components/anomalies/AnomalyFeed.jsx
// Scrollable, filterable list of all anomalies.
// Click row to expand AnomalyCard inline.
// ============================================================
import React, { useState } from 'react';
import AnomalyCard from './AnomalyCard';

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLORS = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#6366f1' };

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

export default function AnomalyFeed({ anomalies, onDismiss, onSimulate }) {
  const [filter, setFilter]       = useState('all');    // all | active | resolved
  const [sevFilter, setSevFilter] = useState('all');    // all | low | medium | high
  const [expanded, setExpanded]   = useState(null);     // anomaly id

  const filtered = anomalies
    .filter(a => {
      if (filter === 'active' && a.status !== 'active') return false;
      if (filter === 'resolved' && a.status !== 'resolved') return false;
      if (sevFilter !== 'all' && a.severity !== sevFilter) return false;
      return true;
    })
    .sort((a, b) => {
      // Active first, then by severity, then by time
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      const sa = SEVERITY_ORDER[a.severity] ?? 9;
      const sb = SEVERITY_ORDER[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      return (b.detectedAt || 0) - (a.detectedAt || 0);
    });

  return (
    <div className="anomaly-feed">
      {/* Filter bar */}
      <div className="afeed-filters">
        <div className="afeed-filter-group">
          {['all', 'active', 'resolved'].map(f => (
            <button key={f} className={`afeed-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="afeed-filter-group">
          {['all', 'low', 'medium', 'high'].map(f => (
            <button key={f} className={`afeed-btn ${sevFilter === f ? 'active' : ''}`} onClick={() => setSevFilter(f)}>
              {f === 'all' ? 'All Sev' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="afeed-list">
        {filtered.length === 0 && <div className="afeed-empty">No anomalies match filters</div>}
        {filtered.map(a => (
          <div key={a.id}>
            <div
              className={`afeed-row ${a.status === 'resolved' ? 'resolved' : ''} ${expanded === a.id ? 'expanded' : ''}`}
              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
            >
              <span className="afeed-dot" style={{ background: SEVERITY_COLORS[a.severity] || '#6366f1' }} />
              <span className="afeed-service">{a.service}</span>
              <span className="afeed-trigger">{(a.triggered_by || a.method || '').slice(0, 30)}</span>
              <span className="afeed-time">{timeAgo(a.detectedAt)}</span>
              <span className={`afeed-status ${a.status}`}>{a.status === 'active' ? 'Active' : 'Resolved'}</span>
            </div>
            {expanded === a.id && (
              <AnomalyCard anomaly={a} onDismiss={onDismiss} onSimulate={onSimulate} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
