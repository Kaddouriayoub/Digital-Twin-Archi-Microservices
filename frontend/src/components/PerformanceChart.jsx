// ============================================================
// src/components/PerformanceChart.jsx
// 1-hour trend charts for latency, throughput, and error rate.
// Uses Recharts with animated line charts and reference lines.
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, Area, AreaChart
} from 'recharts';
import { fetchServiceDetail } from '../api/client';

// ── Chart colour palette ─────────────────────────────────────
const COLORS = {
  latency:    '#a78bfa',
  throughput: '#34d399',
  errors:     '#f87171',
  predicted:  '#60a5fa',
};

// ── Format helpers ───────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtMs(v)  { return `${Math.round(v)} ms`; }
function fmtRps(v) { return `${v.toFixed(1)} rps`; }
function fmtPct(v) { return `${v.toFixed(2)}%`; }

// ── Custom Tooltip ───────────────────────────────────────────
function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-time">{fmtTime(label)}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: <strong>{unit === 'ms' ? fmtMs(p.value) : unit === 'rps' ? fmtRps(p.value) : fmtPct(p.value)}</strong>
        </p>
      ))}
    </div>
  );
}

// ── Single chart panel ───────────────────────────────────────
function ChartPanel({ title, data, dataKey, color, unit, warningLevel, criticalLevel }) {
  return (
    <div className="chart-panel">
      <div className="chart-title">{title}</div>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="timestamp"
            tickFormatter={fmtTime}
            tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
            tickLine={false}
            axisLine={false}
            width={45}
          />
          <Tooltip content={<CustomTooltip unit={unit} />} />
          {warningLevel  && <ReferenceLine y={warningLevel}  stroke="var(--yellow)" strokeDasharray="4 4" label={{ value: 'warn', fill: 'var(--yellow)', fontSize: 9 }} />}
          {criticalLevel && <ReferenceLine y={criticalLevel} stroke="var(--red)"    strokeDasharray="4 4" label={{ value: 'crit', fill: 'var(--red)',    fontSize: 9 }} />}
          <Area
            type="monotone"
            dataKey="value"
            name={title}
            stroke={color}
            fill={`url(#grad-${dataKey})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: color }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────
export default function PerformanceChart({ services }) {
  const [selectedSvc, setSelectedSvc] = useState(services[0]?.name || '');
  const [history,     setHistory]     = useState({ latency: [], throughput: [] });
  const [loadingHist, setLoadingHist] = useState(false);

  // Auto-select first service when services load
  useEffect(() => {
    if (!selectedSvc && services.length > 0) setSelectedSvc(services[0].name);
  }, [services]);

  // Synthetic history generator (used in demo/fallback mode)
  function generateDemoHistory(svc) {
    if (!svc) return { latency: [], throughput: [] };
    const now = Date.now();
    return {
      latency: Array.from({ length: 60 }, (_, i) => {
        const spikeFactor = (i >= 25 && i <= 35) ? 1.9 : 1.0;
        return {
          timestamp: now - (60 - i) * 60000,
          value: Math.max(0, svc.latencyP99Ms * spikeFactor * (0.85 + Math.random() * 0.3)),
        };
      }),
      throughput: Array.from({ length: 60 }, (_, i) => {
        const spikeFactor = (i >= 25 && i <= 35) ? 1.6 : 1.0;
        return {
          timestamp: now - (60 - i) * 60000,
          value: Math.max(0, svc.throughputRps * spikeFactor * (0.9 + Math.random() * 0.2)),
        };
      }),
    };
  }

  // Fetch history whenever selected service changes
  useEffect(() => {
    if (!selectedSvc) return;
    setLoadingHist(true);
    fetchServiceDetail(selectedSvc, 60)
      .then(data => {
        const lat = data.history?.latency    || [];
        const rps = data.history?.throughput || [];
        // If backend returns empty arrays (demo mode), fall back to synthetic data
        const svc = services.find(s => s.name === selectedSvc);
        setHistory({
          latency:    lat.length > 0 ? lat : generateDemoHistory(svc).latency,
          throughput: rps.length > 0 ? rps : generateDemoHistory(svc).throughput,
        });
      })
      .catch(() => {
        const svc = services.find(s => s.name === selectedSvc);
        setHistory(generateDemoHistory(svc));
      })
      .finally(() => setLoadingHist(false));
  }, [selectedSvc]);

  // Build error history from current snapshot (no history endpoint for errors)
  const currentSvc = services.find(s => s.name === selectedSvc);
  const errorHistory = history.latency.map(p => ({
    timestamp: p.timestamp,
    value: (currentSvc?.errorRatePct || 0) * (0.7 + Math.random() * 0.6),
  }));

  return (
    <div className="performance-chart">
      {/* Service selector */}
      <div className="chart-service-selector">
        <label className="selector-label">Service</label>
        <div className="selector-pills">
          {services.map(s => (
            <button
              key={s.name}
              className={`pill ${selectedSvc === s.name ? 'active' : ''}`}
              onClick={() => setSelectedSvc(s.name)}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {loadingHist && <div className="chart-loading">Loading history…</div>}

      {!loadingHist && (
        <div className="charts-stack">
          <ChartPanel
            title="P99 Latency (ms)"
            data={history.latency}
            dataKey="latency"
            color={COLORS.latency}
            unit="ms"
            warningLevel={200}
            criticalLevel={500}
          />
          <ChartPanel
            title="Throughput (req/s)"
            data={history.throughput}
            dataKey="throughput"
            color={COLORS.throughput}
            unit="rps"
          />
          <ChartPanel
            title="Error Rate (%)"
            data={errorHistory}
            dataKey="errors"
            color={COLORS.errors}
            unit="pct"
            warningLevel={1}
            criticalLevel={5}
          />
        </div>
      )}
    </div>
  );
}
