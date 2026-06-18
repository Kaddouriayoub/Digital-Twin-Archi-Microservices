// ============================================================
// src/components/ControlPanel.jsx
// Control actions, dry-run toggle, pending review queue,
// enhanced action log, rollback, audit export, circuit breakers.
// ============================================================
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Shield, Zap, ToggleLeft, ToggleRight, Server, Download, RotateCcw } from 'lucide-react';
import { fetchControlStatus, fetchKafkaStatus, fetchMlStatus, toggleDryRun, manualScale } from '../api/client';

const API_URL = import.meta.env.VITE_API_URL || '/api';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

const ACTION_COLORS = { scale_up: '#10b981', scale_down: '#f97316', circuit_break: '#ef4444', rollback: '#a78bfa', manual: '#60a5fa' };

function actionType(action) {
  if (action.action === 'scale') {
    return (action.to_replicas || 0) > (action.from_replicas || 0) ? 'SCALE_UP' : 'SCALE_DOWN';
  }
  if (action.action === 'circuit_break') return 'CIRCUIT_BREAK';
  if (action.action === 'rollback') return 'ROLLBACK';
  return 'MANUAL';
}

function actionBorderColor(action) {
  const t = actionType(action);
  if (t === 'SCALE_UP') return ACTION_COLORS.scale_up;
  if (t === 'SCALE_DOWN') return ACTION_COLORS.scale_down;
  if (t === 'CIRCUIT_BREAK') return ACTION_COLORS.circuit_break;
  if (t === 'ROLLBACK') return ACTION_COLORS.rollback;
  return ACTION_COLORS.manual;
}

export default function ControlPanel({ controlActions = [] }) {
  const [controlStatus, setControlStatus] = useState(null);
  const [infraStatus, setInfraStatus] = useState({ kafka: null, ml: null });
  const [pendingActions, setPendingActions] = useState([]);
  const [rejectedIds, setRejectedIds] = useState(new Set());
  const [approvedIds, setApprovedIds] = useState(new Set());
  const [approvingId, setApprovingId] = useState(null);
  const [circuitBreakers, setCircuitBreakers] = useState([]);
  const [rollbackConfirm, setRollbackConfirm] = useState(null);

  // Filters
  const [filterService, setFilterService] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterTime, setFilterTime] = useState('1h');
  const [showCount, setShowCount] = useState(20);

  const loadStatus = async () => {
    try {
      const [ctrl, kafka, ml] = await Promise.all([
        fetchControlStatus().catch(() => null),
        fetchKafkaStatus().catch(() => ({ connected: false })),
        fetchMlStatus().catch(() => ({ status: 'unavailable' })),
      ]);
      setControlStatus(ctrl);
      setInfraStatus({ kafka, ml });
    } catch {}
  };

  // Circuit breaker polling
  const loadCircuitBreakers = async () => {
    try {
      const resp = await fetch(`${API_URL}/health`).then(r => r.json());
      setCircuitBreakers(resp.circuitBreakers || []);
    } catch {}
  };

  useEffect(() => {
    loadStatus();
    loadCircuitBreakers();
    const iv1 = setInterval(loadStatus, 15000);
    const iv2 = setInterval(loadCircuitBreakers, 30000);
    return () => { clearInterval(iv1); clearInterval(iv2); };
  }, []);

  // Separate dry-run pending actions from log
  useEffect(() => {
    const newPending = controlActions.filter(a => a.dry_run && !rejectedIds.has(a.id || a.timestamp) && !approvedIds.has(a.id || a.timestamp));
    setPendingActions(newPending);
  }, [controlActions, rejectedIds, approvedIds]);

  const handleToggle = async () => {
    const result = await toggleDryRun();
    setControlStatus(prev => prev ? { ...prev, dry_run: result.dry_run } : prev);
  };

  // Approve a pending action
  const handleApprove = useCallback(async (action) => {
    const id = action.id || action.timestamp;
    setApprovingId(id);
    try {
      await manualScale(action.service, action.to_replicas, action.reason || 'approved_from_queue');
      setApprovedIds(prev => new Set([...prev, id]));
    } catch {} finally {
      setApprovingId(null);
    }
  }, []);

  // Reject a pending action
  const handleReject = useCallback((action) => {
    const id = action.id || action.timestamp;
    setRejectedIds(prev => new Set([...prev, id]));
  }, []);

  // Rollback
  const handleRollback = useCallback(async (action) => {
    try {
      await manualScale(action.service, action.from_replicas || 1, 'manual_rollback');
      setRollbackConfirm(null);
    } catch {}
  }, []);

  // Determine last action per service (for rollback eligibility)
  const lastActionPerService = useMemo(() => {
    const map = {};
    controlActions.forEach(a => {
      if (a.action === 'scale' && !a.dry_run) {
        if (!map[a.service]) map[a.service] = a;
      }
    });
    return map;
  }, [controlActions]);

  // Filtered log
  const filteredLog = useMemo(() => {
    const timeMs = filterTime === '1h' ? 3600000 : filterTime === '6h' ? 21600000 : 86400000;
    const cutoff = Date.now() - timeMs;
    return controlActions.filter(a => {
      if (filterService !== 'all' && a.service !== filterService) return false;
      if (filterType !== 'all' && actionType(a) !== filterType) return false;
      if (new Date(a.timestamp).getTime() < cutoff) return false;
      return true;
    });
  }, [controlActions, filterService, filterType, filterTime]);

  const serviceNames = [...new Set(controlActions.map(a => a.service).filter(Boolean))];

  // Export CSV
  const exportCSV = () => {
    const rows = [['timestamp', 'service', 'action', 'from_replicas', 'to_replicas', 'reason', 'dry_run', 'applied_by']];
    controlActions.forEach(a => {
      rows.push([
        new Date(a.timestamp).toISOString(),
        a.service || '',
        actionType(a),
        a.from_replicas ?? '',
        a.to_replicas ?? '',
        a.reason || '',
        a.dry_run ? 'true' : 'false',
        a.applied_by || 'system',
      ]);
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dt-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Reset circuit breaker
  const resetCircuit = async (service) => {
    try { fetch(`${API_URL}/control/circuit-breaker/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service }) }); } catch {}
  };

  return (
    <div className="control-panel">
      {/* Infrastructure Status */}
      <div className="section-title"><Server size={15} /> Infrastructure Status</div>
      <div className="infra-grid">
        <StatusChip label="Kafka" connected={infraStatus.kafka?.connected} detail={infraStatus.kafka?.topics?.length ? `${infraStatus.kafka.topics.length} topics` : null} />
        <StatusChip label="ML Service" connected={infraStatus.ml?.status === 'ok'} detail={infraStatus.ml?.total_models ? `${infraStatus.ml.total_models} models` : null} />
        <StatusChip label="Control" connected={!!controlStatus} detail={controlStatus ? (controlStatus.dry_run ? 'DRY RUN' : 'LIVE') : null} />
      </div>

      {/* Dry Run Toggle */}
      {controlStatus && (
        <div className="dryrun-section">
          <div className="dryrun-toggle" onClick={handleToggle}>
            {controlStatus.dry_run
              ? <><ToggleLeft size={20} color="#f59e0b" /> <span className="dryrun-label warning">Mode Dry Run (actions loguées, non exécutées)</span></>
              : <><ToggleRight size={20} color="#10b981" /> <span className="dryrun-label live">Mode Live (actions exécutées)</span></>
            }
          </div>
          {controlStatus.enabled_services?.length > 0 && (
            <div className="enabled-services">
              <span className="detail-label">Services autorisés:</span> {controlStatus.enabled_services.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* ── 1. Pending Review Queue ───────────────────────── */}
      {pendingActions.length > 0 && (
        <div className="pending-section">
          <div className="section-title pending-title">
            <Shield size={15} /> Pending Review ({pendingActions.length})
          </div>
          <div className="pending-list">
            {pendingActions.map((action, i) => {
              const id = action.id || action.timestamp;
              const type = actionType(action);
              return (
                <div key={id || i} className="pending-entry">
                  <div className="pending-info">
                    <span className="action-service">{action.service}</span>
                    <span className={`action-type-badge ${type.toLowerCase()}`}>{type.replace('_', ' ')}</span>
                    <span className="pending-replicas">{action.from_replicas ?? '?'} → {action.to_replicas}</span>
                    <span className="action-reason">{action.reason}</span>
                    <span className="action-time">{timeAgo(action.timestamp)}</span>
                  </div>
                  <div className="pending-actions">
                    <button className="pending-btn approve" onClick={() => handleApprove(action)} disabled={approvingId === id}>
                      {approvingId === id ? '...' : '✓ Approve'}
                    </button>
                    <button className="pending-btn reject" onClick={() => handleReject(action)}>✗ Reject</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 5. Circuit Breaker Status ─────────────────────── */}
      {circuitBreakers.length > 0 && (
        <div className="circuit-section">
          <div className="section-title"><Shield size={15} /> Circuit Breakers</div>
          <div className="circuit-grid">
            {circuitBreakers.map(cb => (
              <div key={cb.service} className={`circuit-chip ${cb.status?.toLowerCase()}`}>
                <span className="circuit-dot" />
                <span className="circuit-name">{cb.service}</span>
                <span className="circuit-status">{cb.status}</span>
                {cb.status === 'OPEN' && (
                  <>
                    <span className="circuit-since">Open {timeAgo(cb.openedAt)}</span>
                    <button className="circuit-reset-btn" onClick={() => resetCircuit(cb.service)}>Reset</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Actions Log (Enhanced) ────────────────────────── */}
      <div className="log-header">
        <div className="section-title"><Zap size={15} /> Actions Log ({filteredLog.length})</div>
        <button className="export-btn" onClick={exportCSV}><Download size={12} /> Export CSV</button>
      </div>

      {/* Filter bar */}
      <div className="log-filters">
        <select className="log-filter-select" value={filterService} onChange={e => setFilterService(e.target.value)}>
          <option value="all">All services</option>
          {serviceNames.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="log-filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="all">All types</option>
          <option value="SCALE_UP">Scale Up</option>
          <option value="SCALE_DOWN">Scale Down</option>
          <option value="CIRCUIT_BREAK">Circuit Break</option>
          <option value="MANUAL">Manual</option>
          <option value="ROLLBACK">Rollback</option>
        </select>
        <div className="log-time-btns">
          {['1h', '6h', '24h'].map(t => (
            <button key={t} className={`log-time-btn ${filterTime === t ? 'active' : ''}`} onClick={() => setFilterTime(t)}>{t}</button>
          ))}
        </div>
      </div>

      {filteredLog.length === 0 ? (
        <div className="no-actions"><Shield size={20} color="var(--text-muted)" /><p>Aucune action de contrôle pour le moment.</p></div>
      ) : (
        <div className="actions-list">
          {filteredLog.slice(0, showCount).map((action, i) => {
            const id = action.id || action.timestamp;
            const type = actionType(action);
            const isLastForService = lastActionPerService[action.service] === action;
            const canRollback = isLastForService && action.action === 'scale' && !action.dry_run && action.from_replicas != null;
            return (
              <div key={id || i} className="action-entry-v2" style={{ borderLeftColor: actionBorderColor(action) }}>
                <div className="action-row">
                  <span className="action-ts">{new Date(action.timestamp).toLocaleTimeString()}</span>
                  <span className="action-service">{action.service}</span>
                  <span className={`action-type-badge ${type.toLowerCase()}`}>{type.replace('_', ' ')}</span>
                  {action.action === 'scale' && (
                    <span className="action-replicas">{action.from_replicas ?? '?'} → {action.to_replicas}</span>
                  )}
                  <span className="action-reason">{action.reason}</span>
                  {action.dry_run && <span className="action-dry-badge">DRY RUN</span>}
                  {canRollback && (
                    <button className="rollback-btn" onClick={() => setRollbackConfirm(action)}>
                      <RotateCcw size={11} /> Rollback
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {filteredLog.length > showCount && (
            <button className="load-more-btn" onClick={() => setShowCount(c => c + 20)}>Load more ({filteredLog.length - showCount} remaining)</button>
          )}
        </div>
      )}

      {/* Rollback confirmation dialog */}
      {rollbackConfirm && (
        <div className="rollback-overlay" onClick={() => setRollbackConfirm(null)}>
          <div className="rollback-dialog" onClick={e => e.stopPropagation()}>
            <p>Roll back <b>{rollbackConfirm.service}</b> from {rollbackConfirm.to_replicas} to {rollbackConfirm.from_replicas} replicas?</p>
            <div className="rollback-dialog-actions">
              <button className="pending-btn approve" onClick={() => handleRollback(rollbackConfirm)}>OK — Rollback</button>
              <button className="pending-btn reject" onClick={() => setRollbackConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusChip({ label, connected, detail }) {
  return (
    <div className={`infra-chip ${connected ? 'up' : 'down'}`}>
      <span className="infra-dot" />
      <span className="infra-label">{label}</span>
      {detail && <span className="infra-detail">{detail}</span>}
    </div>
  );
}
