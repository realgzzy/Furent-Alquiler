package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.config.TenantContext;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.AssistantMessage;
import com.alquiler.furent.repository.AssistantConversationRepository;
import com.alquiler.furent.repository.AssistantMessageRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;

/**
 * Persistencia y propiedad de las conversaciones del asistente.
 */
@Service
public class AssistantConversationService {

    private static final Logger log = LoggerFactory.getLogger(AssistantConversationService.class);

    private final AssistantConversationRepository conversationRepository;
    private final AssistantMessageRepository messageRepository;
    private final AssistantProperties properties;

    public AssistantConversationService(AssistantConversationRepository conversationRepository,
                                        AssistantMessageRepository messageRepository,
                                        AssistantProperties properties) {
        this.conversationRepository = conversationRepository;
        this.messageRepository = messageRepository;
        this.properties = properties;
    }

    /**
     * Devuelve la conversación indicada si pertenece al usuario o a la sesión; si no,
     * crea una nueva.
     */
    public AssistantConversation resolve(String conversationId, ToolContext context, String pageContext) {
        if (conversationId != null && !conversationId.isBlank()) {
            Optional<AssistantConversation> existing = conversationRepository.findById(conversationId);
            if (existing.isPresent() && owns(existing.get(), context)) {
                AssistantConversation conversation = existing.get();
                if (context.authenticated() && conversation.getUserId() == null) {
                    conversation.setUserId(context.userId());
                }
                if (conversation.getExpireAt() == null) {
                    conversation.setExpireAt(expireAt());
                }
                if (pageContext != null && !pageContext.isBlank()) {
                    conversation.setPageContext(pageContext);
                }
                return conversationRepository.save(conversation);
            }
        }
        AssistantConversation conversation = new AssistantConversation();
        conversation.setSessionId(context.sessionId());
        conversation.setUserId(context.authenticated() ? context.userId() : null);
        conversation.setPageContext(pageContext);
        conversation.setTenantId(TenantContext.getCurrentTenant());
        conversation.setExpireAt(expireAt());
        return conversationRepository.save(conversation);
    }

    public boolean owns(AssistantConversation conversation, ToolContext context) {
        if (conversation == null) {
            return false;
        }
        if (conversation.getUserId() != null) {
            return conversation.getUserId().equals(context.userId());
        }
        return conversation.getSessionId() != null
                && conversation.getSessionId().equals(context.sessionId());
    }

    /**
     * Busca una conversación por id. No valida propiedad; quien la use debe comprobarla.
     */
    public Optional<AssistantConversation> find(String conversationId) {
        if (conversationId == null || conversationId.isBlank()) {
            return Optional.empty();
        }
        return conversationRepository.findById(conversationId);
    }

    public List<AssistantMessage> history(String conversationId) {
        return messageRepository.findByConversationIdOrderByCreatedAtAsc(conversationId);
    }

    public List<AssistantMessage> messages(String conversationId) {
        return history(conversationId);
    }

    public void saveUserMessage(AssistantConversation conversation, String contenido) {
        persist(conversation, AssistantMessage.ROL_USER, contenido, null, null, 0, null);
    }

    public void saveAssistantMessage(AssistantConversation conversation, String contenido, String model) {
        persist(conversation, AssistantMessage.ROL_ASSISTANT, contenido, null, null, 0, model);
    }

    public void saveToolMessage(AssistantConversation conversation, String herramienta, String resumen) {
        persist(conversation, AssistantMessage.ROL_TOOL, null, herramienta, resumen, 0, null);
    }

    public void addTokens(AssistantConversation conversation, int promptTokens, int outputTokens) {
        conversation.setTokensEntrada(conversation.getTokensEntrada() + Math.max(0, promptTokens));
        conversation.setTokensSalida(conversation.getTokensSalida() + Math.max(0, outputTokens));
        conversationRepository.save(conversation);
    }

    public void markEscalated(AssistantConversation conversation, String motivo) {
        conversation.setEstado(AssistantConversation.ESTADO_ESCALADA);
        conversation.setMotivoEscalado(motivo);
        conversationRepository.save(conversation);
    }

    public void registerQuote(AssistantConversation conversation, BigDecimal total) {
        conversation.setCotizo(true);
        if (total != null) {
            conversation.setTotalCotizado(total);
        }
        conversationRepository.save(conversation);
    }

    public void close(AssistantConversation conversation) {
        conversation.setEstado(AssistantConversation.ESTADO_CERRADA);
        conversation.setExpireAt(expireAt());
        conversationRepository.save(conversation);
    }

    /** Momento en que el chat (y sus mensajes) dejan de conservarse. */
    private Instant expireAt() {
        return Instant.now().plus(properties.getSessionHours(), ChronoUnit.HOURS);
    }

    private void persist(AssistantConversation conversation, String rol, String contenido,
                         String herramienta, String argumentosResumen, int tokens, String modelo) {
        AssistantMessage message = new AssistantMessage(conversation.getId(), rol, contenido);
        message.setHerramienta(herramienta);
        message.setArgumentosResumen(argumentosResumen);
        message.setTokens(tokens);
        message.setModelo(modelo);
        message.setExpireAt(conversation.getExpireAt() != null ? conversation.getExpireAt() : expireAt());
        messageRepository.save(message);

        conversation.setUltimoMensaje(Instant.now());
        conversation.setTotalMensajes(conversation.getTotalMensajes() + 1);
        conversationRepository.save(conversation);
        log.debug("Mensaje {} guardado en la conversación {}", rol, conversation.getId());
    }
}
