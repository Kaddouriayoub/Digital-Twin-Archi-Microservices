// ============================================================
// src/components/anomalies/AnomalyHeatmap.jsx
// 24h anomaly pattern heatmap: rows=services, cols=hours.
// ============================================================
import React, { useMemo, useState } from 'react';

const SEVERITY_WEIGHT = { low: 1, medium: 2, high: 3, critical: 4 };
const CELL_COLORS = ['transparent', '#fef3c7', '#f59e0b', '#ef4444'];

function cellColor(maxSev) {
  if (!maxSev) return CELL_COLORS[0];
  const w = SEVERITY_WEIGHT[maxSev] || 0;
  if (w >= 3) return CELL_COLORS[3];
  if (w >= 2) return CELL_COLORS[2];
  return CELL_COLORS[1];
}

export default function AnomalyHeatmap({ anomalies, services }) {
  const [tooltip, setTooltip] = useState(null);

  const now = Date.now();
  const currentHour = new Date().getHours();
  const hours = Array.from({ length: 24 }, (_, i) => (currentHour - 23 + i + 24) % 24);

  // Group anomalies by service + hour
  const grid = useMemo(() => {
    const map = {}; // service → hour → { count, maxSev }
    anomalies.forEach(a => {
      if (!a.detectedAt || now - a.detectedAt > 24 * 3600000) return;
      const h = new Date(a.detectedAt).getHours();
      const key = `${a.service}_${h}`;
      if (!map[key]) map[key] = { count: 0, maxSev: null };
      map[key].count++;
      const w = SEVERITY_WEIGHT[a.severity] || 0;
      if (!map[key].maxSev || w > (SEVERITY_WEIGHT[map[key].maxSev] || 0)) {
        map[key].maxSev = a.severity;
      }
    });
    return map;
  }, [anomalies, now]);

  const serviceNames = useMemo(() => {
    const fromAnomalies = [...new Set(anomalies.map(a => a.service))];
    const fromServices = (services || []).map(s => s.name);
    return [...new Set([...fromAnomalies, ...fromServices])].sort();
  }, [anomalies, services]);

  if (serviceNames.length === 0) return null;

  return (
    <div className="anomaly-heatmap">
      <div className="ahm-title">Anomaly Pattern — Last 24h</div>
      <div className="ahm-grid-wrapper">
        <div className="ahm-grid" style={{ gridTemplateColumns: `100px repeat(24, 1fr)` }}>
          {/* Header row */}
          <div className="ahm-corner" />
          {hours.map(h => <div key={h} className="ahm-hour">{String(h).padStart(2, '0')}</div>)}

          {/* Data rows */}
          {serviceNames.map(svc => (
            <React.Fragment key={svc}>
              <div className="ahm-svc">{svc}</div>
              {hours.map(h => {
                const data = grid[`${svc}_${h}`];
                return (
                  <div
                    key={h}
                    className="ahm-cell"
                    style={{ background: cellColor(data?.maxSev) }}
                    onMouseEnter={(e) => data && setTooltip({ x: e.clientX, y: e.clientY, svc, h, ...data })}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div className="ahm-tooltip" style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}>
          <b>{tooltip.svc}</b> at {String(tooltip.h).padStart(2, '0')}:00<br />
          {tooltip.count} anomalies, max severity: {tooltip.maxSev}
        </div>
      )}
    </div>
  );
}
