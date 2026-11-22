package com.alquiler.furent.controller.admin;

import com.alquiler.furent.model.Payment;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.model.StatusHistory;
import com.alquiler.furent.service.*;
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
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Controller
@RequestMapping("/admin/reservas")
public class AdminReservasController {

    private final ReservationService reservationService;
    private final AuditLogService auditLogService;
    private final NotificationService notificationService;
    private final PdfService pdfService;
    private final UserService userService;
    private final EmailService emailService;
    private final PaymentService paymentService;
    private final ObjectMapper objectMapper;

    public AdminReservasController(ReservationService reservationService, AuditLogService auditLogService,
            NotificationService notificationService, PdfService pdfService,
            UserService userService, EmailService emailService,
            PaymentService paymentService, ObjectMapper objectMapper) {
        this.reservationService = reservationService;
        this.auditLogService = auditLogService;
        this.notificationService = notificationService;
        this.pdfService = pdfService;
        this.userService = userService;
        this.emailService = emailService;
        this.paymentService = paymentService;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public String listReservations(Model model) {
        List<Reservation> reservas = new ArrayList<>(reservationService.getAllReservations());
        reservas.sort(Comparator.comparing(Reservation::getFechaCreacion,
                Comparator.nullsLast(Comparator.reverseOrder())));

        // ── Resumen del ciclo de vida (KPIs y chips de filtro) ──
        long total = reservas.size();
        long pendientes = contar(reservas, "PENDIENTE");
        long confirmadas = contar(reservas, "CONFIRMADA");
        long entregadas = contar(reservas, "ENTREGADA");
        long completadas = contar(reservas, "COMPLETADA");
        long canceladas = contar(reservas, "CANCELADA");

        BigDecimal facturado = BigDecimal.ZERO;
        long facturables = 0;
        BigDecimal porCobrar = BigDecimal.ZERO;
        long conSaldo = 0;
        for (Reservation r : reservas) {
            String estado = r.getEstado();
            boolean facturable = "CONFIRMADA".equals(estado) || "ENTREGADA".equals(estado)
                    || "COMPLETADA".equals(estado);
            if (facturable) {
                facturables++;
                facturado = facturado.add(valor(r.getTotal()));
            }
            BigDecimal saldo = valor(r.getSaldoPendiente());
            if (!"CANCELADA".equals(estado) && saldo.signum() > 0) {
                conSaldo++;
                porCobrar = porCobrar.add(saldo);
            }
        }
        BigDecimal ticket = facturables > 0
                ? facturado.divide(BigDecimal.valueOf(facturables), 0, RoundingMode.HALF_UP)
                : BigDecimal.ZERO;

        Map<String, Object> resumen = new LinkedHashMap<>();
        resumen.put("total", total);
        resumen.put("pendientes", pendientes);
        resumen.put("confirmadas", confirmadas);
        resumen.put("entregadas", entregadas);
        resumen.put("completadas", completadas);
        resumen.put("canceladas", canceladas);
        resumen.put("facturados", facturables);
        resumen.put("facturado", facturado);
        resumen.put("ticket", ticket);
        resumen.put("porCobrar", porCobrar);
        resumen.put("conSaldo", conSaldo);

        // ── Vista detallada en JSON (alimenta la tabla + el inspector) ──
        List<Map<String, Object>> vistaReservas = new ArrayList<>();
        for (Reservation r : reservas) {
            vistaReservas.add(toViewModel(r));
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("resumen", resumen);
        payload.put("reservas", vistaReservas);
        model.addAttribute("reservasJson", toJson(payload));

        // Compatibilidad con vistas/plantillas antiguas
        model.addAttribute("totalSaldoPendiente", porCobrar);
        model.addAttribute("reservas", reservas);

        return "admin/reservas";
    }

    @PostMapping("/eliminar/{id}")
    public String deleteReservation(@PathVariable String id,
                                    Authentication authentication,
                                    RedirectAttributes redirectAttributes) {
        try {
            reservationService.deleteById(id);
            if (authentication != null) {
                auditLogService.log(authentication.getName(), "ELIMINAR_COTIZACION", "RESERVA", id,
                        "Reserva/cotización eliminada manualmente desde el panel admin");
            }
            redirectAttributes.addFlashAttribute("success", "Cotización eliminada correctamente.");
        } catch (com.alquiler.furent.exception.ResourceNotFoundException ex) {
            redirectAttributes.addFlashAttribute("error", "La cotización ya no existe.");
        } catch (Exception ex) {
            redirectAttributes.addFlashAttribute("error", "No se pudo eliminar la cotización. Intenta de nuevo.");
        }
        return "redirect:/admin/reservas";
    }

    @PostMapping("/estado/{id}")
    public String updateReservationStatus(@PathVariable String id, @RequestParam String estado,
            @RequestParam(required = false) String nota,
            Authentication authentication,
            RedirectAttributes redirectAttributes) {
        try {
            try {
                com.alquiler.furent.enums.EstadoReserva.valueOf(estado);
            } catch (IllegalArgumentException e) {
                redirectAttributes.addFlashAttribute("error", "Estado no válido: " + estado);
                return "redirect:/admin/reservas";
            }

            reservationService.updateStatus(id, estado, authentication.getName(), nota);
            auditLogService.log(authentication.getName(), "CAMBIAR_ESTADO", "RESERVA", id, "Estado: " + estado);

            Reservation res = reservationService.getById(id).orElse(null);
            if (res != null) {
                notificationService.notify(res.getUsuarioId(), "Reserva Actualizada",
                        "Tu reserva ha cambiado a estado: " + estado, "INFO", "/panel");

                userService.findById(res.getUsuarioId()).ifPresent(user -> {
                    if (user.isNotificacionesEmail()) {
                        emailService.sendStatusChange(user.getEmail(), res.getId(), estado);
                    }
                });
            }
            redirectAttributes.addFlashAttribute("success", "Estado de reserva actualizado a " + estado);
        } catch (com.alquiler.furent.exception.InvalidOperationException e) {
            redirectAttributes.addFlashAttribute("error", e.getMessage());
        }
        return "redirect:/admin/reservas";
    }

    @PostMapping("/{id}/abono")
    public String registrarAbono(@PathVariable String id,
                                  @RequestParam BigDecimal monto,
                                  @RequestParam(defaultValue = "ABONO") String tipoPago,
                                  @RequestParam(required = false) String referencia,
                                  @RequestParam(required = false) String nota,
                                  Authentication authentication,
                                  RedirectAttributes redirectAttributes) {
        try {
            paymentService.registrarAbono(id, monto, tipoPago, referencia, nota, authentication.getName());
            redirectAttributes.addFlashAttribute("success",
                    String.format("Abono de $%,.0f registrado exitosamente.", monto));
        } catch (com.alquiler.furent.exception.InvalidOperationException e) {
            redirectAttributes.addFlashAttribute("error", e.getMessage());
        } catch (com.alquiler.furent.exception.ResourceNotFoundException e) {
            redirectAttributes.addFlashAttribute("error", "Reserva no encontrada.");
        }
        return "redirect:/admin/reservas";
    }

    @GetMapping("/contrato/{id}")
    public ResponseEntity<byte[]> downloadContrato(@PathVariable String id) {
        Reservation reservation = reservationService.getById(id).orElseThrow();

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("r", reservation);
        data.put("fechaContrato", LocalDate.now());

        byte[] pdf = pdfService.generatePdfFromHtml("admin/pdf/contrato", data);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=contrato_" + id + ".pdf")
                .contentType(MediaType.APPLICATION_PDF)
                .body(pdf);
    }

    // ── Helpers ─────────────────────────────────────────────────

    private long contar(List<Reservation> reservas, String estado) {
        return reservas.stream().filter(r -> estado.equals(r.getEstado())).count();
    }

    private Map<String, Object> toViewModel(Reservation r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.getId());
        m.put("cliente", texto(r.getUsuarioNombre(), "Cliente"));
        m.put("email", texto(r.getUsuarioEmail(), ""));
        m.put("estado", texto(r.getEstado(), "PENDIENTE"));
        m.put("estadoPago", texto(r.getEstadoPago(), "SIN_PAGO"));
        m.put("tipoEvento", texto(r.getTipoEvento(), ""));
        m.put("metodoPago", texto(r.getMetodoPago(), ""));
        m.put("direccion", texto(r.getDireccionEvento(), ""));
        m.put("notas", texto(r.getNotasEvento(), ""));
        m.put("horaEntrega", texto(r.getHoraEntrega(), ""));
        m.put("codigoPagoEfectivo", texto(r.getCodigoPagoEfectivo(), ""));
        m.put("fechaInicio", iso(r.getFechaInicio()));
        m.put("fechaFin", iso(r.getFechaFin()));
        m.put("fechaCreacion", r.getFechaCreacion() != null ? r.getFechaCreacion().toString() : "");
        m.put("fechaActualizacion", r.getFechaActualizacion() != null ? r.getFechaActualizacion().toString() : "");
        m.put("dias", r.getDiasAlquiler());
        m.put("subtotal", valor(r.getSubtotal()));
        m.put("descuento", valor(r.getDescuento()));
        m.put("cupon", texto(r.getCodigoCupon(), ""));
        m.put("total", valor(r.getTotal()));
        m.put("abonado", valor(r.getMontoAbonado()));
        m.put("saldo", valor(r.getSaldoPendiente()));
        m.put("pctPagado", r.getPorcentajePagado());

        List<Map<String, Object>> its = new ArrayList<>();
        if (r.getItems() != null) {
            for (Reservation.ItemReserva it : r.getItems()) {
                Map<String, Object> im = new LinkedHashMap<>();
                im.put("nombre", texto(it.getProductoNombre(), "Ítem"));
                im.put("cantidad", it.getCantidad());
                im.put("precioDia", valor(it.getPrecioPorDia()));
                im.put("subtotal", valor(it.getSubtotal()));
                its.add(im);
            }
        }
        m.put("items", its);

        List<Map<String, Object>> pgs = new ArrayList<>();
        if (r.getId() != null) {
            for (Payment p : paymentService.getPaymentsByReserva(r.getId())) {
                Map<String, Object> pm = new LinkedHashMap<>();
                pm.put("tipo", texto(p.getTipoPago(), "ABONO"));
                pm.put("monto", valor(p.getMonto()));
                pm.put("estado", texto(p.getEstado(), ""));
                pm.put("referencia", texto(p.getReferencia(), ""));
                pm.put("fecha", p.getFechaPago() != null ? p.getFechaPago().toString()
                        : (p.getFechaCreacion() != null ? p.getFechaCreacion().toString() : ""));
                pgs.add(pm);
            }
        }
        m.put("pagos", pgs);

        List<Map<String, Object>> hist = new ArrayList<>();
        if (r.getId() != null) {
            for (StatusHistory h : reservationService.getStatusHistory(r.getId())) {
                Map<String, Object> hm = new LinkedHashMap<>();
                hm.put("de", texto(h.getEstadoAnterior(), ""));
                hm.put("a", texto(h.getEstadoNuevo(), ""));
                hm.put("nota", texto(h.getNota(), ""));
                hm.put("usuario", texto(h.getUsuarioAccion(), ""));
                hm.put("fecha", h.getFecha() != null ? h.getFecha().toString() : "");
                hist.add(hm);
            }
        }
        m.put("historia", hist);
        return m;
    }

    private BigDecimal valor(BigDecimal v) {
        return v != null ? v : BigDecimal.ZERO;
    }

    private String texto(String v, String fallback) {
        return v != null && !v.isBlank() ? v : fallback;
    }

    private String iso(LocalDate d) {
        return d != null ? d.toString() : "";
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"resumen\":{},\"reservas\":[]}";
        }
    }
}
