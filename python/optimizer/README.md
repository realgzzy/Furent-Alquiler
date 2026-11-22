# Optimizador de alquileres — Furent (Investigación de Operaciones)

Microservicio en Python que resuelve el modelo de optimización de recursos de
alquiler de Furent: decide qué reservas aceptar, cuánto inventario adicional
comprar, el valor de escasez de cada recurso (precio sombra) y dónde se satura
el inventario por producto y fecha.

La aplicación web (Spring Boot) construye el payload con los datos reales de la
base de datos y delega la resolución en este servicio por HTTP.

## Modelo

Programación Lineal Entera Mixta (MILP) resuelta con **PuLP + CBC**.

```
max  Z = Σ R_i · z_i  −  Σ c_p · y_p  −  M · Σ s_{p,t}

s.a.  Σ_{i ∋ (p,t)} q_ip · z_i  −  s_{p,t}  ≤  S_p + y_p     ∀ p, t
      z_i = 1                                              para reservas comprometidas
      z_i ∈ {0,1}                                          para reservas candidatas
      y_p ∈ Z≥0 ,  y_p ≤ tope
      s_{p,t} ≥ 0
```

- `R_i` ingreso de la reserva · `S_p` stock propio · `c_p` coste de una unidad extra
- `y_p` unidades extra adquiridas · `q_ip` cantidad del producto en la reserva
- `s_{p,t}` unidades-día comprometidas sin cubrir (penalizadas con `M`)

Los **precios sombra** se obtienen de los duales de la relajación LP. El
**método empírico** de comparación atiende las reservas por orden de llegada sin
comprar inventario.

## Arranque

```powershell
# Desde python/optimizer
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8090
```

La aplicación web apunta por defecto a `http://127.0.0.1:8090`
(configurable con `furent.optimizer.base-url` o la variable `OPTIMIZER_URL`).

## Endpoints

| Método | Ruta        | Descripción                                  |
|--------|-------------|----------------------------------------------|
| GET    | `/health`   | Estado del servicio                          |
| POST   | `/optimize` | Resuelve el modelo con el payload de entrada |

`sample_request.json` es un ejemplo del contrato de entrada. La respuesta
incluye `objective`, `accepted`, `rejected`, `utilization`, `purchases`,
`shadowPrices`, `heatmap`, `baseline` e `improvement`.

Si el servicio no está disponible, la web muestra un estado de error claro y no
aplica ninguna heurística alternativa: el modelo siempre se resuelve en Python.
