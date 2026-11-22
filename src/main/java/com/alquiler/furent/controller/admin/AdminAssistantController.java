package com.alquiler.furent.controller.admin;

import com.alquiler.furent.assistant.AssistantAdminService;
import com.alquiler.furent.assistant.AssistantConversationService;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.AssistantMessage;
import com.alquiler.furent.service.AuditLogService;
import com.alquiler.furent.service.UserService;
import org.springframework.data.domain.Page;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseBody;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Panel de administración de conversaciones del asistente virtual.
 *
 * Solo lectura salvo "cerrar" y "eliminar conversación"; la protección de rol ADMIN la aplica
 * {@code SecurityConfig} sobre {@code /admin/**}.
 */
@Controller
@RequestMapping("/admin/asistente")
public class AdminAssistantController {

    private final AssistantAdminService adminService;
    private final AssistantConversationService conversationService;
    private final UserService userService;
    private final AuditLogService auditLogService;

    public AdminAssistantController(AssistantAdminService adminService,
                                    AssistantConversationService conversationService,
                                    UserService userService,
                                    AuditLogService auditLogService) {
        this.adminService = adminService;
        this.conversationService = conversationService;
        this.userService = userService;
        this.auditLogService = auditLogService;
    }

    @GetMapping
    public String list(@RequestParam(defaultValue = "0") int page,
                       @RequestParam(defaultValue = "25") int size,
                       @RequestParam(required = false) String estado,
                       @RequestParam(required = false) String cotizo,
                       @RequestParam(required = false) String desde,
                       @RequestParam(required = false) String hasta,
                       @RequestParam(required = false, name = "q") String query,
                       Model model) {
        int safePage = Math.max(page, 0);
        int safeSize = Math.max(10, Math.min(size, 100));
        Boolean cotizoFlag = parseBoolean(cotizo);
        Instant desdeInstant = startOfDay(desde);
        Instant hastaInstant = endOfDay(hasta);

        Page<AssistantConversation> resultado = adminService.search(
                estado, cotizoFlag, desdeInstant, hastaInstant, query, safePage, safeSize);

        model.addAttribute("conversaciones", resultado.getContent());
        model.addAttribute("currentPage", safePage);
        model.addAttribute("pageSize", safeSize);
        model.addAttribute("totalPages", resultado.getTotalPages());
        model.addAttribute("totalConversaciones", resultado.getTotalElements());

        model.addAttribute("filtroEstado", estado == null ? "ALL" : estado);
        model.addAttribute("filtroCotizo", cotizo == null ? "ALL" : cotizo);
        model.addAttribute("filtroDesde", desde == null ? "" : desde);
        model.addAttribute("filtroHasta", hasta == null ? "" : hasta);
        model.addAttribute("filtroQ", query == null ? "" : query);

        AssistantAdminService.Stats stats = adminService.stats();
        model.addAttribute("statsTotal", stats.total());
        model.addAttribute("statsActivas", stats.activas());
        model.addAttribute("statsEscaladas", stats.escaladas());
        model.addAttribute("statsCerradas", stats.cerradas());
        model.addAttribute("statsCotizadas", stats.cotizadas());
        model.addAttribute("statsHoy", stats.hoy());
        model.addAttribute("statsTotalCotizado", stats.totalCotizado());
        return "admin/asistente";
    }

    @GetMapping("/{id}")
    public String detail(@PathVariable String id, Model model, RedirectAttributes redirectAttributes) {
        Optional<AssistantConversation> found = conversationService.find(id);
        if (found.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", "La conversación no existe o fue eliminada.");
            return "redirect:/admin/asistente";
        }
        AssistantConversation conversacion = found.get();
        List<AssistantMessage> mensajes = adminService.messages(id);
        model.addAttribute("conversacion", conversacion);
        model.addAttribute("mensajes", mensajes);
        if (conversacion.getUserId() != null) {
            userService.findById(conversacion.getUserId())
                    .ifPresent(user -> model.addAttribute("usuario", user));
        }
        return "admin/asistente-detalle";
    }

    @PostMapping("/{id}/cerrar")
    public String close(@PathVariable String id,
                        Authentication authentication,
                        RedirectAttributes redirectAttributes) {
        Optional<AssistantConversation> found = conversationService.find(id);
        if (found.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", "La conversación no existe o fue eliminada.");
            return "redirect:/admin/asistente";
        }
        conversationService.close(found.get());
        auditLogService.log(authentication.getName(), "CERRAR_CONVERSACION_ASISTENTE",
                "ASISTENTE", id, "Conversación cerrada desde el panel");
        redirectAttributes.addFlashAttribute("success", "Conversación cerrada correctamente.");
        return "redirect:/admin/asistente/" + id;
    }

    /**
     * Elimina una conversación y todos sus mensajes. Acción irreversible.
     */
    @PostMapping("/{id}/eliminar")
    public String delete(@PathVariable String id,
                         Authentication authentication,
                         RedirectAttributes redirectAttributes) {
        Optional<AssistantConversation> found = conversationService.find(id);
        if (found.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", "La conversación no existe o fue eliminada.");
            return "redirect:/admin/asistente";
        }
        conversationService.delete(found.get());
        auditLogService.log(authentication.getName(), "ELIMINAR_CONVERSACION_ASISTENTE",
                "ASISTENTE", id, "Conversación eliminada desde el panel");
        redirectAttributes.addFlashAttribute("success", "Conversación eliminada correctamente.");
        return "redirect:/admin/asistente";
    }

    /**
     * Cuenta las conversaciones que coinciden con los filtros. Se usa para la vista previa
     * de la limpieza en bloque (no pagina, solo devuelve el total).
     */
    @GetMapping("/contar")
    @ResponseBody
    public Map<String, Long> contar(@RequestParam(required = false) String estado,
                                    @RequestParam(required = false) String cotizo,
                                    @RequestParam(required = false) String desde,
                                    @RequestParam(required = false) String hasta,
                                    @RequestParam(required = false, name = "q") String query) {
        long total = adminService.count(estado, parseBoolean(cotizo), startOfDay(desde), endOfDay(hasta), query);
        return Map.of("count", total);
    }

    /**
     * Limpieza en bloque de conversaciones (y sus mensajes).
     *
     * <ul>
     *   <li>{@code alcance=TODO} vacía todo el historial; exige escribir {@code ELIMINAR} en
     *       {@code confirmacion} como salvaguarda.</li>
     *   <li>{@code alcance=RANGO} borra las conversaciones cuyo último mensaje cae dentro del
     *       rango indicado; exige al menos una fecha (desde o hasta) y admite estado/cotización.</li>
     * </ul>
     */
    @PostMapping("/limpiar")
    public String limpiar(@RequestParam(defaultValue = "RANGO") String alcance,
                          @RequestParam(required = false) String estado,
                          @RequestParam(required = false) String cotizo,
                          @RequestParam(required = false) String desde,
                          @RequestParam(required = false) String hasta,
                          @RequestParam(required = false, name = "q") String query,
                          @RequestParam(required = false) String confirmacion,
                          Authentication authentication,
                          RedirectAttributes redirectAttributes) {
        boolean todo = "TODO".equalsIgnoreCase(alcance);
        boolean sinDesde = desde == null || desde.isBlank();
        boolean sinHasta = hasta == null || hasta.isBlank();

        if (todo) {
            if (confirmacion == null || !"ELIMINAR".equalsIgnoreCase(confirmacion.trim())) {
                redirectAttributes.addFlashAttribute("error",
                        "Para borrar todo el historial escribe ELIMINAR como confirmación.");
                return "redirect:/admin/asistente";
            }
        } else if (sinDesde && sinHasta) {
            redirectAttributes.addFlashAttribute("error",
                    "Indica al menos una fecha (desde o hasta) para borrar por rango.");
            return "redirect:/admin/asistente";
        }

        long eliminadas = adminService.deleteMatching(
                todo ? null : estado,
                todo ? null : parseBoolean(cotizo),
                todo ? null : startOfDay(desde),
                todo ? null : endOfDay(hasta),
                todo ? null : query);

        String detalle = todo
                ? "Limpieza total del historial: " + eliminadas + " conversaciones eliminadas"
                : "Limpieza por rango (desde=" + texto(desde) + ", hasta=" + texto(hasta)
                        + ", estado=" + texto(estado) + "): " + eliminadas + " conversaciones eliminadas";
        auditLogService.log(authentication.getName(), "LIMPIAR_CONVERSACIONES_ASISTENTE",
                "ASISTENTE", null, detalle);

        if (eliminadas == 0) {
            redirectAttributes.addFlashAttribute("success", "No había conversaciones que coincidieran con el criterio.");
        } else {
            redirectAttributes.addFlashAttribute("success", eliminadas
                    + (eliminadas == 1 ? " conversación eliminada." : " conversaciones eliminadas."));
        }
        return "redirect:/admin/asistente";
    }

    @GetMapping("/export.csv")
    public ResponseEntity<byte[]> export(@RequestParam(required = false) String estado,
                                         @RequestParam(required = false) String cotizo,
                                         @RequestParam(required = false) String desde,
                                         @RequestParam(required = false) String hasta,
                                         @RequestParam(required = false, name = "q") String query) {
        List<AssistantConversation> filas = adminService.listForExport(
                estado, parseBoolean(cotizo), startOfDay(desde), endOfDay(hasta), query);
        String csv = toCsv(filas);
        byte[] cuerpo = ("\uFEFF" + csv).getBytes(StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"asistente-conversaciones.csv\"")
                .contentType(MediaType.parseMediaType("text/csv; charset=UTF-8"))
                .body(cuerpo);
    }

    // ───────────────────────── Helpers ─────────────────────────

    private String toCsv(List<AssistantConversation> filas) {
        StringBuilder sb = new StringBuilder();
        sb.append("id,inicio,ultimoMensaje,estado,userId,sessionId,totalMensajes,cotizo,totalCotizado,pageContext\n");
        for (AssistantConversation c : filas) {
            sb.append(csv(c.getId())).append(',')
                    .append(csv(c.getInicio() == null ? "" : c.getInicio().toString())).append(',')
                    .append(csv(c.getUltimoMensaje() == null ? "" : c.getUltimoMensaje().toString())).append(',')
                    .append(csv(c.getEstado())).append(',')
                    .append(csv(c.getUserId())).append(',')
                    .append(csv(c.getSessionId())).append(',')
                    .append(c.getTotalMensajes()).append(',')
                    .append(c.isCotizo()).append(',')
                    .append(c.getTotalCotizado() == null ? "" : c.getTotalCotizado().toPlainString()).append(',')
                    .append(csv(c.getPageContext())).append('\n');
        }
        return sb.toString();
    }

    /** Escapa un valor para CSV y evita inyección de fórmulas en hojas de cálculo. */
    private String csv(String value) {
        if (value == null) {
            return "";
        }
        String safe = value;
        char first = safe.isEmpty() ? ' ' : safe.charAt(0);
        if (first == '=' || first == '+' || first == '-' || first == '@') {
            safe = "'" + safe;
        }
        if (safe.indexOf(',') >= 0 || safe.indexOf('"') >= 0 || safe.indexOf('\n') >= 0 || safe.indexOf('\r') >= 0) {
            safe = '"' + safe.replace("\"", "\"\"") + '"';
        }
        return safe;
    }

    private Boolean parseBoolean(String value) {
        if (value == null || value.isBlank() || "ALL".equalsIgnoreCase(value)) {
            return null;
        }
        return "true".equalsIgnoreCase(value) || "1".equals(value) || "on".equalsIgnoreCase(value);
    }

    /** Valor legible para el detalle de auditoría (evita "null" en el texto). */
    private String texto(String value) {
        return (value == null || value.isBlank()) ? "-" : value.trim();
    }

    private Instant startOfDay(String fecha) {
        LocalDate date = parseDate(fecha);
        return date == null ? null : date.atStartOfDay(ZoneId.systemDefault()).toInstant();
    }

    private Instant endOfDay(String fecha) {
        LocalDate date = parseDate(fecha);
        return date == null ? null
                : date.plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().minusMillis(1);
    }

    private LocalDate parseDate(String fecha) {
        if (fecha == null || fecha.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(fecha.trim());
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
