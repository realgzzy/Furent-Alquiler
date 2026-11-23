package com.alquiler.furent.controller;

import com.alquiler.furent.assistant.AssistantConversationService;
import com.alquiler.furent.assistant.ToolContext;
import com.alquiler.furent.config.FeatureFlags;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.User;
import com.alquiler.furent.service.PdfService;
import com.alquiler.furent.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Endpoints auxiliares del asistente que no forman parte del stream de chat:
 * valoración de respuestas y descarga de la cotización en PDF.
 */
@RestController
@RequestMapping("/api/asistente")
public class AssistantExtrasController {

    private static final Logger log = LoggerFactory.getLogger(AssistantExtrasController.class);
    private static final DateTimeFormatter FECHA = DateTimeFormatter.ofPattern("dd/MM/yyyy");

    private final FeatureFlags featureFlags;
    private final AssistantConversationService conversations;
    private final UserService userService;
    private final PdfService pdfService;

    public AssistantExtrasController(FeatureFlags featureFlags,
                                     AssistantConversationService conversations,
                                     UserService userService,
                                     PdfService pdfService) {
        this.featureFlags = featureFlags;
        this.conversations = conversations;
        this.userService = userService;
        this.pdfService = pdfService;
    }

    /** Registra 👍/👎 sobre la conversación; el panel de administración ve los contadores. */
    @PostMapping("/feedback")
    public ResponseEntity<?> feedback(@RequestBody(required = false) Map<String, Object> body,
                                      HttpServletRequest request,
                                      Authentication authentication) {
        if (!featureFlags.isAssistantEnabled()) {
            return json(HttpStatus.SERVICE_UNAVAILABLE, Map.of("codigo", "UNAVAILABLE",
                    "mensaje", "El asistente no está disponible en este momento."));
        }
        String userId = resolveUserId(authentication);
        if (userId == null) {
            return json(HttpStatus.UNAUTHORIZED, Map.of("codigo", "AUTH_REQUIRED",
                    "mensaje", "Inicia sesión para valorar la respuesta."));
        }
        String conversationId = texto(body, "conversationId");
        if (conversationId.isBlank()) {
            return json(HttpStatus.BAD_REQUEST, Map.of("codigo", "INVALID_INPUT",
                    "mensaje", "Falta la conversación."));
        }
        String valor = texto(body, "valor").toUpperCase();
        boolean positivo;
        if (valor.equals("POSITIVO") || valor.equals("UP") || valor.equals("1") || valor.equals("👍")) {
            positivo = true;
        } else if (valor.equals("NEGATIVO") || valor.equals("DOWN") || valor.equals("-1") || valor.equals("👎")) {
            positivo = false;
        } else {
            return json(HttpStatus.BAD_REQUEST, Map.of("codigo", "INVALID_INPUT",
                    "mensaje", "Valor de valoración no reconocido."));
        }

        ToolContext context = resolveContext(userId, request);
        Optional<AssistantConversation> found = conversations.find(conversationId);
        if (found.isEmpty() || !conversations.owns(found.get(), context)) {
            return json(HttpStatus.NOT_FOUND, Map.of("codigo", "NOT_FOUND",
                    "mensaje", "No encontré esa conversación."));
        }
        conversations.registerFeedback(found.get(), positivo);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", true);
        payload.put("positivos", found.get().getFeedbackPositivo());
        payload.put("negativos", found.get().getFeedbackNegativo());
        return ResponseEntity.ok(payload);
    }

    /** Genera el PDF de la cotización que el widget tiene en pantalla. */
    @PostMapping("/cotizacion/pdf")
    public ResponseEntity<?> cotizacionPdf(@RequestBody(required = false) Map<String, Object> body,
                                           HttpServletRequest request,
                                           Authentication authentication) {
        if (!featureFlags.isAssistantEnabled()) {
            return json(HttpStatus.SERVICE_UNAVAILABLE, Map.of("codigo", "UNAVAILABLE",
                    "mensaje", "El asistente no está disponible en este momento."));
        }
        String userId = resolveUserId(authentication);
        if (userId == null) {
            return json(HttpStatus.UNAUTHORIZED, Map.of("codigo", "AUTH_REQUIRED",
                    "mensaje", "Inicia sesión para descargar la cotización."));
        }
        List<Map<String, Object>> items = items(body);
        if (items.isEmpty()) {
            return json(HttpStatus.BAD_REQUEST, Map.of("codigo", "INVALID_INPUT",
                    "mensaje", "No hay una cotización para descargar."));
        }

        long dias = Math.max(1, entero(body.get("dias"), 1));
        BigDecimal subtotalDia = decimal(body.get("subtotal"));
        BigDecimal descuento = decimal(body.get("descuento"));
        BigDecimal total = decimal(body.get("total"));
        List<Map<String, Object>> lineas = new ArrayList<>();
        BigDecimal calculadoDia = BigDecimal.ZERO;
        for (Map<String, Object> item : items) {
            String nombre = texto(item, "nombre");
            if (nombre.isBlank()) {
                nombre = "Producto";
            }
            int cantidad = (int) Math.max(1, entero(item.get("cantidad"), 1));
            BigDecimal precioDia = decimal(item.get("precioDia"));
            Object subtotalItemRaw = item.get("subtotal");
            BigDecimal subtotalItem = subtotalItemRaw instanceof Number || subtotalItemRaw instanceof String
                    ? decimal(subtotalItemRaw)
                    : precioDia.multiply(BigDecimal.valueOf(cantidad));
            if (subtotalItem.signum() == 0) {
                subtotalItem = precioDia.multiply(BigDecimal.valueOf(cantidad));
            }
            BigDecimal lineaTotal = subtotalItem.multiply(BigDecimal.valueOf(dias));
            calculadoDia = calculadoDia.add(subtotalItem);
            Map<String, Object> linea = new LinkedHashMap<>();
            linea.put("nombre", nombre);
            linea.put("cantidad", cantidad);
            linea.put("precioDia", precioDia);
            linea.put("subtotal", subtotalItem);
            linea.put("total", lineaTotal);
            lineas.add(linea);
        }
        if (subtotalDia.signum() == 0) {
            subtotalDia = calculadoDia;
        }
        BigDecimal totalBruto = decimal(body.get("totalBruto"));
        if (totalBruto.signum() == 0) {
            totalBruto = subtotalDia.multiply(BigDecimal.valueOf(dias));
        }
        if (total.signum() == 0) {
            total = totalBruto.subtract(descuento);
        }

        String email = userService.findById(userId).map(User::getEmail).orElse("Cliente Furent");
        LocalDate hoy = LocalDate.now();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cliente", email);
        data.put("fecha", hoy.format(FECHA));
        data.put("dias", dias);
        data.put("fechaInicio", texto(body, "fechaInicio"));
        data.put("fechaFin", texto(body, "fechaFin"));
        data.put("items", lineas);
        data.put("subtotal", subtotalDia);
        data.put("totalBruto", totalBruto);
        data.put("descuento", descuento);
        data.put("total", total);
        data.put("codigoCupon", texto(body, "codigoCupon"));
        data.put("nota", "La disponibilidad no bloquea el inventario hasta confirmar y pagar. "
                + "Máximo 7 días por alquiler.");

        byte[] pdf;
        try {
            pdf = pdfService.generatePdfFromHtml("assistant/pdf/cotizacion", data);
        } catch (Exception e) {
            log.error("No se pudo generar el PDF de la cotización", e);
            return json(HttpStatus.INTERNAL_SERVER_ERROR, Map.of("codigo", "PDF_ERROR",
                    "mensaje", "No pude generar el PDF en este momento. Intenta de nuevo."));
        }
        String filename = "cotizacion-furent-" + hoy + ".pdf";
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentType(MediaType.APPLICATION_PDF)
                .body(pdf);
    }

    // ───────────────────────── Helpers ─────────────────────────

    private ToolContext resolveContext(String userId, HttpServletRequest request) {
        HttpSession session = request.getSession(true);
        Object existing = session.getAttribute(AssistantController.SESSION_ATTR);
        String sessionId;
        if (existing instanceof String value && !value.isBlank()) {
            sessionId = value;
        } else {
            sessionId = UUID.randomUUID().toString();
            session.setAttribute(AssistantController.SESSION_ATTR, sessionId);
        }
        return new ToolContext(userId, sessionId, List.of());
    }

    private String resolveUserId(Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated()
                || "anonymousUser".equals(authentication.getPrincipal())) {
            return null;
        }
        String email;
        if (authentication instanceof OAuth2AuthenticationToken oauth2) {
            email = oauth2.getPrincipal().getAttribute("email");
        } else {
            email = authentication.getName();
        }
        if (email == null) {
            return null;
        }
        return userService.findByEmail(email).map(User::getId).orElse(null);
    }

    private List<Map<String, Object>> items(Map<String, Object> body) {
        Object raw = body == null ? null : body.get("items");
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object entry : list) {
            if (entry instanceof Map<?, ?> map) {
                Map<String, Object> cast = new LinkedHashMap<>();
                map.forEach((key, value) -> cast.put(String.valueOf(key), value));
                out.add(cast);
            }
        }
        return out;
    }

    private BigDecimal decimal(Object value) {
        if (value instanceof Number number) {
            return new BigDecimal(number.toString());
        }
        if (value instanceof String text && !text.isBlank()) {
            try {
                return new BigDecimal(text.trim());
            } catch (NumberFormatException ignored) {
                return BigDecimal.ZERO;
            }
        }
        return BigDecimal.ZERO;
    }

    private long entero(Object value, long porDefecto) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text && !text.isBlank()) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException ignored) {
                return porDefecto;
            }
        }
        return porDefecto;
    }

    private String texto(Map<String, Object> body, String campo) {
        Object value = body == null ? null : body.get(campo);
        return value == null ? "" : String.valueOf(value).trim();
    }

    private ResponseEntity<?> json(HttpStatus status, Map<String, Object> payload) {
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).body(payload);
    }
}