// ============================================================
// src/components/anomalies/AnomalyToast.jsx
// Portal-based toast notifications for high/critical anomalies.
// Max 3 visible, auto-dismiss medium after 15s, manual for high/critical.
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';

function Toast({ anomaly, onDismiss, onView }) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (anomaly.severity === 'medium') {
      timerRef.current = setTimeout(onDismiss, 15000);
    }
    return () => clearTimeout(timerRef.current);
  }, [anomaly.severity, onDismiss]);

  const severityIcon = anomaly.severity === 'critical' ? '🔴' : anomaly.severity === 'high' ? '🟠' : '🟡';

  return (
    <div className="anomaly-toast">
      <div className="toast-content">
        <div className="toast-header">
          <span>{severityIcon} {anomaly.service}</span>
          <span className="toast-score">Score: {anomaly.score?.toFixed?.(2) ?? anomaly.score}</span>
        </div>
        <div className="toast-body">{anomaly.triggered_by || anomaly.method}</div>
      </div>
      <div className="toast-actions">
        <button className="toast-btn toast-btn-view" onClick={onView}>View</button>
        <button className="toast-btn toast-btn-dismiss" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

export default function AnomalyToast({ anomalies, onDismiss, onView }) {
  const [queue, setQueue] = useState([]);
  const [visible, setVisible] = useState([]);

  // Add new high/critical anomalies to queue
  useEffect(() => {
    const qualifying = anomalies.filter(
      a => a.status === 'active' && (a.severity === 'high' || a.severity === 'critical' || a.severity === 'medium')
    );
    // Only add ones not already shown/queued
    const shown = new Set([...visible.map(v => v.id), ...queue.map(q => q.id)]);
    const newOnes = qualifying.filter(a => !shown.has(a.id));
    if (newOnes.length) setQueue(prev => [...prev, ...newOnes]);
  }, [anomalies]);

  // Promote from queue to visible (max 3)
  useEffect(() => {
    if (visible.length < 3 && queue.length > 0) {
      const next = queue[0];
      setQueue(prev => prev.slice(1));
      setVisible(prev => [...prev, next]);
    }
  }, [queue, visible]);

  const dismiss = (id) => {
    setVisible(prev => prev.filter(v => v.id !== id));
    if (onDismiss) onDismiss(id);
  };

  const view = (id) => {
    setVisible(prev => prev.filter(v => v.id !== id));
    if (onView) onView(id);
  };

  if (visible.length === 0) return null;

  return ReactDOM.createPortal(
    <div className="anomaly-toast-container">
      {visible.map(a => (
        <Toast
          key={a.id}
          anomaly={a}
          onDismiss={() => dismiss(a.id)}
          onView={() => view(a.id)}
        />
      ))}
    </div>,
    document.body
  );
}
