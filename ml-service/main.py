"""FastAPI ML service — Isolation Forest anomaly detection sidecar."""

import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
from detector import AnomalyDetector
from trainer import retrain_all, retraining_loop


detector = AnomalyDetector()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load existing models, start retraining scheduler
    count = detector.load_all_models()
    print(f"[ML] Loaded {count} pre-trained models")
    task = asyncio.create_task(retraining_loop(detector))
    yield
    task.cancel()


app = FastAPI(title="Digital Twin ML Service", lifespan=lifespan)


class DetectRequest(BaseModel):
    service_name: str
    metrics: dict


class TrainRequest(BaseModel):
    service_name: str | None = None


@app.post("/detect")
def detect(req: DetectRequest):
    result = detector.predict(req.service_name, req.metrics)
    return {**result, "method": "isolation_forest"}


@app.post("/train")
def train(req: TrainRequest):
    if req.service_name:
        from trainer import load_history, MIN_SAMPLES
        import numpy as np
        X = load_history(req.service_name)
        if len(X) < MIN_SAMPLES:
            return {"status": "skipped", "reason": f"need {MIN_SAMPLES} samples, have {len(X)}"}
        detector.fit(req.service_name, X)
        return {"status": "trained", "service": req.service_name, "samples": len(X)}
    results = retrain_all(detector)
    return {"status": "complete", "results": results}


@app.get("/health")
def health():
    status = detector.get_status()
    return {"status": "ok", "models": status, "total_models": len(status)}
