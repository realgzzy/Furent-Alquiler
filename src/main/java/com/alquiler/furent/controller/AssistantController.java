package com.alquiler.furent.controller;

import com.alquiler.furent.assistant.AssistantConversationService;
import com.alquiler.furent.assistant.AssistantOrchestrator;
import com.alquiler.furent.assistant.SseAssistantStream;
import com.alquiler.furent.assistant.ToolContext;
import com.alquiler.furent.assistant.dto.AssistantChatRequest;
import com.alquiler.furent.config.AssistantExecutorConfig;
import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.config.FeatureFlags;
import com.alquiler.furent.config.TenantContext;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.AssistantMessage;
import com.alquiler.furent.model.User;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.task.TaskExecutor;
import org.springframework.core.task.TaskRejectedException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Endpoint del asistente virtual.
 *
 * El chat responde por Server-Sent Events. La propiedad de una conversación se valida contra
 * el usuario autenticado o el {@code sessionId} guardado en la {@link HttpSession}; el
 * identificador que el navegador guarde por su cuenta no autoriza el acceso.
 */
@RestController
@RequestMapping("/api/asistente")
public class AssistantController {

    private static final Logger log = LoggerFactory.getLogger(AssistantController.class);

    /** Atributo de sesión que liga el navegador anónimo a sus conversaciones. */
    public static final String SESSION_ATTR = "furent.assistant.sessionId";

    private static final int MAX_MESSAGE_LENGTH = 1000;
    private static final int MAX_PAGE_CONTEXT_LENGTH = 200;

    private final AssistantProperties properties;
    private final FeatureFlags featureFlags;
    private final AssistantOrchestrator orchestrator;
    private final AssistantConversationService conversations;
    private final UserService userService;
    private final ObjectMapper mapper;
    private final TaskExecutor assistantExecutor;

    public AssistantController(AssistantProperties properties,
                               FeatureFlags featureFlags,
                               AssistantOrchestrator orchestrator,
                               AssistantConversationService conversations,
                               UserService userService,
                               ObjectMapper mapper,
                               @Qualifier(AssistantExecutorConfig.BEAN_NAME) TaskExecutor assistantExecutor) {
        this.properties = properties;
        this.featureFlags = featureFlags;
        this.orchestrator = orchestrator;
        this.conversations = conversations;
        this.userService = userService;
        this.mapper = mapper;
        this.assistantExecutor = assistantExecutor;
    }

    /**
     * Abre un stream SSE con la respuesta del asistente.
     */
    @PostMapping("/chat")
    public ResponseEntity<?> chat(@RequestBody(required = false) AssistantChatRequest request,
                                  HttpServletRequest httpRequest,
                                  Authentication authentication) {
        if (!featureFlags.isAssistantEnabled() || !properties.isConfigured()) {
            return error(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE",
                    "El asistente no está disponible en este momento.");
        }

        String invalid = validate(request);
        if (invalid != null) {
            return error(HttpStatus.BAD_REQUEST, "INVALID_INPUT", invalid);
        }

        ToolContext context = resolveContext(authentication, httpRequest);
        String tenantId = TenantContext.getCurrentTenant();

        SseEmitter emitter = new SseEmitter(properties.getEmitterTimeoutMillis());
        SseAssistantStream stream = new SseAssistantStream(emitter, mapper);
        try {
            assistantExecutor.execute(() -> {
                try {
                    if (tenantId != null) {
                        TenantContext.setCurrentTenant(tenantId);
                    }
                    orchestrator.handle(request, context, stream);
                } finally {
                    TenantContext.clear();
                }
            });
        } catch (TaskRejectedException e) {
            log.warn("Pool del asistente saturado, se rechaza la solicitud");
            emitter.completeWithError(e);
            return error(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED",
                    "El asistente está ocupado. Intenta de nuevo en unos segundos.");
        }
        return ResponseEntity.ok(emitter);
    }

    /**
     * Devuelve una conversación y sus mensajes si pertenece a la sesión o al usuario.
     */
    @GetMapping("/conversations/{id}")
    public ResponseEntity<?> conversation(@PathVariable String id,
                                          HttpServletRequest httpRequest,
                                          Authentication authentication) {
        if (!featureFlags.isAssistantEnabled()) {
            return error(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE",
                    "El asistente no está disponible en este momento.");
        }
        ToolContext context = resolveContext(authentication, httpRequest);
        Optional<AssistantConversation> found = conversations.find(id);
        if (found.isEmpty() || !conversations.owns(found.get(), context)) {
            return error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No encontré esa conversación.");
        }
        return ResponseEntity.ok(conversationPayload(found.get()));
    }

    /**
     * Marca la conversación como cerrada si pertenece a la sesión o al usuario.
     */
    @PostMapping("/conversations/{id}/close")
    public ResponseEntity<?> close(@PathVariable String id,
                                   HttpServletRequest httpRequest,
                                   Authentication authentication) {
        if (!featureFlags.isAssistantEnabled()) {
            return error(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE",
                    "El asistente no está disponible en este momento.");
        }
        ToolContext context = resolveContext(authentication, httpRequest);
        Optional<AssistantConversation> found = conversations.find(id);
        if (found.isEmpty() || !conversations.owns(found.get(), context)) {
            return error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No encontré esa conversación.");
        }
        conversations.close(found.get());
        Map<String, Object> payload = new java.util.LinkedHashMap<>();
        payload.put("conversationId", found.get().getId());
        payload.put("estado", found.get().getEstado());
        return ResponseEntity.ok(payload);
    }

    // ───────────────────────── Helpers ─────────────────────────

    private String validate(AssistantChatRequest request) {
        if (request == null || request.getMessage() == null || request.getMessage().isBlank()) {
            return "El mensaje no puede estar vacío.";
        }
        if (request.getMessage().length() > MAX_MESSAGE_LENGTH) {
            return "El mensaje no puede superar " + MAX_MESSAGE_LENGTH + " caracteres.";
        }
        String pageContext = request.getPageContext();
        if (pageContext != null && pageContext.length() > MAX_PAGE_CONTEXT_LENGTH) {
            return "El contexto de página es demasiado largo.";
        }
        return null;
    }

    private ToolContext resolveContext(Authentication authentication, HttpServletRequest request) {
        String userId = resolveUserId(authentication);
        HttpSession session = request.getSession(true);
        Object existing = session.getAttribute(SESSION_ATTR);
        String sessionId;
        if (existing instanceof String value && !value.isBlank()) {
            sessionId = value;
        } else {
            sessionId = UUID.randomUUID().toString();
            session.setAttribute(SESSION_ATTR, sessionId);
        }
        return new ToolContext(userId, sessionId);
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

    private Map<String, Object> conversationPayload(AssistantConversation conversation) {
        Map<String, Object> payload = new java.util.LinkedHashMap<>();
        payload.put("conversationId", conversation.getId());
        payload.put("estado", conversation.getEstado());
        payload.put("pageContext", conversation.getPageContext());
        payload.put("cotizo", conversation.isCotizo());
        if (conversation.getTotalCotizado() != null) {
            payload.put("totalCotizado", conversation.getTotalCotizado());
        }
        payload.put("creada", conversation.getInicio() == null ? null : conversation.getInicio().toString());
        payload.put("ultimoMensaje", conversation.getUltimoMensaje() == null
                ? null : conversation.getUltimoMensaje().toString());
        payload.put("totalMensajes", conversation.getTotalMensajes());

        List<Map<String, Object>> messages = new java.util.ArrayList<>();
        for (AssistantMessage message : conversations.messages(conversation.getId())) {
            Map<String, Object> node = new java.util.LinkedHashMap<>();
            node.put("rol", message.getRol());
            if (message.getContenido() != null) {
                node.put("contenido", message.getContenido());
            }
            if (message.getHerramienta() != null) {
                node.put("herramienta", message.getHerramienta());
            }
            node.put("createdAt", message.getCreatedAt() == null ? null : message.getCreatedAt().toString());
            messages.add(node);
        }
        payload.put("messages", messages);
        return payload;
    }

    private ResponseEntity<String> error(HttpStatus status, String codigo, String mensaje) {
        String body;
        try {
            body = mapper.writeValueAsString(Map.of("codigo", codigo, "mensaje", mensaje));
        } catch (Exception e) {
            body = "{\"codigo\":\"" + codigo + "\",\"mensaje\":\"" + mensaje + "\"}";
        }
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body);
    }
}
