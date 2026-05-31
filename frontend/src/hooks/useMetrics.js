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

  const pollTimerRef = useRef(null);

  // ── Apply a snapshot (from WS or REST) ───────────────────
  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setServices(snapshot.services  || []);
    setTopology(snapshot.topology  || { nodes: [], edges: [] });
    setLastUpdated(new Date(snapshot.collectedAt || Date.now()));
    setLoading(false);
    setError(null);
  }, []);

  // ── WebSocket push handler ─────────────────────────────
  useEffect(() => {
    if (!latestMessage) return;
    if (latestMessage.type === 'METRICS_UPDATE') {
      applySnapshot(latestMessage.payload);
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

  return {
    // data
    services,
    topology,
    scenarios,
    prometheusStatus,
    simulationResult,
    lastUpdated,
    wsStatus,
    // state flags
    loading,
    error,
    isSimulating,
    // actions
    runSimulation,
    clearSimulation,
  };
}
