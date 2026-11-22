package com.alquiler.furent.controller.admin;

import com.alquiler.furent.model.WorkerPayment;
import com.alquiler.furent.service.PdfService;
import com.alquiler.furent.service.WorkerPaymentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Controlador administrativo de pagos a trabajadores.
 *
 * Sirve la vista de gestión, serializa los pagos como JSON para que la
 * interfaz filtre, ordene y pagine sin recargar, y expone las acciones de
 * alta/edición, borrado, exportación a PDF y envío por correo.
 */
@Controller
@RequestMapping("/admin/pagos-trabajadores")
public class AdminWorkerPaymentsController {

    private final WorkerPaymentService workerPaymentService;
    private final PdfService pdfService;
    private final ObjectMapper objectMapper;

    public AdminWorkerPaymentsController(WorkerPaymentService workerPaymentService,
            PdfService pdfService,
            ObjectMapper objectMapper) {
        this.workerPaymentService = workerPaymentService;
        this.pdfService = pdfService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("")
    public String list(Model model) {
        List<WorkerPayment> pagos = workerPaymentService.getAll();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("pagos", toViewModels(pagos));

        model.addAttribute("pagos", pagos);
        model.addAttribute("pagosJson", toJson(payload));
        model.addAttribute("activeMenu", "pagos-trabajadores");
        return "admin/pagos-trabajadores";
    }

    @PostMapping("/guardar")
    public String save(
            @RequestParam(required = false) String id,
            @RequestParam(required = false) String trabajadorNombre,
            @RequestParam(required = false) String trabajadorEmail,
            @RequestParam(required = false) String trabajadorRol,
            @RequestParam(required = false) String periodoTipo,
            @RequestParam(required = false) String periodoInicio,
            @RequestParam(required = false) String periodoFin,
            @RequestParam(required = false) String monto,
            @RequestParam(required = false) String tarifaHora,
            @RequestParam(required = false) String horasTrabajadas,
            @RequestParam(required = false) String eventosAtendidos,
            @RequestParam(required = false) String notas,
            RedirectAttributes redirectAttributes
    ) {
        boolean esNuevo = id == null || id.isBlank();
        List<String> errores = new ArrayList<>();

        String nombre = trabajadorNombre == null ? "" : trabajadorNombre.trim();
        if (nombre.isEmpty()) {
            errores.add("El nombre del trabajador es obligatorio.");
        }

        String email = trabajadorEmail == null ? "" : trabajadorEmail.trim();
        if (email.isEmpty() || !email.contains("@")) {
            errores.add("Indica un correo válido para enviar el comprobante.");
        }

        String tp = "QUINCENAL".equalsIgnoreCase(periodoTipo) ? "QUINCENAL" : "MENSUAL";

        LocalDate inicio = parseDate(periodoInicio);
        LocalDate fin = parseDate(periodoFin);
        if (inicio == null || fin == null) {
            errores.add("Indica la fecha de inicio y la de fin del período.");
        } else if (fin.isBefore(inicio)) {
            errores.add("La fecha de fin no puede ser anterior a la de inicio.");
        }

        BigDecimal montoVal = parseDecimal(monto);
        if (montoVal == null || montoVal.signum() <= 0) {
            errores.add("El monto total pagado debe ser mayor que cero.");
        }

        BigDecimal tarifa = parseDecimal(tarifaHora);
        if (tarifa != null && tarifa.signum() < 0) {
            errores.add("La tarifa por hora no puede ser negativa.");
        }
        Integer horas = parseInteger(horasTrabajadas);
        if (horas != null && horas < 0) {
            errores.add("Las horas trabajadas no pueden ser negativas.");
        }
        Integer eventos = parseInteger(eventosAtendidos);
        if (eventos != null && eventos < 0) {
            errores.add("Los eventos atendidos no pueden ser negativos.");
        }

        if (!errores.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", String.join(" ", errores));
            return "redirect:/admin/pagos-trabajadores";
        }

        WorkerPayment payment = esNuevo
                ? new WorkerPayment()
                : workerPaymentService.getById(id).orElse(new WorkerPayment());

        payment.setTrabajadorNombre(nombre);
        payment.setTrabajadorEmail(email);
        payment.setTrabajadorRol(blankToNull(trabajadorRol));
        payment.setPeriodoTipo(tp);
        payment.setPeriodoInicio(inicio);
        payment.setPeriodoFin(fin);
        payment.setMonto(montoVal.setScale(2, RoundingMode.HALF_UP));
        payment.setTarifaHora(tarifa == null ? null : tarifa.setScale(2, RoundingMode.HALF_UP));
        payment.setHorasTrabajadas(horas);
        payment.setEventosAtendidos(eventos);
        payment.setNotas(blankToNull(notas));

        workerPaymentService.save(payment);

        String primerNombre = nombre.split("\\s+")[0];
        redirectAttributes.addFlashAttribute("success",
                esNuevo
                        ? "Pago registrado para " + primerNombre + ". Ya puedes generar el PDF y enviarlo."
                        : "Pago de " + primerNombre + " actualizado correctamente.");
        return "redirect:/admin/pagos-trabajadores";
    }

    @PostMapping("/eliminar/{id}")
    public String delete(@PathVariable String id, RedirectAttributes redirectAttributes) {
        WorkerPayment payment = workerPaymentService.getById(id).orElse(null);
        if (payment == null) {
            redirectAttributes.addFlashAttribute("error", "Ese pago ya no existe.");
            return "redirect:/admin/pagos-trabajadores";
        }
        workerPaymentService.delete(id);
        redirectAttributes.addFlashAttribute("success", "Pago de " + payment.getTrabajadorNombre() + " eliminado.");
        return "redirect:/admin/pagos-trabajadores";
    }

    /**
     * Builds the data map for the PDF template, pre-formatting dates and numbers
     * to avoid relying on Thymeleaf utility objects that are incompatible with OpenHTMLtoPDF.
     */
    private Map<String, Object> buildPdfData(WorkerPayment payment) {
        Map<String, Object> data = new HashMap<>();
        data.put("pago", payment);

        // Pre-format dates as strings
        DateTimeFormatter dateFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy");
        DateTimeFormatter dateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm");

        data.put("periodoInicioStr",
                payment.getPeriodoInicio() != null ? payment.getPeriodoInicio().format(dateFormatter) : "—");
        data.put("periodoFinStr",
                payment.getPeriodoFin() != null ? payment.getPeriodoFin().format(dateFormatter) : "—");
        data.put("fechaCreacionStr",
                payment.getFechaCreacion() != null ? payment.getFechaCreacion().format(dateTimeFormatter) : "—");

        // Pre-format numbers as strings
        data.put("montoStr",
                payment.getMonto() != null ? "$" + String.format("%,.0f", payment.getMonto()) : "$0");
        data.put("tarifaHoraStr",
                payment.getTarifaHora() != null ? "$" + String.format("%,.0f", payment.getTarifaHora()) : "$0");

        return data;
    }

    @GetMapping("/{id}/pdf")
    public ResponseEntity<byte[]> pdf(@PathVariable String id) {
        WorkerPayment payment = workerPaymentService.getById(id)
                .orElseThrow(() -> new IllegalArgumentException("Pago de trabajador no encontrado"));

        Map<String, Object> data = buildPdfData(payment);
        byte[] pdf = pdfService.generatePdfFromHtml("admin/pdf/pago-trabajador", data);

        String filename = "pago_trabajador_" + payment.getTrabajadorNombre() + "_" + payment.getId() + ".pdf";
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + filename.replace(" ", "_"))
                .contentType(MediaType.APPLICATION_PDF)
                .body(pdf);
    }

    @PostMapping("/{id}/enviar")
    @ResponseBody
    public ResponseEntity<Map<String, Object>> enviar(@PathVariable String id) {
        WorkerPayment payment = workerPaymentService.getById(id).orElse(null);
        if (payment == null) {
            Map<String, Object> errorBody = new HashMap<>();
            errorBody.put("success", false);
            errorBody.put("message", "Pago no encontrado");
            return ResponseEntity.badRequest().body(errorBody);
        }

        if (payment.getTrabajadorEmail() == null || payment.getTrabajadorEmail().isBlank()) {
            Map<String, Object> errorBody = new HashMap<>();
            errorBody.put("success", false);
            errorBody.put("message", "Este pago no tiene correo de destino.");
            return ResponseEntity.badRequest().body(errorBody);
        }

        // Generate the PDF to attach to the email
        Map<String, Object> pdfData = buildPdfData(payment);
        byte[] pdfBytes = pdfService.generatePdfFromHtml("admin/pdf/pago-trabajador", pdfData);
        String pdfFilename = "Comprobante_Pago_" + (payment.getTrabajadorNombre() != null
                ? payment.getTrabajadorNombre().replace(" ", "_") : "trabajador") + ".pdf";

        workerPaymentService.sendPaymentEmailWithPdf(payment, pdfBytes, pdfFilename);

        Map<String, Object> okBody = new HashMap<>();
        okBody.put("success", true);
        okBody.put("message", "Correo enviado a " + payment.getTrabajadorEmail());
        return ResponseEntity.ok(okBody);
    }

    private List<Map<String, Object>> toViewModels(List<WorkerPayment> pagos) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (WorkerPayment p : pagos) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", p.getId());
            m.put("trabajadorNombre", p.getTrabajadorNombre());
            m.put("trabajadorEmail", p.getTrabajadorEmail());
            m.put("trabajadorRol", p.getTrabajadorRol());
            m.put("periodoTipo", p.getPeriodoTipo());
            m.put("periodoInicio", p.getPeriodoInicio() != null ? p.getPeriodoInicio().toString() : "");
            m.put("periodoFin", p.getPeriodoFin() != null ? p.getPeriodoFin().toString() : "");
            m.put("monto", p.getMonto());
            m.put("tarifaHora", p.getTarifaHora());
            m.put("horasTrabajadas", p.getHorasTrabajadas());
            m.put("eventosAtendidos", p.getEventosAtendidos());
            m.put("moneda", p.getMoneda());
            m.put("notas", p.getNotas());
            m.put("estado", p.getEstado());
            m.put("fechaCreacion", p.getFechaCreacion() != null ? p.getFechaCreacion().toString() : "");
            out.add(m);
        }
        return out;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"pagos\":[]}";
        }
    }

    private LocalDate parseDate(String value) {
        try {
            return (value == null || value.isBlank()) ? null : LocalDate.parse(value.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private BigDecimal parseDecimal(String value) {
        try {
            return (value == null || value.isBlank()) ? null : new BigDecimal(value.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private Integer parseInteger(String value) {
        try {
            return (value == null || value.isBlank()) ? null : Integer.valueOf(value.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private String blankToNull(String value) {
        return (value == null || value.isBlank()) ? null : value.trim();
    }
}
