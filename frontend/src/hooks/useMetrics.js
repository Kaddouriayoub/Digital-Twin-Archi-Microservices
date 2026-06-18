// ============================================================
// src/hooks/useMetrics.js
// Central state manager — Layer 3 State Manager from the diagram.
// Merges WebSocket push updates with REST polling fallback.
// Caches latest data so components always have something to render.
// ============================================================
import { useState, useEffect, useCallback, useRef } from 'react';
import useWebSocket from './useWebSocket';
import {
  fetchServicesSnapshot,
  fetchTopology,
  fetchScenarios,
  fetchPrometheusStatus,
  runSimulation as apiRunSimulation,
} from '../api/client';

const POLL_INTERVAL_MS = 15000; // fallback REST poll when WS is closed

export default function useMetrics() {
  const { latestMessage, wsStatus } = useWebSocket();

  const [services,          setServices]          = useState([]);
  const [topology,          setTopology]          = useState({ nodes: [], edges: [] });
  const [scenarios,         setScenarios]         = useState([]);
  const [prometheusStatus,  setPrometheusStatus]  = useState(null);
  const [simulationResult,  setSimulationResult]  = useState(null);
  const [isSimulating,      setIsSimulating]      = useState(false);
  const [lastUpdated,       setLastUpdated]        = useState(null);
  const [error,             setError]             = useState(null);
  const [loading,           setLoading]           = useState(true);
  const [controlActions,    setControlActions]    = useState([]);
  const [anomalies,         setAnomalies]         = useState([]);
  const [predictions,       setPredictions]       = useState({}); // serviceId → latest prediction

  const pollTimerRef = useRef(null);
  const batchRef = useRef({ pending: null, scheduled: false });

  // ── Apply a snapshot (from WS or REST) ───────────────────
  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setServices(snapshot.services  || []);
    setTopology(snapshot.topology  || { nodes: [], edges: [] });
    setLastUpdated(new Date(snapshot.collectedAt || Date.now()));
    setLoading(false);
    setError(null);
  }, []);

  // ── WebSocket push handler (batched for performance) ───
  useEffect(() => {
    if (!latestMessage) return;
    if (latestMessage.type === 'METRICS_UPDATE') {
      // Batch: collect the snapshot and apply on next animation frame
      // This prevents multiple rapid METRICS_UPDATE messages from causing
      // separate re-renders — only the last snapshot in a frame wins.
      batchRef.current.pending = latestMessage.payload;
      if (!batchRef.current.scheduled) {
        batchRef.current.scheduled = true;
        requestAnimationFrame(() => {
          if (batchRef.current.pending) {
            applySnapshot(batchRef.current.pending);
            batchRef.current.pending = null;
          }
          batchRef.current.scheduled = false;
        });
      }
    }
    if (latestMessage.type === 'CONTROL_ACTION') {
      setControlActions(prev => [latestMessage.payload, ...prev].slice(0, 50));
    }
    if (latestMessage.type === 'ANOMALY_DETECTED') {
      const anomaly = { ...latestMessage.payload || latestMessage, id: latestMessage.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6), detectedAt: Date.now(), status: 'active' };
      setAnomalies(prev => [anomaly, ...prev].slice(0, 200));
    }
    if (latestMessage.type === 'PREDICTION') {
      const p = latestMessage.payload || latestMessage;
      if (p.service) setPredictions(prev => ({ ...prev, [p.service]: { ...p, receivedAt: Date.now() } }));
    }
  }, [latestMessage, applySnapshot]);

  // ── REST fallback polling (fires when WS is not open) ──
  const pollOnce = useCallback(async () => {
    try {
      const snap = await fetchServicesSnapshot();
      applySnapshot(snap);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    if (wsStatus === 'open') {
      clearInterval(pollTimerRef.current);
      return;
    }
    // WS unavailable — fall back to polling
    pollOnce();
    pollTimerRef.current = setInterval(pollOnce, POLL_INTERVAL_MS);
    return () => clearInterval(pollTimerRef.current);
  }, [wsStatus, pollOnce]);

  // Manual refresh via keyboard shortcut
  useEffect(() => {
    const handler = () => pollOnce();
    window.addEventListener('dt-refresh', handler);
    return () => window.removeEventListener('dt-refresh', handler);
  }, [pollOnce]);

  // ── One-time initialisation ───────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [scenariosData, promStatus] = await Promise.all([
          fetchScenarios(),
          fetchPrometheusStatus(),
        ]);
        setScenarios(scenariosData);
        setPrometheusStatus(promStatus);
      } catch { /* non-fatal */ }
    })();
  }, []);

  // ── Simulation runner ─────────────────────────────────
  const runSimulation = useCallback(async (params) => {
    setIsSimulating(true);
    setSimulationResult(null);
    try {
      const result = await apiRunSimulation(params);
      setSimulationResult(result);
    } catch (err) {
      setError(`Simulation failed: ${err.message}`);
    } finally {
      setIsSimulating(false);
    }
  }, []);

  const clearSimulation = useCallback(() => setSimulationResult(null), []);

  const dismissAnomaly = useCallback((id) => {
    setAnomalies(prev => prev.map(a => a.id === id ? { ...a, status: 'resolved' } : a));
  }, []);

  return {
    // data
    services,
    topology,
    scenarios,
    prometheusStatus,
    simulationResult,
    lastUpdated,
    wsStatus,
    controlActions,
    anomalies,
    predictions,
    // state flags
    loading,
    error,
    isSimulating,
    // actions
    runSimulation,
    clearSimulation,
    dismissAnomaly,
  };
}
