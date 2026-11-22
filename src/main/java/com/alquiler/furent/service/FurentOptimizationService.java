package com.alquiler.furent.service;

import com.alquiler.furent.config.TenantContext;
import com.alquiler.furent.model.Product;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.repository.ProductRepository;
import com.alquiler.furent.repository.ReservationRepository;
import com.alquiler.furent.service.optimizacion.PythonOptimizerClient;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Orquestador del módulo de Investigación de Operaciones de Furent.
 *
 * Reúne los insumos reales de la base de datos (inventario de mobiliario y
 * reservas), arma el payload del modelo y delega la resolución en el
 * microservicio Python. La formulación matemática vive en Python; esta clase
 * solo prepara los datos y presenta el resultado.
 */
@Service
public class FurentOptimizationService {

    /** Estados que, por defecto, el modelo puede aceptar o rechazar. */
    private static final List<String> CANDIDATAS_FALLBACK =
            List.of("PENDIENTE", "CONFIRMADA", "ENTREGADA", "COMPLETADA");
    /** Estados que, por defecto, el modelo debe atender siempre. */
    private static final List<String> COMPROMETIDAS_DEF = List.of();

    private final ProductRepository productRepository;
    private final ReservationRepository reservationRepository;
    private final PythonOptimizerClient optimizer;

    public FurentOptimizationService(ProductRepository productRepository,
                                     ReservationRepository reservationRepository,
                                     PythonOptimizerClient optimizer) {
        this.productRepository = productRepository;
        this.reservationRepository = reservationRepository;
        this.optimizer = optimizer;
    }

    // ─────────────────────────── Resumen (carga inicial de la vista) ───────────────────────────

    /** Datos ligeros para pintar la vista antes de ejecutar el modelo. */
    public Map<String, Object> getResumen() {
        String tenant = TenantContext.getCurrentTenant();
        List<Product> productos = cargarProductos(tenant);
        List<Reservation> reservas = cargarReservas(tenant);
        LocalDate hoy = LocalDate.now();

        Set<String> estados = new LinkedHashSet<>();
        reservas.forEach(r -> {
            if (r.getEstado() != null && !r.getEstado().isBlank()) {
                estados.add(r.getEstado());
            }
        });

        // Por defecto, todo lo que existe (salvo canceladas) es elegible: el modelo
        // decide qué aceptar. El administrador puede mover estados a "comprometidas".
        List<String> candidatasDef = new ArrayList<>();
        for (String e : estados) {
            if (!"CANCELADA".equalsIgnoreCase(e)) {
                candidatasDef.add(e);
            }
        }
        if (candidatasDef.isEmpty()) {
            candidatasDef.addAll(CANDIDATAS_FALLBACK);
        }
        final List<String> candidatasFinal = candidatasDef;

        long candidatas = reservas.stream()
                .filter(r -> candidatasFinal.contains(r.getEstado())).count();
        long comprometidas = reservas.stream()
                .filter(r -> COMPROMETIDAS_DEF.contains(r.getEstado())).count();

        LocalDate minIni = reservas.stream().map(Reservation::getFechaInicio)
                .filter(Objects::nonNull).min(Comparator.naturalOrder()).orElse(null);
        LocalDate maxFin = reservas.stream()
                .map(r -> r.getFechaFin() != null ? r.getFechaFin() : r.getFechaInicio())
                .filter(Objects::nonNull).max(Comparator.naturalOrder()).orElse(null);

        // Horizonte sugerido derivado del rango real de reservas, para que el
        // modelo siempre tenga datos relevantes que analizar (aunque la base no
        // esté "al día"). Si no hay reservas, una ventana centrada en hoy.
        LocalDate desde;
        LocalDate hasta;
        if (minIni != null && maxFin != null && !maxFin.isBefore(minIni)) {
            desde = minIni;
            hasta = maxFin;
        } else {
            desde = hoy.minusDays(30);
            hasta = hoy.plusDays(30);
        }

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("disponibleSolver", optimizer.isAvailable());
        m.put("totalProductos", productos.size());
        m.put("totalReservas", reservas.size());
        m.put("candidatas", candidatas);
        m.put("comprometidas", comprometidas);
        m.put("estados", new ArrayList<>(estados));
        m.put("sugeridoDesde", desde.toString());
        m.put("sugeridoHasta", hasta.toString());
        m.put("candidatasDef", candidatasDef);
        m.put("comprometidasDef", COMPROMETIDAS_DEF);
        return m;
    }

    // ─────────────────────────── Ejecución del modelo ───────────────────────────

    /**
     * Construye el payload con datos reales y resuelve el modelo en Python.
     *
     * @param opciones supuestos editables: desde, hasta, candidatas,
     *                 comprometidas, costeFactor, maxExtraPct, permitirParcial
     */
    public Map<String, Object> optimizar(Map<String, Object> opciones) {
        String tenant = TenantContext.getCurrentTenant();
        LocalDate hoy = LocalDate.now();

        LocalDate desde = parseFecha(opciones.get("desde"), hoy.minusDays(30));
        LocalDate hasta = parseFecha(opciones.get("hasta"), hoy.plusDays(30));
        if (hasta.isBefore(desde)) {
            LocalDate tmp = desde;
            desde = hasta;
            hasta = tmp;
        }
        List<String> candidatas = listaTexto(opciones.get("candidatas"), CANDIDATAS_FALLBACK);
        List<String> comprometidas = listaTexto(opciones.get("comprometidas"), COMPROMETIDAS_DEF);
        double costeFactor = numero(opciones.get("costeFactor"), 3.0);
        double maxExtraPct = numero(opciones.get("maxExtraPct"), 50.0) / 100.0;
        boolean permitirParcial = booleano(opciones.get("permitirParcial"));
        Set<String> estados = new LinkedHashSet<>();
        estados.addAll(candidatas);
        estados.addAll(comprometidas);

        List<Product> productos = cargarProductos(tenant);
        List<Reservation> reservas = cargarReservas(tenant);

        Map<String, Product> porId = new HashMap<>();
        Map<String, Product> porNombre = new HashMap<>();
        for (Product p : productos) {
            if (p.getId() != null) {
                porId.put(p.getId(), p);
            }
            if (p.getNombre() != null) {
                porNombre.put(normalizar(p.getNombre()), p);
            }
        }

        Map<String, Map<String, Object>> usados = new LinkedHashMap<>();
        List<Map<String, Object>> demands = new ArrayList<>();

        for (Reservation r : reservas) {
            if (r.getEstado() == null || !estados.contains(r.getEstado())) {
                continue;
            }
            LocalDate ini = r.getFechaInicio();
            if (ini == null) {
                continue;
            }
            LocalDate fin = r.getFechaFin();
            if (fin == null || !fin.isAfter(ini)) {
                fin = ini.plusDays(Math.max(1, r.getDiasAlquiler()));
            }
            // El alquiler ocupa [ini, fin). Descartar si no cruza el horizonte.
            if (ini.isAfter(hasta) || !fin.isAfter(desde)) {
                continue;
            }

            List<Map<String, Object>> items = new ArrayList<>();
            for (Reservation.ItemReserva it : r.getItems()) {
                if (it == null || it.getCantidad() <= 0) {
                    continue;
                }
                Product p = resolverProducto(it, porId, porNombre);
                String pid;
                String nombre;
                int stock;
                double precio;
                if (p != null) {
                    pid = p.getId();
                    nombre = p.getNombre();
                    stock = p.getStock();
                    precio = decimal(p.getPrecioPorDia());
                } else {
                    nombre = it.getProductoNombre() != null ? it.getProductoNombre() : "Producto";
                    pid = "sin-catalogo-" + normalizarSlug(nombre);
                    stock = 0;
                    precio = decimal(it.getPrecioPorDia());
                }
                usados.putIfAbsent(pid, productoPayload(pid, nombre, stock, precio));
                Map<String, Object> itemPayload = new LinkedHashMap<>();
                itemPayload.put("productId", pid);
                itemPayload.put("qty", it.getCantidad());
                items.add(itemPayload);
            }
            if (items.isEmpty()) {
                continue;
            }

            Map<String, Object> demand = new LinkedHashMap<>();
            demand.put("id", r.getId());
            demand.put("codigo", r.getCodigoPagoEfectivo() != null
                    ? r.getCodigoPagoEfectivo() : r.getId());
            demand.put("cliente", r.getUsuarioNombre() != null ? r.getUsuarioNombre() : "");
            demand.put("tipoEvento", r.getTipoEvento() != null ? r.getTipoEvento() : "");
            demand.put("start", ini.toString());
            demand.put("end", fin.toString());
            demand.put("revenue", decimal(r.getTotal() != null ? r.getTotal() : r.getSubtotal()));
            demand.put("required", comprometidas.contains(r.getEstado()));
            demand.put("items", items);
            demands.add(demand);
        }

        Map<String, Object> assumptions = new LinkedHashMap<>();
        assumptions.put("extraUnitCostFactor", costeFactor);
        assumptions.put("maxExtraPct", maxExtraPct);
        assumptions.put("maxExtraAbs", 500);
        assumptions.put("penaltyFactor", 50.0);
        assumptions.put("allowPartial", permitirParcial);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("horizonStart", desde.toString());
        payload.put("horizonEnd", hasta.toString());
        payload.put("assumptions", assumptions);
        payload.put("products", new ArrayList<>(usados.values()));
        payload.put("demands", demands);

        Map<String, Object> respuesta;
        try {
            respuesta = optimizer.optimize(payload);
        } catch (PythonOptimizerClient.OptimizerUnavailableException e) {
            return resultadoSinSolver(e.getMessage(), desde, hasta);
        }
        if (respuesta == null) {
            return resultadoSinSolver("El optimizador no devolvió resultados.", desde, hasta);
        }

        respuesta.put("disponible", true);
        Map<String, Object> horizonte = new LinkedHashMap<>();
        horizonte.put("desde", desde.toString());
        horizonte.put("hasta", hasta.toString());
        respuesta.put("horizonte", horizonte);
        respuesta.put("candidatas", candidatas);
        respuesta.put("comprometidas", comprometidas);
        respuesta.put("totalInsumosProductos", usados.size());
        respuesta.put("totalInsumosReservas", demands.size());
        return respuesta;
    }

    // ─────────────────────────── Carga de datos ───────────────────────────

    private List<Product> cargarProductos(String tenant) {
        List<Product> out = new ArrayList<>();
        for (Product p : productRepository.findAll()) {
            if (coincideTenant(p.getTenantId(), tenant)) {
                out.add(p);
            }
        }
        return out;
    }

    private List<Reservation> cargarReservas(String tenant) {
        List<Reservation> out = new ArrayList<>();
        for (Reservation r : reservationRepository.findAll()) {
            if (coincideTenant(r.getTenantId(), tenant)) {
                out.add(r);
            }
        }
        return out;
    }

    /** Acepta registros del tenant actual o sin tenant asignado (datos semilla). */
    private boolean coincideTenant(String valorEntidad, String tenant) {
        if (tenant == null || tenant.isBlank() || "default".equals(tenant)) {
            return true;
        }
        return valorEntidad == null || valorEntidad.isBlank() || tenant.equals(valorEntidad);
    }

    // ─────────────────────────── Utilidades ───────────────────────────

    private Product resolverProducto(Reservation.ItemReserva it,
                                     Map<String, Product> porId, Map<String, Product> porNombre) {
        if (it.getProductoId() != null) {
            Product p = porId.get(it.getProductoId());
            if (p != null) {
                return p;
            }
        }
        if (it.getProductoNombre() != null) {
            return porNombre.get(normalizar(it.getProductoNombre()));
        }
        return null;
    }

    private Map<String, Object> productoPayload(String id, String nombre, int stock, double precio) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("id", id);
        p.put("nombre", nombre);
        p.put("stock", stock);
        p.put("precioPorDia", precio);
        return p;
    }

    private Map<String, Object> resultadoSinSolver(String mensaje, LocalDate desde, LocalDate hasta) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", "SIN_SOLVER");
        m.put("disponible", false);
        m.put("message", mensaje);
        m.put("objective", 0.0);
        m.put("revenue", 0.0);
        m.put("extraCost", 0.0);
        m.put("penaltyCost", 0.0);
        m.put("accepted", List.of());
        m.put("rejected", List.of());
        m.put("shortfalls", List.of());
        m.put("utilization", List.of());
        m.put("purchases", List.of());
        m.put("shadowPrices", List.of());
        m.put("heatmap", null);
        Map<String, Object> baseline = new LinkedHashMap<>();
        baseline.put("profit", 0.0);
        baseline.put("accepted", 0);
        baseline.put("rejected", 0);
        m.put("baseline", baseline);
        Map<String, Object> mejora = new LinkedHashMap<>();
        mejora.put("absolute", 0.0);
        mejora.put("pct", 0.0);
        m.put("improvement", mejora);
        m.put("solverStatus", "sin conexión");
        m.put("runtimeMs", 0);
        Map<String, Object> horizonte = new LinkedHashMap<>();
        horizonte.put("desde", desde.toString());
        horizonte.put("hasta", hasta.toString());
        m.put("horizonte", horizonte);
        return m;
    }

    private String normalizar(String s) {
        return s == null ? "" : s.trim().toLowerCase(Locale.ROOT);
    }

    private String normalizarSlug(String s) {
        return normalizar(s).replaceAll("[^a-z0-9]+", "-");
    }

    private double decimal(BigDecimal v) {
        return v == null ? 0.0 : v.doubleValue();
    }

    private LocalDate parseFecha(Object valor, LocalDate def) {
        if (valor == null) {
            return def;
        }
        try {
            return LocalDate.parse(String.valueOf(valor).substring(0, 10));
        } catch (DateTimeParseException | StringIndexOutOfBoundsException e) {
            return def;
        }
    }

    private double numero(Object valor, double def) {
        if (valor instanceof Number n) {
            return n.doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(valor));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private boolean booleano(Object valor) {
        if (valor instanceof Boolean b) {
            return b;
        }
        return valor != null && Boolean.parseBoolean(String.valueOf(valor));
    }

    private List<String> listaTexto(Object valor, List<String> def) {
        if (valor instanceof List<?> lista) {
            List<String> out = new ArrayList<>();
            for (Object o : lista) {
                if (o != null && !String.valueOf(o).isBlank()) {
                    out.add(String.valueOf(o));
                }
            }
            return out;
        }
        return def;
    }
}
