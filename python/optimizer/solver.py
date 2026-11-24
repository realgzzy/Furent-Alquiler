"""
Solver de optimización de alquileres de Furent — Investigación de Operaciones.

Modelo MILP (Mixed-Integer Linear Programming) resuelto con PuLP + CBC.

Problema
--------
Furent alquila mobiliario. En un horizonte de fechas llegan reservas (demandas),
cada una con un conjunto de productos y cantidades, que ocupan la capacidad de
inventario durante los días del alquiler. El objetivo es decidir qué demandas
atender para maximizar el beneficio, pudiendo adquirir unidades extra de
inventario (con un coste) y penalizando la demanda comprometida que no se logre
cubrir.

Formulación
-----------
    max  Z = Σ_i R_i · z_i  −  Σ_p c_p · y_p  −  Σ_p M_p · Σ_t s_{p,t}

    s.a.  Σ_{i ∋ (p,t)} q_{ip} · z_i  −  s_{p,t}  ≤  S_p + y_p     ∀ p, t
          z_i = 1                                                   ∀ i comprometida
          z_i ∈ {0,1}  (o [0,1] si se permite cubrir parcial)       ∀ i candidata
          y_p ∈ ℤ≥0 ,  y_p ≤ y_max_p
          s_{p,t} ≥ 0

    R_i  ingreso de la reserva i          S_p  stock propio del producto p
    c_p  coste de una unidad extra de p   y_p  unidades extra adquiridas
    q_ip cantidad del producto p en i     M_p  penalización por unidad-día sin cubrir del producto p
    s    demanda comprometida sin cubrir (unidades-día)
"""

from __future__ import annotations

import os
import shutil
import time
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

import pulp

DEFAULT_PENALTY_FACTOR = 50.0
MAX_HEATMAP_DAYS = 92
MAX_HEATMAP_PRODUCTS = 14


# ─────────────────────────── utilidades ───────────────────────────

def _get_solver(time_limit: int = 25):
    """Obtiene un solver CBC disponible en el sistema operativo o el empaquetado por PuLP."""
    # 1. Buscar binario 'cbc' del sistema (ej. /usr/bin/cbc en Debian/Ubuntu)
    system_cbc = shutil.which("cbc")
    if system_cbc and os.path.isfile(system_cbc) and os.access(system_cbc, os.X_OK):
        return pulp.COIN_CMD(path=system_cbc, msg=False, timeLimit=time_limit)

    for candidate in ("/usr/bin/cbc", "/usr/local/bin/cbc", "/opt/coinbrew/bin/cbc"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return pulp.COIN_CMD(path=candidate, msg=False, timeLimit=time_limit)

    # 2. Solver empaquetado por PuLP (funciona en Windows y distros Linux con glibc)
    try:
        bundled = pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
        if bundled.available():
            return bundled
    except Exception:
        pass

    # 3. GLPK si está instalado en el sistema
    glpk_path = shutil.which("glpsol") or "/usr/bin/glpsol"
    if os.path.isfile(glpk_path) and os.access(glpk_path, os.X_OK):
        return pulp.GLPK_CMD(path=glpk_path, msg=False, timeLimit=time_limit)

    # 4. Fallback estándar a PULP_CBC_CMD
    return pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)


def _safe(name: str) -> str:
    """PuLP exige nombres de variable válidos; sanea cualquier id."""
    return "".join(ch if ch.isalnum() else "_" for ch in str(name))[:48]


def _parse_date(value: Any) -> Optional[date]:
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _daterange(start: date, end: date) -> List[date]:
    out: List[date] = []
    d = start
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (ValueError, TypeError):
        return default


# ─────────────────────────── preparación ───────────────────────────

def _prepare(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normaliza el payload de entrada y calcula los conjuntos del modelo."""
    horizon_start = _parse_date(payload.get("horizonStart")) or date.today()
    horizon_end = _parse_date(payload.get("horizonEnd")) or (horizon_start + timedelta(days=60))
    if horizon_end < horizon_start:
        horizon_start, horizon_end = horizon_end, horizon_start
    days = _daterange(horizon_start, horizon_end)

    assumptions = payload.get("assumptions") or {}
    cost_factor = _num(assumptions.get("extraUnitCostFactor"), 3.0)
    max_extra_pct = _num(assumptions.get("maxExtraPct"), 0.5)
    max_extra_abs = _int(assumptions.get("maxExtraAbs"), 500)
    penalty_factor = _num(assumptions.get("penaltyFactor"), DEFAULT_PENALTY_FACTOR)
    allow_partial = bool(assumptions.get("allowPartial", False))

    products: Dict[str, Dict[str, Any]] = {}
    for raw in payload.get("products") or []:
        pid = str(raw.get("id"))
        stock = max(0, _int(raw.get("stock")))
        price = max(0.0, _num(raw.get("precioPorDia")))
        unit_cost = raw.get("extraUnitCost")
        unit_cost = _num(unit_cost) if unit_cost is not None else price * cost_factor
        ymax = max(0, min(max_extra_abs, int(round(stock * max_extra_pct + 1e-9))))
        products[pid] = {
            "id": pid,
            "nombre": raw.get("nombre") or pid,
            "stock": stock,
            "precio": price,
            "unitCost": max(0.0, unit_cost),
            "ymax": ymax,
        }

    dayset = set(days)
    demands: List[Dict[str, Any]] = []
    for idx, raw in enumerate(payload.get("demands") or []):
        start = _parse_date(raw.get("start"))
        end = _parse_date(raw.get("end"))
        if start is None:
            continue
        if end is None or end <= start:
            end = start + timedelta(days=1)
        occupied = [d for d in _daterange(start, end - timedelta(days=1)) if d in dayset]
        if not occupied:
            continue
        items = []
        for it in raw.get("items") or []:
            pid = str(it.get("productId"))
            qty = _int(it.get("qty"))
            if qty > 0 and pid in products:
                items.append((pid, qty))
        if not items:
            continue
        demands.append({
            "id": str(raw.get("id")),
            "codigo": raw.get("codigo") or str(raw.get("id")),
            "cliente": raw.get("cliente") or "",
            "tipoEvento": raw.get("tipoEvento") or "",
            "start": start,
            "end": end,
            "days": occupied,
            "revenue": max(0.0, _num(raw.get("revenue"))),
            "required": bool(raw.get("required", False)),
            "items": items,
            "arrival": idx,
        })

    # Cobertura: producto -> día -> [(demanda, cantidad)]
    coverage: Dict[str, Dict[date, List[Tuple[Dict[str, Any], int]]]] = {}
    for dem in demands:
        for pid, qty in dem["items"]:
            per_day = coverage.setdefault(pid, {})
            for d in dem["days"]:
                per_day.setdefault(d, []).append((dem, qty))

    used_products = sorted(coverage.keys())
    # Penalización por unidad-día sin cubrir, relativa al precio de cada producto
    # (evita que un producto caro distorsione el coste de incumplimiento del resto).
    for pid in used_products:
        p = products[pid]
        p["penalty"] = max(penalty_factor * p["precio"], p["unitCost"] * 2.0, 1.0)
    penalty = max([products[p]["penalty"] for p in used_products] + [1.0])

    return {
        "horizonStart": horizon_start,
        "horizonEnd": horizon_end,
        "days": days,
        "assumptions": {
            "costFactor": cost_factor,
            "maxExtraPct": max_extra_pct,
            "maxExtraAbs": max_extra_abs,
            "penaltyFactor": penalty_factor,
            "allowPartial": allow_partial,
        },
        "products": products,
        "demands": demands,
        "coverage": coverage,
        "used_products": used_products,
        "penalty": penalty,
    }


# ─────────────────────────── modelo ───────────────────────────

def _build(data: Dict[str, Any], relax: bool) -> Dict[str, Any]:
    """
    Construye el problema lineal. Si `relax` es True todas las variables son
    continuas (relajación LP) para poder leer los precios sombra (duales).
    """
    allow_partial = data["assumptions"]["allowPartial"]
    prob = pulp.LpProblem("furent_alquileres", pulp.LpMaximize)

    z: Dict[str, Any] = {}
    for dem in data["demands"]:
        if dem["required"]:
            z[dem["id"]] = 1.0
        else:
            if relax or allow_partial:
                z[dem["id"]] = pulp.LpVariable("z_" + _safe(dem["id"]), 0, 1, cat="Continuous")
            else:
                z[dem["id"]] = pulp.LpVariable("z_" + _safe(dem["id"]), cat="Binary")

    y: Dict[str, Any] = {}
    for pid in data["used_products"]:
        cat = "Continuous" if relax else "Integer"
        p = data["products"][pid]
        y[pid] = pulp.LpVariable("y_" + _safe(pid), 0, p["ymax"], cat=cat)

    s: Dict[Tuple[str, date], Any] = {}
    for pid in data["used_products"]:
        for d in data["days"]:
            if data["coverage"][pid].get(d):
                s[(pid, d)] = pulp.LpVariable("s_" + _safe(pid) + "_" + d.isoformat(), 0,
                                              cat="Continuous")

    # Objetivo
    revenue = pulp.lpSum([dem["revenue"] * z[dem["id"]] for dem in data["demands"]])
    extra = pulp.lpSum([data["products"][pid]["unitCost"] * y[pid] for pid in data["used_products"]])
    slackv = pulp.lpSum([data["products"][pid]["penalty"] * s[(pid, d)]
                         for (pid, d) in s]) if s else 0.0
    prob += revenue - extra - slackv

    # Restricciones de capacidad
    con: Dict[Tuple[str, date], Any] = {}
    for pid in data["used_products"]:
        p = data["products"][pid]
        for d, pairs in data["coverage"][pid].items():
            if not pairs:
                continue
            lhs = pulp.lpSum([qty * z[dem["id"]] for (dem, qty) in pairs])
            c = lhs - s[(pid, d)] <= p["stock"] + y[pid]
            prob += c
            con[(pid, d)] = c
    return {"prob": prob, "z": z, "y": y, "s": s, "con": con}


def _status(prob: Any) -> str:
    return pulp.LpStatus.get(prob.status, "Undefined")


# ─────────────────────────── línea base ───────────────────────────

def _baseline(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Método empírico: atender las reservas por orden de llegada mientras la
    capacidad propia lo permita, sin comprar inventario extra.
    """
    remaining: Dict[str, Dict[date, int]] = {}
    for pid in data["used_products"]:
        stock = data["products"][pid]["stock"]
        remaining[pid] = {d: stock for d in data["coverage"][pid]}

    served = 0
    profit = 0.0
    rejected = 0
    order = sorted(data["demands"], key=lambda x: x["arrival"])
    for dem in order:
        fits = True
        for pid, qty in dem["items"]:
            for d in dem["days"]:
                if remaining.get(pid, {}).get(d, 0) < qty:
                    fits = False
                    break
            if not fits:
                break
        if fits:
            served += 1
            profit += dem["revenue"]
            for pid, qty in dem["items"]:
                for d in dem["days"]:
                    remaining[pid][d] -= qty
        else:
            rejected += 1
    return {"profit": round(profit, 2), "accepted": served, "rejected": rejected}


# ─────────────────────────── resolución ───────────────────────────

def solve(payload: Dict[str, Any]) -> Dict[str, Any]:
    t0 = time.perf_counter()
    data = _prepare(payload)

    if not data["demands"] or not data["used_products"]:
        return {
            "status": "SIN_DEMANDA",
            "message": "No hay reservas que crucen el horizonte seleccionado.",
            "horizon": {"from": data["horizonStart"].isoformat(),
                        "to": data["horizonEnd"].isoformat(),
                        "days": len(data["days"])},
            "objective": 0.0, "revenue": 0.0, "extraCost": 0.0, "penaltyCost": 0.0,
            "accepted": [], "rejected": [], "shortfalls": [],
            "utilization": [], "purchases": [], "shadowPrices": [], "heatmap": None,
            "baseline": {"profit": 0.0, "accepted": 0, "rejected": 0},
            "improvement": {"absolute": 0.0, "pct": 0.0},
            "solverStatus": "sin demanda", "runtimeMs": int((time.perf_counter() - t0) * 1000),
        }

    built = _build(data, relax=False)
    prob = built["prob"]
    prob.solve(_get_solver(time_limit=25))

    status = _status(prob)
    if prob.status != pulp.LpStatusOptimal:
        return {
            "status": "ERROR",
            "message": "El solver no encontró solución óptima (" + status + ").",
            "horizon": {"from": data["horizonStart"].isoformat(),
                        "to": data["horizonEnd"].isoformat(),
                        "days": len(data["days"])},
            "objective": 0.0, "revenue": 0.0, "extraCost": 0.0, "penaltyCost": 0.0,
            "accepted": [], "rejected": [], "shortfalls": [],
            "utilization": [], "purchases": [], "shadowPrices": [], "heatmap": None,
            "baseline": _baseline(data),
            "improvement": {"absolute": 0.0, "pct": 0.0},
            "solverStatus": status, "runtimeMs": int((time.perf_counter() - t0) * 1000),
        }

    z = built["z"]
    y = built["y"]
    s = built["s"]

    def zval(dem: Dict[str, Any]) -> float:
        v = z[dem["id"]]
        return float(v) if isinstance(v, (int, float)) else float(v.value() or 0.0)

    serve = {dem["id"]: zval(dem) for dem in data["demands"]}

    revenue = round(sum(dem["revenue"] * serve[dem["id"]] for dem in data["demands"]), 2)
    extra_cost = round(sum(data["products"][pid]["unitCost"] * (y[pid].value() or 0.0)
                           for pid in data["used_products"]), 2)
    penalty_cost = round(sum(data["products"][pid]["penalty"] * (s[(pid, d)].value() or 0.0)
                             for (pid, d) in s), 2)

    # Uso diario por producto
    usage: Dict[str, Dict[date, float]] = {}
    for pid in data["used_products"]:
        usage[pid] = {d: 0.0 for d in data["coverage"][pid]}
    for dem in data["demands"]:
        frac = serve[dem["id"]]
        if frac <= 0:
            continue
        for pid, qty in dem["items"]:
            for d in dem["days"]:
                usage[pid][d] += qty * frac

    yunits = {pid: int(round(y[pid].value() or 0.0)) for pid in data["used_products"]}
    stock_eff = {pid: data["products"][pid]["stock"] + yunits[pid] for pid in data["used_products"]}

    # ── Precios sombra (relajación LP) ──
    dual_by_product: Dict[str, float] = {}
    dual_day: Dict[str, Optional[str]] = {}
    binding_days: Dict[str, int] = {}
    try:
        lp = _build(data, relax=True)
        lp["prob"].solve(_get_solver(time_limit=25))
        if lp["prob"].status == pulp.LpStatusOptimal:
            for pid in data["used_products"]:
                best = 0.0
                best_day = None
                bind = 0
                for d in data["coverage"][pid]:
                    c = lp["con"].get((pid, d))
                    if c is None:
                        continue
                    pi = c.pi
                    if pi is None:
                        continue
                    val = float(pi)
                    if val > 1e-6:
                        bind += 1
                    if val > best:
                        best, best_day = val, d
                dual_by_product[pid] = round(best, 2)
                dual_day[pid] = best_day.isoformat() if best_day else None
                binding_days[pid] = bind
    except Exception:  # noqa: BLE001 — los duales son informativos, nunca deben romper la respuesta
        pass

    # ── Filas de decisión ──
    def demand_row(dem: Dict[str, Any]) -> Dict[str, Any]:
        frac = serve[dem["id"]]
        return {
            "id": dem["id"],
            "codigo": dem["codigo"],
            "cliente": dem["cliente"],
            "tipoEvento": dem["tipoEvento"],
            "start": dem["start"].isoformat(),
            "end": dem["end"].isoformat(),
            "dias": len(dem["days"]),
            "revenue": round(dem["revenue"], 2),
            "required": dem["required"],
            "served": frac > 0.5,
            "servedPct": round(frac * 100, 1),
            "items": [{"productId": pid, "nombre": data["products"][pid]["nombre"], "qty": qty}
                      for pid, qty in dem["items"]],
        }

    accepted = [demand_row(d) for d in data["demands"] if serve[d["id"]] > 0.5]
    rejected = []
    for d in data["demands"]:
        if d["required"] or serve[d["id"]] > 0.5:
            continue
        row = demand_row(d)
        # Motivo: producto con mayor presión de capacidad sobre sus días.
        worst_pid, worst_pct = None, 0.0
        for pid, qty in d["items"]:
            cap = stock_eff.get(pid, 0)
            for day in d["days"]:
                used = usage.get(pid, {}).get(day, 0.0)
                pct = (used + qty) / cap if cap > 0 else 999.0
                if pct > worst_pct:
                    worst_pct, worst_pid = pct, pid
        row["reason"] = ("Sin inventario suficiente de "
                         + (data["products"][worst_pid]["nombre"] if worst_pid else "un producto")
                         + " en las fechas solicitadas")
        rejected.append(row)

    shortfalls = []
    for (pid, d), var in s.items():
        val = var.value() or 0.0
        if val > 1e-6:
            shortfalls.append({
                "productId": pid,
                "nombre": data["products"][pid]["nombre"],
                "date": d.isoformat(),
                "qty": int(round(val)),
            })
    shortfalls.sort(key=lambda x: (x["date"], x["nombre"]))

    # ── Utilización ──
    utilization = []
    for pid in data["used_products"]:
        p = data["products"][pid]
        daily = usage[pid]
        max_used = max(daily.values()) if daily else 0.0
        active_days = sum(1 for v in daily.values() if v > 1e-6)
        avg_used = (sum(daily.values()) / len(daily)) if daily else 0.0
        bottleneck = max(daily, key=lambda k: daily[k]) if daily else None
        cap = stock_eff[pid] if stock_eff[pid] > 0 else p["stock"]
        utilization.append({
            "productId": pid,
            "nombre": p["nombre"],
            "stock": p["stock"],
            "extra": yunits[pid],
            "stockEffective": stock_eff[pid],
            "maxUsed": int(round(max_used)),
            "avgUsed": round(avg_used, 1),
            "utilizationPct": round((max_used / cap) * 100, 1) if cap > 0 else 0.0,
            "activeDays": active_days,
            "bottleneckDate": bottleneck.isoformat() if bottleneck else None,
        })
    utilization.sort(key=lambda x: x["utilizationPct"], reverse=True)

    # ── Compras recomendadas ──
    purchases = []
    for pid in data["used_products"]:
        if yunits[pid] <= 0:
            continue
        unit_cost = data["products"][pid]["unitCost"]
        marginal = dual_by_product.get(pid, 0.0)
        purchases.append({
            "productId": pid,
            "nombre": data["products"][pid]["nombre"],
            "units": yunits[pid],
            "unitCost": round(unit_cost, 2),
            "totalCost": round(unit_cost * yunits[pid], 2),
            "marginalValuePerDay": marginal,
            "paybackDays": round(unit_cost / marginal, 1) if marginal > 1e-6 else None,
        })
    purchases.sort(key=lambda x: x["totalCost"], reverse=True)

    # ── Precios sombra ──
    shadow = []
    for pid in data["used_products"]:
        val = dual_by_product.get(pid, 0.0)
        if val <= 1e-6:
            continue
        shadow.append({
            "productId": pid,
            "nombre": data["products"][pid]["nombre"],
            "value": val,
            "bindingDays": binding_days.get(pid, 0),
            "peakDate": dual_day.get(pid),
            "unitCost": round(data["products"][pid]["unitCost"], 2),
        })
    shadow.sort(key=lambda x: x["value"], reverse=True)

    # ── Mapa de calor producto × día ──
    heatmap = None
    if data["days"]:
        top = sorted(data["used_products"],
                     key=lambda pid: max(usage[pid].values()) if usage[pid] else 0.0,
                     reverse=True)[:MAX_HEATMAP_PRODUCTS]
        all_days = data["days"]
        if len(all_days) > MAX_HEATMAP_DAYS:
            # Mostrar la ventana de mayor ocupación del horizonte, no los primeros
            # días (el horizonte puede incluir reservas antiguas poco relevantes).
            act = {d: 0.0 for d in all_days}
            for pid in data["used_products"]:
                for d, v in usage[pid].items():
                    act[d] = act.get(d, 0.0) + v
            best_i = 0
            running = sum(act.get(d, 0.0) for d in all_days[:MAX_HEATMAP_DAYS])
            best_sum = running
            for i in range(1, len(all_days) - MAX_HEATMAP_DAYS + 1):
                running += act.get(all_days[i + MAX_HEATMAP_DAYS - 1], 0.0) - act.get(all_days[i - 1], 0.0)
                if running > best_sum:
                    best_sum, best_i = running, i
            days_used = all_days[best_i:best_i + MAX_HEATMAP_DAYS]
        else:
            days_used = all_days
        heatmap = {
            "dates": [d.isoformat() for d in days_used],
            "truncated": len(data["days"]) > MAX_HEATMAP_DAYS,
            "rows": [{
                "productId": pid,
                "nombre": data["products"][pid]["nombre"],
                "stock": stock_eff[pid],
                "values": [int(round(usage[pid].get(d, 0.0))) for d in days_used],
            } for pid in top],
        }

    baseline = _baseline(data)
    objective = round(revenue - extra_cost - penalty_cost, 2)
    improvement_abs = round(objective - baseline["profit"], 2)
    improvement_pct = round((improvement_abs / baseline["profit"]) * 100, 2) if baseline["profit"] > 0 else 0.0

    return {
        "status": "OK",
        "solverStatus": status,
        "horizon": {"from": data["horizonStart"].isoformat(),
                    "to": data["horizonEnd"].isoformat(),
                    "days": len(data["days"])},
        "objective": objective,
        "revenue": revenue,
        "extraCost": extra_cost,
        "penaltyCost": penalty_cost,
        "demands": len(data["demands"]),
        "accepted": accepted,
        "rejected": rejected,
        "shortfalls": shortfalls,
        "utilization": utilization,
        "purchases": purchases,
        "shadowPrices": shadow,
        "heatmap": heatmap,
        "baseline": baseline,
        "improvement": {"absolute": improvement_abs, "pct": improvement_pct},
        "runtimeMs": int((time.perf_counter() - t0) * 1000),
    }
