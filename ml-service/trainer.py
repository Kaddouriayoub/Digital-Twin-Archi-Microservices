"""Periodic retraining of Isolation Forest models from TimescaleDB."""

import os
import asyncio
import numpy as np
import psycopg2
from detector import AnomalyDetector, FEATURES

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/digitaltwin")
RETRAIN_INTERVAL_HOURS = 24
MIN_SAMPLES = 50


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def load_history(service_name: str, hours: int = 168) -> np.ndarray:
    """Load last N hours of metrics from TimescaleDB."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT latency_p99, error_rate, throughput_rps, cpu_percent, memory_mb
               FROM service_metrics
               WHERE service_name = %s AND time > NOW() - make_interval(hours => %s)
               ORDER BY time ASC""",
            (service_name, hours),
        )
        rows = cur.fetchall()
        return np.array(rows, dtype=np.float64) if rows else np.empty((0, len(FEATURES)))
    finally:
        conn.close()


def get_all_services() -> list[str]:
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT service_name FROM service_metrics")
        return [r[0] for r in cur.fetchall()]
    finally:
        conn.close()


def retrain_all(detector: AnomalyDetector) -> dict:
    """Retrain models for all services with sufficient data."""
    results = {}
    try:
        services = get_all_services()
    except Exception as e:
        return {"error": str(e)}

    for svc in services:
        try:
            X = load_history(svc)
            if len(X) >= MIN_SAMPLES:
                detector.fit(svc, X)
                results[svc] = {"status": "trained", "samples": len(X)}
            else:
                results[svc] = {"status": "skipped", "samples": len(X), "reason": "insufficient_data"}
        except Exception as e:
            results[svc] = {"status": "error", "error": str(e)}
    return results


async def retraining_loop(detector: AnomalyDetector):
    """Background loop that retrains every RETRAIN_INTERVAL_HOURS."""
    while True:
        await asyncio.sleep(RETRAIN_INTERVAL_HOURS * 3600)
        retrain_all(detector)
