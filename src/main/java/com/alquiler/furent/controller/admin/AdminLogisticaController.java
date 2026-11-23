package com.alquiler.furent.controller.admin;

import com.alquiler.furent.enums.EstadoReserva;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.model.User;
import com.alquiler.furent.service.AuditLogService;
import com.alquiler.furent.service.EmailService;
import com.alquiler.furent.service.NotificationService;
import com.alquiler.furent.service.PdfService;
import com.alquiler.furent.service.ReservationService;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Centro de Logística — entregas y retornos del ciclo operativo.
 *
 * <p>Expone un view-model JSON ({@code logisticaJson}) que alimenta el tablero:
 * KPIs de operación, cronograma mensual y manifiesto de operaciones. Cada
 * operación es una entrega ({@code fechaInicio}) o un retorno
 * ({@code fechaFin}) de una reserva confirmada/en curso/completada.</p>
 */
@Controller
@RequestMapping("/admin/logistica")
public class AdminLogisticaController {

    /** Estados de reserva que generan operación logística. */
    private static final Set<String> ESTADOS_LOGISTICOS = Set.of("CONFIRMADA", "ENTREGADA", "COMPLETADA");

    private final ReservationService reservationService;
    private final UserService userService;
    private final PdfService pdfService;
    private final AuditLogService auditLogService;
    private final NotificationService notificationService;
    private final EmailService emailService;
    private final ObjectMapper objectMapper;

    public AdminLogisticaController(ReservationService reservationService, UserService userService,
            PdfService pdfService, AuditLogService auditLogService, NotificationService notificationService,
            EmailService emailService, ObjectMapper objectMapper) {
        this.reservationService = reservationService;
        this.userService = userService;
        this.pdfService = pdfService;
        this.auditLogService = auditLogService;
        this.notificationService = notificationService;
        this.emailService = emailService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("")
    public String logistica(Model model) {
        model.addAttribute("activeMenu", "logistica");
        List<Reservation> allReservations = reservationService.getAllReservations();
        model.addAttribute("logisticaJson", toJson(buildLogisticaPayload(allReservations)));
        return "admin/logistica";
    }

    /**
     * Cambio de estado operativo desde el tablero de logística. Reutiliza las
     * transiciones validadas de {@link ReservationService} y notifica al cliente.
     */
    @PostMapping("/estado/{id}")
    public String updateEstado(@PathVariable String id, @RequestParam String estado,
            @RequestParam(required = false) String nota,
            Authentication authentication,
            RedirectAttributes redirectAttributes) {
        String usuario = (authentication != null && authentication.getName() != null)
                ? authentication.getName() : "Sistema";
        try {
            try {
                EstadoReserva.valueOf(estado);
            } catch (IllegalArgumentException e) {
                redirectAttributes.addFlashAttribute("error", "Estado no válido: " + estado);
                return "redirect:/admin/logistica";
            }

            reservationService.updateStatus(id, estado, usuario, nota);
            auditLogService.log(usuario, "CAMBIAR_ESTADO", "RESERVA", id, "Estado: " + estado + " (logística)");

            Reservation res = reservationService.getById(id).orElse(null);
            if (res != null && res.getUsuarioId() != null) {
                notificationService.notify(res.getUsuarioId(), "Reserva actualizada",
                        "Tu reserva cambió de estado a: " + estadoLabel(estado), "INFO", "/panel");
                userService.findById(res.getUsuarioId()).ifPresent(user -> {
                    if (user.isNotificacionesEmail()) {
                        emailService.sendStatusChange(user.getEmail(), res.getId(), estado);
                    }
                });
            }
            redirectAttributes.addFlashAttribute("success",
                    "Operación actualizada · " + estadoLabel(estado));
        } catch (com.alquiler.furent.exception.InvalidOperationException e) {
            redirectAttributes.addFlashAttribute("error", e.getMessage());
        } catch (Exception e) {
            redirectAttributes.addFlashAttribute("error", "No se pudo actualizar el estado. Intenta de nuevo.");
        }
        return "redirect:/admin/logistica";
    }

    @GetMapping("/hoja-ruta")
    public ResponseEntity<byte[]> downloadHojaRuta(@RequestParam(required = false) String fecha) {
        LocalDate date = (fecha != null && !fecha.isEmpty()) ? LocalDate.parse(fecha) : LocalDate.now();

        List<Reservation> todas = reservationService.getAllReservations();
        List<Reservation> logic = todas.stream()
                .filter(r -> (r.getFechaInicio() != null && r.getFechaInicio().equals(date)) ||
                        (r.getFechaFin() != null && r.getFechaFin().equals(date)))
                .collect(Collectors.toList());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("fecha", date);
        data.put("reservas", logic);
        data.put("totalEntregas",
                logic.stream().filter(r -> r.getFechaInicio() != null && r.getFechaInicio().equals(date)).count());
        data.put("totalRecogidas",
                logic.stream().filter(r -> r.getFechaFin() != null && r.getFechaFin().equals(date)).count());

        byte[] pdf = pdfService.generatePdfFromHtml("admin/pdf/hoja-ruta", data);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=hoja_ruta_" + date + ".pdf")
                .contentType(MediaType.APPLICATION_PDF)
                .body(pdf);
    }

    // ═══════════════════════════════════════════════════════════
    // Vista JSON para el tablero de logística
    // ═══════════════════════════════════════════════════════════

    private Map<String, Object> buildLogisticaPayload(List<Reservation> reservas) {
        LocalDate hoy = LocalDate.now();
        LocalDate finSemana = hoy.plusDays(6);
        String hoyStr = hoy.toString();
        String mananaStr = hoy.plusDays(1).toString();

        List<Map<String, Object>> ops = new ArrayList<>();
        Set<String> reservasEnAlcance = new HashSet<>();

        for (Reservation r : reservas) {
            if (r == null || r.getId() == null) continue;
            String estado = r.getEstado();
            if (!ESTADOS_LOGISTICOS.contains(estado)) continue;
            reservasEnAlcance.add(r.getId());

            String telefono = null;
            if (r.getUsuarioId() != null) {
                try {
                    telefono = userService.findById(r.getUsuarioId()).map(User::getTelefono).orElse(null);
                } catch (Exception ignored) { /* teléfono opcional */ }
            }

            List<Map<String, Object>> items = new ArrayList<>();
            int itemsTotal = 0;
            if (r.getItems() != null) {
                for (Reservation.ItemReserva it : r.getItems()) {
                    Map<String, Object> im = new LinkedHashMap<>();
                    im.put("nombre", texto(it.getProductoNombre(), "Mobiliario"));
                    im.put("cantidad", it.getCantidad());
                    items.add(im);
                    itemsTotal += it.getCantidad();
                }
            }

            if (r.getFechaInicio() != null) {
                ops.add(opView(r, "entrega", r.getFechaInicio(), r.getHoraEntrega(), telefono, items, itemsTotal));
            }
            if (r.getFechaFin() != null) {
                ops.add(opView(r, "retorno", r.getFechaFin(), null, telefono, items, itemsTotal));
            }
        }

        long entregasHoy = ops.stream()
                .filter(o -> "entrega".equals(o.get("tipo")) && hoyStr.equals(o.get("fecha"))).count();
        long retornosHoy = ops.stream()
                .filter(o -> "retorno".equals(o.get("tipo")) && hoyStr.equals(o.get("fecha"))).count();
        long manana = ops.stream().filter(o -> mananaStr.equals(o.get("fecha"))).count();
        long semana = ops.stream().filter(o -> inRango((String) o.get("fecha"), hoy, finSemana)).count();
        long atrasadas = ops.stream()
                .filter(o -> isAtrasada((String) o.get("fecha"), (String) o.get("estado"), hoy)).count();

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("totalOps", ops.size());
        stats.put("entregasHoy", entregasHoy);
        stats.put("retornosHoy", retornosHoy);
        stats.put("totalHoy", entregasHoy + retornosHoy);
        stats.put("manana", manana);
        stats.put("semana", semana);
        stats.put("atrasadas", atrasadas);
        stats.put("enCurso", reservas.stream().filter(r -> r != null && "ENTREGADA".equals(r.getEstado())).count());
        stats.put("pendientes", reservas.stream().filter(r -> r != null && "CONFIRMADA".equals(r.getEstado())).count());
        stats.put("completadas", reservas.stream().filter(r -> r != null && "COMPLETADA".equals(r.getEstado())).count());
        stats.put("totalReservas", reservasEnAlcance.size());

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("hoy", hoyStr);
        payload.put("stats", stats);
        payload.put("ops", ops);
        return payload;
    }

    private Map<String, Object> opView(Reservation r, String tipo, LocalDate fecha, String hora,
            String telefono, List<Map<String, Object>> items, int itemsTotal) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("id", r.getId() + "-" + tipo);
        v.put("tipo", tipo);
        v.put("fecha", fecha.toString());
        v.put("hora", texto(hora, ""));
        v.put("reservaId", r.getId());
        v.put("ref", ref(r.getId()));
        v.put("cliente", texto(r.getUsuarioNombre(), "Cliente"));
        v.put("email", texto(r.getUsuarioEmail(), ""));
        v.put("telefono", texto(telefono, ""));
        v.put("direccion", texto(r.getDireccionEvento(), ""));
        v.put("notas", texto(r.getNotasEvento(), ""));
        v.put("estado", texto(r.getEstado(), "CONFIRMADA"));
        v.put("estadoPago", texto(r.getEstadoPago(), "SIN_PAGO"));
        v.put("tipoEvento", texto(r.getTipoEvento(), ""));
        v.put("metodoPago", texto(r.getMetodoPago(), ""));
        v.put("total", valor(r.getTotal()));
        v.put("abonado", valor(r.getMontoAbonado()));
        v.put("saldo", valor(r.getSaldoPendiente()));
        v.put("pctPagado", r.getPorcentajePagado());
        v.put("items", items);
        v.put("itemsTotal", itemsTotal);
        return v;
    }

    private boolean inRango(String iso, LocalDate desde, LocalDate hasta) {
        if (iso == null) return false;
        try {
            LocalDate f = LocalDate.parse(iso);
            return !f.isBefore(desde) && !f.isAfter(hasta);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isAtrasada(String iso, String estado, LocalDate hoy) {
        if (iso == null || "COMPLETADA".equals(estado)) return false;
        try {
            return LocalDate.parse(iso).isBefore(hoy);
        } catch (Exception e) {
            return false;
        }
    }

    private String ref(String id) {
        if (id == null || id.isEmpty()) return "—";
        String s = id.replaceAll("[^A-Za-z0-9]", "");
        if (s.isEmpty()) return "—";
        return (s.length() <= 6 ? s : s.substring(s.length() - 6)).toUpperCase();
    }

    private String estadoLabel(String estado) {
        try {
            return EstadoReserva.valueOf(estado).getDisplayName();
        } catch (Exception e) {
            return estado;
        }
    }

    private BigDecimal valor(BigDecimal v) {
        return v != null ? v : BigDecimal.ZERO;
    }

    private String texto(String v, String fallback) {
        return v != null && !v.isBlank() ? v.trim() : fallback;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"hoy\":\"\",\"stats\":{},\"ops\":[]}";
        }
    }
}
