// ============================================================
// src/components/OptimizePanel.jsx
// Displays optimization recommendations and scaling plan.
// ============================================================
import React, { useState, useEffect } from 'react';
import { AlertTriangle, AlertCircle, Info, TrendingUp, TrendingDown, Zap, RefreshCw } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const SEVERITY_CONFIG = {
  critical: { color: '#ef4444', Icon: AlertCircle, label: 'Critique' },
  warning:  { color: '#f59e0b', Icon: AlertTriangle, label: 'Attention' },
  info:     { color: '#3b82f6', Icon: Info, label: 'Info' },
};

export default function OptimizePanel() {
  const [recommendations, setRecommendations] = useState([]);
  const [scalingPlan, setScalingPlan] = useState(null);
  const [sla, setSla] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState('recommendations');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [recResp, scaleResp] = await Promise.all([
        fetch(`${API_URL}/optimize/recommendations`).then(r => r.json()),
        fetch(`${API_URL}/optimize/scaling`).then(r => r.json()),
      ]);
      setRecommendations(recResp.recommendations || []);
      setSla(recResp.sla);
      setScalingPlan(scaleResp);
    } catch (err) {
      console.error('Optimization fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  if (loading) {
    return <div className="loading-screen"><div className="loading-spinner" /><p>Analyzing metrics...</p></div>;
  }

  return (
    <div className="optimize-panel">
      <div className="optimize-header">
        <div className="optimize-tabs">
          <button className={`opt-tab ${activeView === 'recommendations' ? 'active' : ''}`} onClick={() => setActiveView('recommendations')}>
            <Zap size={14} /> Recommandations ({recommendations.length})
          </button>
          <button className={`opt-tab ${activeView === 'scaling' ? 'active' : ''}`} onClick={() => setActiveView('scaling')}>
            <TrendingUp size={14} /> Plan de Scaling
          </button>
        </div>
        <button className="refresh-btn" onClick={fetchData}><RefreshCw size={14} /> Rafraîchir</button>
      </div>

      {activeView === 'recommendations' && (
        <div className="recommendations-list">
          {sla && (
            <div className="sla-bar">
              <span>SLA: P99 &lt; {sla.maxLatencyMs}ms</span>
              <span>Erreurs &lt; {sla.maxErrorPct}%</span>
              <span>Utilisation &lt; {sla.maxUtilization * 100}%</span>
            </div>
          )}
          {recommendations.length === 0 ? (
            <div className="no-recommendations">
              <Info size={24} color="#10b981" />
              <p>Tous les services respectent les SLA — aucune optimisation nécessaire.</p>
            </div>
          ) : (
            recommendations.map((rec, i) => <RecommendationCard key={i} rec={rec} />)
          )}
        </div>
      )}

      {activeView === 'scaling' && scalingPlan && (
        <div className="scaling-plan">
          <div className="scaling-summary">
            <div className="summary-stat">
              <span className="summary-label">Replicas actuels</span>
              <span className="summary-value">{scalingPlan.summary.totalCurrentReplicas}</span>
            </div>
            <div className="summary-stat">
              <span className="summary-label">Replicas optimaux</span>
              <span className="summary-value">{scalingPlan.summary.totalOptimalReplicas}</span>
            </div>
          </div>
          <div className="scaling-table">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Actuel</th>
                  <th>Optimal</th>
                  <th>ρ actuel</th>
                  <th>ρ prédit</th>
                  <th>Latence prédite</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {scalingPlan.services.map(svc => (
                  <tr key={svc.name} className={svc.action !== 'no_change' ? 'needs-action' : ''}>
                    <td className="svc-name">{svc.name}</td>
                    <td>{svc.currentReplicas}</td>
                    <td className={svc.optimalReplicas > 1 ? 'highlight' : ''}>{svc.optimalReplicas}</td>
                    <td className={svc.currentMetrics.utilization > 80 ? 'danger' : ''}>{svc.currentMetrics.utilization}%</td>
                    <td>{svc.predictedMetrics.utilization}%</td>
                    <td>{svc.predictedMetrics.latencyP99Ms}ms</td>
                    <td>
                      {svc.action === 'scale_up' ? (
                        <span className="action-badge scale-up"><TrendingUp size={12} /> Scale Up</span>
                      ) : (
                        <span className="action-badge ok">✓ OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RecommendationCard({ rec }) {
  const { color, Icon, label } = SEVERITY_CONFIG[rec.severity] || SEVERITY_CONFIG.info;
  return (
    <div className="rec-card" style={{ borderLeftColor: color }}>
      <div className="rec-header">
        <Icon size={16} color={color} />
        <span className="rec-service">{rec.service}</span>
        <span className="rec-severity" style={{ color }}>{label}</span>
      </div>
      <p className="rec-message">{rec.message}</p>
      {rec.details && (
        <div className="rec-details">
          {rec.details.currentLatencyMs != null && <span>Latence: {Math.round(rec.details.currentLatencyMs)}ms</span>}
          {rec.details.recommendedReplicas && <span>→ {rec.details.recommendedReplicas} replicas</span>}
          {rec.details.latencyReductionPct && <span>Gain: -{rec.details.latencyReductionPct}%</span>}
          {rec.details.utilization != null && <span>ρ: {rec.details.utilization}%</span>}
        </div>
      )}
    </div>
  );
}
