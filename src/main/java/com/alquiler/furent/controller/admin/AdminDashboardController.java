package com.alquiler.furent.controller.admin;

import com.alquiler.furent.model.AuditLog;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.service.AuditLogService;
import com.alquiler.furent.service.ContactService;
import com.alquiler.furent.service.CouponService;
import com.alquiler.furent.service.ProductService;
import com.alquiler.furent.service.ReservationService;
import com.alquiler.furent.service.ReviewService;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Controlador del panel de resumen (/admin).
 *
 * Reúne los indicadores del negocio (ingresos, reservas, clientes, alertas)
 * y expone la actividad reciente como JSON para que la tabla interactiva
 * filtre, busque y muestre el detalle sin recargar la página.
 */
@Controller
@RequestMapping("/admin")
public class AdminDashboardController {

    private static final DateTimeFormatter DIA_SERIE = DateTimeFormatter.ofPattern("d MMM", new Locale("es", "CO"));

    private final ProductService productService;
    private final ReservationService reservationService;
    private final UserService userService;
    private final AuditLogService auditLogService;
    private final ContactService contactService;
    private final ReviewService reviewService;
    private final CouponService couponService;
    private final ObjectMapper objectMapper;

    public AdminDashboardController(ProductService productService, ReservationService reservationService,
            UserService userService, AuditLogService auditLogService, ContactService contactService,
            ReviewService reviewService, CouponService couponService, ObjectMapper objectMapper) {
        this.productService = productService;
        this.reservationService = reservationService;
        this.userService = userService;
        this.auditLogService = auditLogService;
        this.contactService = contactService;
        this.reviewService = reviewService;
        this.couponService = couponService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("")
    public String dashboard(Model model) {
        long totalReservas = reservationService.count();
        BigDecimal totalIngresos = reservationService.calculateTotalRevenue();

        long pendientes = reservationService.countByEstado("PENDIENTE");
        long confirmadas = reservationService.countByEstado("CONFIRMADA");
        long entregadas = reservationService.countByEstado("ENTREGADA");
        long completadas = reservationService.countByEstado("COMPLETADA");
        long canceladas = reservationService.countByEstado("CANCELADA");
        long facturables = confirmadas + entregadas + completadas;

        model.addAttribute("totalProductos", productService.countProducts());
        model.addAttribute("totalCategorias", productService.countCategories());
        model.addAttribute("totalReservas", totalReservas);
        model.addAttribute("reservasPendientes", pendientes);
        model.addAttribute("reservasActivas", entregadas);
        model.addAttribute("reservasConfirmadas", confirmadas);
        model.addAttribute("reservasCompletadas", completadas);
        model.addAttribute("reservasCanceladas", canceladas);
        model.addAttribute("totalUsuarios", userService.count());
        model.addAttribute("totalIngresos", totalIngresos);
        model.addAttribute("ticketPromedio", facturables > 0
                ? totalIngresos.divide(BigDecimal.valueOf(facturables), 0, RoundingMode.HALF_UP)
                : BigDecimal.ZERO);

        model.addAttribute("statusData", reservationService.getStatusDistribution());
        model.addAttribute("ultimasReservas", reservationService.getRecentActivity());
        model.addAttribute("auditLogs", auditLogService.getRecentLogs());
        model.addAttribute("mensajesNoLeidos", contactService.countUnread());
        model.addAttribute("resenasPorResponder", reviewService.countUnanswered());
        model.addAttribute("cuponesActivos",
                couponService.getAll().stream().filter(c -> c.isActivo()).count());

        // Clientes nuevos en los últimos 30 días.
        LocalDateTime hace30 = LocalDateTime.now().minusDays(30);
        long nuevosClientes = userService.getAllUsers().stream()
                .filter(u -> u.getFechaCreacion() != null && u.getFechaCreacion().isAfter(hace30))
                .count();
        model.addAttribute("nuevosClientes", nuevosClientes);

        // Serie de ingresos (fechaCreacion) de los últimos 14 días.
        model.addAttribute("ingresosSerie", buildRevenueSeries(14));

        // Próximas entregas: reservas activas que comienzan en los próximos 30 días.
        LocalDate hoy = LocalDate.now();
        DateTimeFormatter fMes = DateTimeFormatter.ofPattern("MMM", new Locale("es", "CO"));
        List<Map<String, Object>> proximas = reservationService.getAllReservations().stream()
                .filter(r -> r.getFechaInicio() != null)
                .filter(r -> !"CANCELADA".equals(r.getEstado()) && !"COMPLETADA".equals(r.getEstado()))
                .filter(r -> !r.getFechaInicio().isBefore(hoy) && !r.getFechaInicio().isAfter(hoy.plusDays(30)))
                .sorted(Comparator.comparing(Reservation::getFechaInicio))
                .limit(6)
                .map(r -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", r.getId());
                    m.put("cliente", r.getUsuarioNombre() != null ? r.getUsuarioNombre() : "—");
                    m.put("tipoEvento", r.getTipoEvento() != null ? r.getTipoEvento() : "");
                    m.put("estado", r.getEstado());
                    m.put("dia", r.getFechaInicio().getDayOfMonth());
                    m.put("mes", r.getFechaInicio().format(fMes).replace(".", ""));
                    m.put("diasRestantes", ChronoUnit.DAYS.between(hoy, r.getFechaInicio()));
                    return m;
                })
                .collect(Collectors.toList());
        model.addAttribute("proximasEntregas", proximas);

        // Distribución por tipo de evento (excluye canceladas), ordenada de mayor a menor.
        Map<String, Long> porTipo = reservationService.getAllReservations().stream()
                .filter(r -> r.getTipoEvento() != null && !r.getTipoEvento().isBlank())
                .filter(r -> !"CANCELADA".equals(r.getEstado()))
                .collect(Collectors.groupingBy(Reservation::getTipoEvento, LinkedHashMap::new, Collectors.counting()));
        List<Map.Entry<String, Long>> tiposOrdenados = porTipo.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(6)
                .collect(Collectors.toList());
        long maxTipo = tiposOrdenados.stream().mapToLong(Map.Entry::getValue).max().orElse(0);
        List<Map<String, Object>> eventosPorTipo = new ArrayList<>();
        for (Map.Entry<String, Long> e : tiposOrdenados) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("tipo", e.getKey());
            m.put("total", e.getValue());
            m.put("pct", maxTipo > 0 ? Math.round(e.getValue() * 100.0 / maxTipo) : 0);
            eventosPorTipo.add(m);
        }
        model.addAttribute("eventosPorTipo", eventosPorTipo);

        // Total de alertas que requieren acción del administrador.
        long alertas = pendientes + contactService.countUnread() + reviewService.countUnanswered();
        model.addAttribute("alertasTotales", alertas);

        // JSON para la tabla interactiva (reservas + auditoría).
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("reservas", toReservaViewModels(reservationService.getAllReservations()));
        payload.put("logs", toLogViewModels(auditLogService.getRecentLogs()));
        model.addAttribute("dashboardJson", toJson(payload));

        return "admin/dashboard";
    }

    /** Serie ordenada de ingresos por día para los últimos {@code dias} días. */
    private Map<String, BigDecimal> buildRevenueSeries(int dias) {
        LocalDate hoy = LocalDate.now();
        Map<String, BigDecimal> serie = new LinkedHashMap<>();
        for (int i = dias - 1; i >= 0; i--) {
            serie.put(hoy.minusDays(i).format(DIA_SERIE), BigDecimal.ZERO);
        }
        for (Reservation r : reservationService.getAllReservations()) {
            if (r.getFechaCreacion() == null || r.getTotal() == null) {
                continue;
            }
            String clave = r.getFechaCreacion().toLocalDate().format(DIA_SERIE);
            if (serie.containsKey(clave)) {
                serie.put(clave, serie.get(clave).add(r.getTotal()));
            }
        }
        return serie;
    }

    private List<Map<String, Object>> toReservaViewModels(List<Reservation> reservas) {
        List<Reservation> ordenadas = new ArrayList<>(reservas);
        ordenadas.sort(Comparator.comparing(Reservation::getFechaCreacion,
                Comparator.nullsLast(Comparator.reverseOrder())));
        return ordenadas.stream().limit(40).map(r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId());
            m.put("cliente", r.getUsuarioNombre() != null ? r.getUsuarioNombre() : "—");
            m.put("email", r.getUsuarioEmail() != null ? r.getUsuarioEmail() : "");
            m.put("tipoEvento", r.getTipoEvento() != null ? r.getTipoEvento() : "");
            m.put("estado", r.getEstado());
            m.put("total", r.getTotal() != null ? r.getTotal() : BigDecimal.ZERO);
            m.put("fechaCreacion", r.getFechaCreacion() != null ? r.getFechaCreacion().toString() : "");
            m.put("fechaInicio", r.getFechaInicio() != null ? r.getFechaInicio().toString() : "");
            m.put("fechaFin", r.getFechaFin() != null ? r.getFechaFin().toString() : "");
            m.put("dias", r.getDiasAlquiler());
            m.put("direccion", r.getDireccionEvento() != null ? r.getDireccionEvento() : "");
            m.put("horaEntrega", r.getHoraEntrega() != null ? r.getHoraEntrega() : "");
            m.put("metodoPago", r.getMetodoPago() != null ? r.getMetodoPago() : "");
            m.put("items", r.getItems() != null ? r.getItems().size() : 0);
            return m;
        }).collect(Collectors.toList());
    }

    private List<Map<String, Object>> toLogViewModels(List<AuditLog> logs) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (AuditLog log : logs) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("accion", log.getAccion());
            m.put("entidad", log.getEntidad());
            m.put("detalle", log.getDetalle());
            m.put("usuario", log.getUsuario());
            m.put("severity", log.getSeverity());
            m.put("fecha", log.getFecha() != null ? log.getFecha().toString() : "");
            out.add(m);
        }
        return out;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"reservas\":[],\"logs\":[]}";
        }
    }
}
