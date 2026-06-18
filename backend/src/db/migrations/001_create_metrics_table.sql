-- 001_create_metrics_table.sql
-- TimescaleDB hypertable for Digital Twin service metrics history

CREATE TABLE IF NOT EXISTS service_metrics (
  time           TIMESTAMPTZ NOT NULL,
  service_name   TEXT NOT NULL,
  latency_p99    FLOAT,
  error_rate     FLOAT,
  throughput_rps FLOAT,
  cpu_percent    FLOAT,
  memory_mb      FLOAT
);

SELECT create_hypertable('service_metrics', 'time', if_not_exists => TRUE);

-- Index for fast per-service queries
CREATE INDEX IF NOT EXISTS idx_metrics_service_time
  ON service_metrics (service_name, time DESC);
