// ============================================================
// src/components/anomalies/AnomalyCard.jsx
// Detailed anomaly view with trigger details, probable cause,
// and actionable recommendations.
// ============================================================
import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { manualScale } from '../../api/client';

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

function probableCauses(triggeredBy) {
  const t = (triggeredBy || '').toLowerCase();
  if (t.includes('latency')) return ['Upstream service degradation', 'Connection pool exhaustion', 'GC pause'];
  if (t.includes('error')) return ['Downstream dependency failure', 'Invalid input spike', 'Deployment regression'];
  if (t.includes('cpu')) return ['CPU-bound computation spike', 'Infinite loop', 'Insufficient replicas'];
  if (t.includes('memory')) return ['Memory leak', 'Large payload processing', 'Cache not evicting'];
  return ['Unknown — check logs for more context'];
}

const SEVERITY_COLORS = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#6366f1' };

export default function AnomalyCard({ anomaly, onDismiss, onSimulate }) {
  const [applyState, setApplyState] = useState(null); // null | 'loading' | 'done' | 'error'

  const sev = anomaly.severity || 'medium';
  const rec = anomaly.recommendation;
  const causes = probableCauses(anomaly.triggered_by);

  async function handleApply() {
    if (!rec) return;
    setApplyState('loading');
    try {
      await manualScale(anomaly.service, rec.targetReplicas, 'anomaly_response');
      setApplyState('done');
    } catch {
      setApplyState('error');
    }
  }

  async function handleDismiss() {
    if (onDismiss) onDismiss(anomaly.id);
    // Fire-and-forget
    try { fetch(`/api/anomalies/${anomaly.id}/dismiss`, { method: 'POST' }); } catch {}
  }

  return (
    <div className="anomaly-card">
      {/* Section A — Header */}
      <div className="acard-header">
        <span className="acard-severity" style={{ background: SEVERITY_COLORS[sev] }}>{sev.toUpperCase()}</span>
        <span className="acard-service">{anomaly.service}</span>
        <span className="acard-time">Detected {timeAgo(anomaly.detectedAt)}</span>
      </div>

      {/* Section B — Trigger Details */}
      <div className="acard-details">
        <div className="acard-detail-item"><span className="adl">Metric</span><span className="adv">{anomaly.triggered_by || anomaly.method || '—'}</span></div>
        <div className="acard-detail-item"><span className="adl">Score</span><span className="adv">{anomaly.score?.toFixed?.(2) ?? anomaly.score}</span></div>
        <div className="acard-detail-item"><span className="adl">Detection</span><span className="adv">{anomaly.method || 'Z-score + EWMA'}</span></div>
        <div className="acard-detail-item"><span className="adl">Verdict</span><span className="adv" style={{ color: SEVERITY_COLORS[sev] }}>CONFIRMED</span></div>
      </div>

      {/* Section C — Probable Cause */}
      <div className="acard-cause">
        <div className="acard-cause-title">Probable Causes</div>
        <ul className="acard-cause-list">
          {causes.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      </div>

      {/* Section D — Recommendation */}
      {rec && (
        <div className="acard-rec">
          <div className="acard-rec-text">
            Recommended: Scale <b>{anomaly.service}</b> from {rec.current || '?'} to <b>{rec.targetReplicas}</b> replicas
          </div>
          <div className="acard-rec-impact">Expected: latency ~-{Math.round((1 - (rec.current || 1) / rec.targetReplicas) * 100)}% (M/M/c model)</div>
          <div className="acard-rec-actions">
            {applyState === 'done' ? (
              <span className="acard-applied">✓ Applied</span>
            ) : (
              <button className="acard-btn acard-btn-apply" onClick={handleApply} disabled={applyState === 'loading'}>
                {applyState === 'loading' ? <Loader2 size={12} className="spin" /> : '✓ Apply Now'}
              </button>
            )}
            <button className="acard-btn acard-btn-sim" onClick={() => onSimulate && onSimulate(anomaly.service)}>◎ Simulate First</button>
            <button className="acard-btn acard-btn-dismiss" onClick={handleDismiss}>✗ Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}
