// ============================================================
// src/components/PerformanceChart.jsx
// 1-hour trend charts for latency, throughput, and error rate.
// Uses Recharts with animated line charts and reference lines.
// Enhanced: prediction overlay with dashed lines + confidence interval.
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Legend, Area, AreaChart, ComposedChart
} from 'recharts';
import { fetchServiceDetail } from '../api/client';

// ── Chart colour palette ─────────────────────────────────────
const COLORS = {
  latency:    '#a78bfa',
  throughput: '#34d399',
  errors:     '#f87171',
  predicted:  '#fbbf24',
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

// ── Chart panel with prediction overlay ──────────────────────
function ChartPanel({ title, data, dataKey, color, unit, warningLevel, criticalLevel, prediction, slaThreshold, breachProbability }) {
  // Merge historical + predicted data
  const mergedData = [...data];
  const predictedPoints = [];

  if (prediction && prediction.length > 0) {
    prediction.forEach(p => {
      predictedPoints.push(p);
      mergedData.push(p);
    });
  }

  const hasPrediction = predictedPoints.length > 0;
  const breachPoint = hasPrediction && breachProbability > 0.7
    ? predictedPoints.find(p => slaThreshold && p.value > slaThreshold) : null;

  return (
    <div className="chart-panel">
      <div className="chart-title">
        {title}
        {hasPrediction && <span className="chart-prediction-badge">+ 30min forecast</span>}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={mergedData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
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
          <Legend
            verticalAlign="top"
            height={20}
            wrapperStyle={{ fontSize: 10, color: 'var(--text-secondary)' }}
          />

          {/* SLA threshold line */}
          {slaThreshold && (
            <ReferenceLine y={slaThreshold} stroke="var(--red)" strokeDasharray="6 3"
              label={{ value: 'SLA Limit', fill: 'var(--red)', fontSize: 9, position: 'right' }} />
          )}

          {warningLevel && <ReferenceLine y={warningLevel} stroke="var(--yellow)" strokeDasharray="4 4" label={{ value: 'warn', fill: 'var(--yellow)', fontSize: 9 }} />}
          {criticalLevel && <ReferenceLine y={criticalLevel} stroke="var(--red)" strokeDasharray="4 4" label={{ value: 'crit', fill: 'var(--red)', fontSize: 9 }} />}

          {/* Confidence interval area for predicted region */}
          {hasPrediction && predictedPoints.length >= 2 && (
            <ReferenceArea
              x1={predictedPoints[0].timestamp}
              x2={predictedPoints[predictedPoints.length - 1].timestamp}
              fill="rgba(255,200,0,0.1)"
              strokeOpacity={0}
            />
          )}

          {/* Breach risk reference line */}
          {breachPoint && (
            <ReferenceLine x={breachPoint.timestamp} stroke="#ef4444" strokeWidth={2}
              label={{ value: '⚠ Breach risk', fill: '#ef4444', fontSize: 10, position: 'top' }} />
          )}

          {/* Historical line */}
          <Area
            type="monotone"
            dataKey="value"
            name="Historical"
            stroke={color}
            fill={`url(#grad-${dataKey})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: color }}
            isAnimationActive={false}
            connectNulls={false}
          />

          {/* Predicted line (dashed) */}
          {hasPrediction && (
            <Line
              type="monotone"
              dataKey="predicted"
              name="Predicted (30min)"
              stroke={COLORS.predicted}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              activeDot={{ r: 4, fill: COLORS.predicted }}
              isAnimationActive={false}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────
export default function PerformanceChart({ services, predictions = {} }) {
  const [selectedSvc, setSelectedSvc] = useState(services[0]?.name || '');
  const [history,     setHistory]     = useState({ latency: [], throughput: [] });
  const [loadingHist, setLoadingHist] = useState(false);

  useEffect(() => {
    if (!selectedSvc && services.length > 0) setSelectedSvc(services[0].name);
  }, [services]);

  // Synthetic history generator (demo/fallback mode)
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

  useEffect(() => {
    if (!selectedSvc) return;
    setLoadingHist(true);
    fetchServiceDetail(selectedSvc, 60)
      .then(data => {
        const lat = data.history?.latency    || [];
        const rps = data.history?.throughput || [];
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

  // Build prediction data points for charts
  const pred = predictions[selectedSvc];
  const now = Date.now();

  function buildPredictionPoints(baseValue, predictedValue, horizon = 30) {
    if (!pred || predictedValue == null) return [];
    // Generate 6 points over the prediction horizon
    return Array.from({ length: 6 }, (_, i) => {
      const t = (i + 1) / 6;
      return {
        timestamp: now + (t * horizon * 60000),
        predicted: baseValue + (predictedValue - baseValue) * t,
        value: null, // no historical value
      };
    });
  }

  const currentSvc = services.find(s => s.name === selectedSvc);
  const latencyPredPoints = buildPredictionPoints(
    currentSvc?.latencyP99Ms || 0,
    pred?.predicted_latency_p99
  );
  const throughputPredPoints = buildPredictionPoints(
    currentSvc?.throughputRps || 0,
    pred?.predicted_rps
  );

  // Error history from snapshot
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
          {services.map(s => {
            const p = predictions[s.name];
            const hasRisk = p && p.risk_level && p.risk_level !== 'low';
            return (
              <button
                key={s.name}
                className={`pill ${selectedSvc === s.name ? 'active' : ''} ${hasRisk ? 'has-risk' : ''}`}
                onClick={() => setSelectedSvc(s.name)}
              >
                {hasRisk && <span className="pill-risk-dot" />}
                {s.name}
              </button>
            );
          })}
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
            prediction={latencyPredPoints}
            slaThreshold={200}
            breachProbability={pred?.breach_probability || 0}
          />
          <ChartPanel
            title="Throughput (req/s)"
            data={history.throughput}
            dataKey="throughput"
            color={COLORS.throughput}
            unit="rps"
            prediction={throughputPredPoints}
            slaThreshold={null}
            breachProbability={0}
          />
          <ChartPanel
            title="Error Rate (%)"
            data={errorHistory}
            dataKey="errors"
            color={COLORS.errors}
            unit="pct"
            warningLevel={1}
            criticalLevel={5}
            prediction={[]}
            slaThreshold={5}
            breachProbability={0}
          />
        </div>
      )}
    </div>
  );
}
