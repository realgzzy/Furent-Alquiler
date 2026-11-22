"""
Microservicio del Optimizador de alquileres de Furent.

Expone el modelo de Investigación de Operaciones (MILP) por HTTP para que la
aplicación web de Spring Boot lo consuma de forma desacoplada.

Arranque:
    uvicorn app:app --host 127.0.0.1 --port 8090
o bien:
    python app.py
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from solver import solve

app = FastAPI(
    title="Furent · Optimizador de alquileres",
    description="Servicio de investigación de operaciones (MILP) para maximizar "
                "el beneficio del alquiler de mobiliario.",
    version="1.0.0",
)

# El consumo desde el navegador es opcional; permite depurar desde el front.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "furent-optimizer", "solver": "CBC", "version": "1.0.0"}


@app.post("/optimize")
def optimize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Resuelve el modelo y devuelve el plan óptimo de alquileres."""
    try:
        return solve(payload)
    except Exception as exc:  # noqa: BLE001 — se devuelve un error claro, nunca una traza
        return {
            "status": "ERROR",
            "message": "No se pudo resolver el modelo: " + str(exc),
            "objective": 0.0, "revenue": 0.0, "extraCost": 0.0, "penaltyCost": 0.0,
            "accepted": [], "rejected": [], "shortfalls": [],
            "utilization": [], "purchases": [], "shadowPrices": [], "heatmap": None,
            "baseline": {"profit": 0.0, "accepted": 0, "rejected": 0},
            "improvement": {"absolute": 0.0, "pct": 0.0},
            "solverStatus": "error", "runtimeMs": 0,
        }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8090, log_level="info")
