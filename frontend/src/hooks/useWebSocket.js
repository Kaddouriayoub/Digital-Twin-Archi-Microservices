// ============================================================
// src/hooks/useWebSocket.js
// Opens a WebSocket to the backend and keeps state fresh.
// Auto-reconnects on disconnect with exponential backoff.
// ============================================================
import { useEffect, useRef, useState, useCallback } from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:3001/ws`;

export default function useWebSocket() {
  const [latestMessage, setLatestMessage] = useState(null);
  const [status, setStatus]               = useState('connecting'); // connecting | open | closed | error
  const wsRef       = useRef(null);
  const retryRef    = useRef(0);
  const timerRef    = useRef(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('open');
        retryRef.current = 0; // reset backoff
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLatestMessage(data);
        } catch { /* ignore malformed */ }
      };

      ws.onerror = () => setStatus('error');

      ws.onclose = () => {
        setStatus('closed');
        // Exponential backoff: 1s, 2s, 4s … capped at 30s
        const delay = Math.min(1000 * 2 ** retryRef.current, 30000);
        retryRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { latestMessage, wsStatus: status };
}
