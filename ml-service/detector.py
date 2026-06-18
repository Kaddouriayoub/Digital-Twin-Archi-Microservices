"""Isolation Forest anomaly detector — one model per service."""

import os
import numpy as np
from sklearn.ensemble import IsolationForest
import joblib
from datetime import datetime

MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
FEATURES = ["latency_p99", "error_rate", "throughput_rps", "cpu_percent", "memory_mb"]


class AnomalyDetector:
    def __init__(self, contamination: float = 0.05):
        self.contamination = contamination
        self.models: dict[str, IsolationForest] = {}
        self.metadata: dict[str, dict] = {}
        os.makedirs(MODELS_DIR, exist_ok=True)

    def fit(self, service_name: str, X: np.ndarray) -> None:
        model = IsolationForest(contamination=self.contamination, random_state=42, n_estimators=100)
        model.fit(X)
        self.models[service_name] = model
        self.metadata[service_name] = {
            "last_trained_at": datetime.utcnow().isoformat(),
            "n_samples": len(X),
        }
        self.save_model(service_name)

    def predict(self, service_name: str, metrics: dict) -> dict:
        model = self.models.get(service_name)
        if model is None:
            return {"is_anomaly": False, "score": 0.0, "severity": "none", "trained": False}

        X = np.array([[metrics.get(f, 0.0) for f in FEATURES]])
        score = float(model.decision_function(X)[0])
        is_anomaly = bool(model.predict(X)[0] == -1)

        severity = "low"
        if is_anomaly:
            severity = "high" if score < -0.3 else "medium" if score < -0.15 else "low"

        return {"is_anomaly": is_anomaly, "score": round(score, 4), "severity": severity, "trained": True}

    def save_model(self, service_name: str) -> None:
        path = os.path.join(MODELS_DIR, f"{service_name}.joblib")
        joblib.dump(self.models[service_name], path)

    def load_model(self, service_name: str) -> bool:
        path = os.path.join(MODELS_DIR, f"{service_name}.joblib")
        if not os.path.exists(path):
            return False
        self.models[service_name] = joblib.load(path)
        self.metadata.setdefault(service_name, {"last_trained_at": "loaded_from_disk", "n_samples": 0})
        return True

    def load_all_models(self) -> int:
        count = 0
        for f in os.listdir(MODELS_DIR):
            if f.endswith(".joblib"):
                name = f.replace(".joblib", "")
                if self.load_model(name):
                    count += 1
        return count

    def get_status(self) -> dict:
        return {
            name: {"is_trained": True, **self.metadata.get(name, {})}
            for name in self.models
        }
