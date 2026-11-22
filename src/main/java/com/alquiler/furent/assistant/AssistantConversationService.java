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
                normalizeTimeline(conversation);
                markExpiredIfNeeded(conversation);
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
        normalizeTimeline(conversation);
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
     * Si el chat ya superó su vigencia, lo marca como cerrado antes de devolverlo.
     */
    public Optional<AssistantConversation> find(String conversationId) {
        if (conversationId == null || conversationId.isBlank()) {
            return Optional.empty();
        }
        Optional<AssistantConversation> found = conversationRepository.findById(conversationId);
        found.ifPresent(this::markExpiredIfNeeded);
        return found;
    }

    public List<AssistantMessage> history(String conversationId) {
        return messageRepository.findByConversationIdOrderByCreatedAtAsc(conversationId);
    }

    public List<AssistantMessage> messages(String conversationId) {
        return history(conversationId);
    }

    /**
     * Conversaciones recientes del usuario (autenticado) o de la sesión (invitado),
     * ordenadas por último mensaje.
     */
    public List<AssistantConversation> list(ToolContext context, int limit) {
        int tope = Math.max(1, Math.min(limit, 50));
        List<AssistantConversation> encontradas = context.authenticated()
                ? conversationRepository.findByUserIdOrderByUltimoMensajeDesc(context.userId())
                : conversationRepository.findBySessionIdOrderByUltimoMensajeDesc(context.sessionId());
        encontradas.forEach(this::markExpiredIfNeeded);
        return encontradas.stream().limit(tope).toList();
    }

    /** Borra la conversación y todos sus mensajes. */
    public void delete(AssistantConversation conversation) {
        if (conversation == null || conversation.getId() == null) {
            return;
        }
        messageRepository.deleteByConversationId(conversation.getId());
        conversationRepository.delete(conversation);
    }

    public void saveUserMessage(AssistantConversation conversation, String contenido) {
        if (conversation.getTitulo() == null || conversation.getTitulo().isBlank()) {
            conversation.setTitulo(tituloDe(contenido));
            conversationRepository.save(conversation);
        }
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

    /**
     * Añade una línea a la memoria de la conversación, recortando por el final para no crecer
     * sin límite. La memoria es un canal interno (no se muestra al usuario) para resolver
     * referencias como "agrégalas" o "esa cotización".
     */
    public void appendMemory(AssistantConversation conversation, String linea) {
        if (conversation == null || linea == null || linea.isBlank()) {
            return;
        }
        String actual = conversation.getMemoria();
        String nuevo = (actual == null || actual.isBlank()) ? linea : actual + "\n" + linea;
        int tope = Math.max(400, Math.min(properties.getHistoryWindow() * 200, 2000));
        if (nuevo.length() > tope) {
            nuevo = nuevo.substring(nuevo.length() - tope);
            int corte = nuevo.indexOf('\n');
            if (corte > 0 && corte < 120) {
                nuevo = nuevo.substring(corte + 1);
            }
        }
        conversation.setMemoria(nuevo);
        conversationRepository.save(conversation);
    }

    public void registerQuote(AssistantConversation conversation, BigDecimal total) {
        conversation.setCotizo(true);
        if (total != null) {
            conversation.setTotalCotizado(total);
        }
        conversationRepository.save(conversation);
    }

    /**
     * Cierra la conversación para que deje de admitir escritura. {@code motivo} queda guardado
     * (ADMIN, EXPIRADO o USUARIO) para que el usuario sepa por qué se cerró.
     */
    public void close(AssistantConversation conversation, String motivo) {
        if (conversation == null) {
            return;
        }
        conversation.setEstado(AssistantConversation.ESTADO_CERRADA);
        conversation.setMotivoCierre(motivo);
        if (conversation.getExpireAt() == null || conversation.getExpireAt().isBefore(purgeAtNow())) {
            conversation.setExpireAt(purgeAtNow());
        }
        conversationRepository.save(conversation);
    }

    /**
     * Marca como cerrada una conversación que ya superó su vigencia (o que lo está por hacer),
     * siempre que no se haya cerrado antes por otro motivo. Así el chat sigue visible en el
     * historial con su aviso en vez de desaparecer sin explicación.
     */
    public void markExpiredIfNeeded(AssistantConversation conversation) {
        if (conversation == null || AssistantConversation.ESTADO_CERRADA.equals(conversation.getEstado())) {
            return;
        }
        Instant limite = closedAt(conversation);
        if (limite == null || Instant.now().isBefore(limite)) {
            return;
        }
        conversation.setEstado(AssistantConversation.ESTADO_CERRADA);
        if (conversation.getMotivoCierre() == null) {
            conversation.setMotivoCierre(AssistantConversation.MOTIVO_CIERRE_EXPIRADO);
        }
        if (conversation.getExpireAt() == null || conversation.getExpireAt().isBefore(purgeAtNow())) {
            conversation.setExpireAt(purgeAtNow());
        }
        conversationRepository.save(conversation);
    }

    /** ¿El chat ya no admite escritura (cerrado explícitamente o por vigencia cumplida)? */
    public boolean isClosed(AssistantConversation conversation) {
        if (conversation == null) {
            return false;
        }
        if (AssistantConversation.ESTADO_CERRADA.equals(conversation.getEstado())) {
            return true;
        }
        Instant limite = closedAt(conversation);
        return limite != null && !Instant.now().isBefore(limite);
    }

    /**
     * Asegura los hitos temporales de una conversación: cuándo cierra ({@code cierraEn}) y
     * cuándo se borra ({@code expireAt}). Cubre conversaciones creadas antes de este cambio.
     */
    private void normalizeTimeline(AssistantConversation conversation) {
        Instant inicio = conversation.getInicio() != null ? conversation.getInicio() : Instant.now();
        if (conversation.getCierraEn() == null) {
            conversation.setCierraEn(inicio.plus(properties.getSessionHours(), ChronoUnit.HOURS));
        }
        if (conversation.getExpireAt() == null) {
            conversation.setExpireAt(purgeAfter(conversation.getCierraEn()));
        }
    }

    /** Momento en que el chat deja de admitir escritura. */
    private Instant closedAt(AssistantConversation conversation) {
        return conversation.getCierraEn() != null ? conversation.getCierraEn() : conversation.getExpireAt();
    }

    /** Borrado del chat: un tiempo de gracia por detrás del cierre. */
    private Instant purgeAfter(Instant cierre) {
        return cierre.plus(Math.max(1, properties.getClosedRetentionHours()), ChronoUnit.HOURS);
    }

    private Instant purgeAtNow() {
        return Instant.now().plus(Math.max(1, properties.getClosedRetentionHours()), ChronoUnit.HOURS);
    }

    /** Título legible para el historial a partir del primer mensaje del usuario. */
    private String tituloDe(String contenido) {
        if (contenido == null) {
            return "Nuevo chat";
        }
        String limpio = contenido.replaceAll("\\s+", " ").trim();
        if (limpio.isEmpty()) {
            return "Nuevo chat";
        }
        return limpio.length() > 60 ? limpio.substring(0, 60).trim() + "…" : limpio;
    }

    private void persist(AssistantConversation conversation, String rol, String contenido,
                         String herramienta, String argumentosResumen, int tokens, String modelo) {
        AssistantMessage message = new AssistantMessage(conversation.getId(), rol, contenido);
        message.setHerramienta(herramienta);
        message.setArgumentosResumen(argumentosResumen);
        message.setTokens(tokens);
        message.setModelo(modelo);
        message.setExpireAt(conversation.getExpireAt() != null ? conversation.getExpireAt() : purgeAtNow());
        messageRepository.save(message);

        conversation.setUltimoMensaje(Instant.now());
        conversation.setTotalMensajes(conversation.getTotalMensajes() + 1);
        conversationRepository.save(conversation);
        log.debug("Mensaje {} guardado en la conversación {}", rol, conversation.getId());
    }
}
