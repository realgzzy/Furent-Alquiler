package com.alquiler.furent.assistant;

import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.AssistantMessage;
import com.alquiler.furent.repository.AssistantConversationRepository;
import com.alquiler.furent.repository.AssistantMessageRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Consultas de solo lectura para el panel de administración del asistente.
 *
 * El filtrado combinado (estado + cotización + rango de fechas + búsqueda) se resuelve
 * con {@link MongoTemplate} para no multiplicar métodos derivados en el repositorio.
 */
@Service
public class AssistantAdminService {

    /** Tope de filas al exportar a CSV para no agotar memoria. */
    private static final int EXPORT_LIMIT = 5000;

    private final MongoTemplate mongoTemplate;
    private final AssistantConversationRepository conversationRepository;
    private final AssistantMessageRepository messageRepository;

    public AssistantAdminService(MongoTemplate mongoTemplate,
                                 AssistantConversationRepository conversationRepository,
                                 AssistantMessageRepository messageRepository) {
        this.mongoTemplate = mongoTemplate;
        this.conversationRepository = conversationRepository;
        this.messageRepository = messageRepository;
    }

    public Page<AssistantConversation> search(String estado, Boolean cotizo, Instant desde, Instant hasta,
                                              String q, int page, int size) {
        Query query = buildQuery(estado, cotizo, desde, hasta, q);
        long total = mongoTemplate.count(query, AssistantConversation.class);
        PageRequest pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "ultimoMensaje"));
        query.with(pageable);
        List<AssistantConversation> content = mongoTemplate.find(query, AssistantConversation.class);
        return new PageImpl<>(content, pageable, total);
    }

    public List<AssistantConversation> listForExport(String estado, Boolean cotizo, Instant desde, Instant hasta, String q) {
        Query query = buildQuery(estado, cotizo, desde, hasta, q);
        query.with(Sort.by(Sort.Direction.DESC, "ultimoMensaje"));
        query.limit(EXPORT_LIMIT);
        return mongoTemplate.find(query, AssistantConversation.class);
    }

    public List<AssistantMessage> messages(String conversationId) {
        return messageRepository.findByConversationIdOrderByCreatedAtAsc(conversationId);
    }

    /** Número de conversaciones que coinciden con los filtros indicados (sin paginar). */
    public long count(String estado, Boolean cotizo, Instant desde, Instant hasta, String q) {
        return mongoTemplate.count(buildQuery(estado, cotizo, desde, hasta, q), AssistantConversation.class);
    }

    /**
     * Elimina en bloque las conversaciones que coinciden con los filtros indicados y todos sus
     * mensajes. Si no hay ningún filtro, vacía por completo el historial.
     *
     * @return cuántas conversaciones se eliminaron.
     */
    public long deleteMatching(String estado, Boolean cotizo, Instant desde, Instant hasta, String q) {
        Query query = buildQuery(estado, cotizo, desde, hasta, q);

        if (query.getQueryObject().isEmpty()) {
            // Limpieza total: se vacían las dos colecciones sin recolectar identificadores.
            mongoTemplate.remove(new Query(), AssistantMessage.class);
            return mongoTemplate.remove(query, AssistantConversation.class).getDeletedCount();
        }

        List<String> ids = mongoTemplate.findDistinct(query, "_id", AssistantConversation.class, String.class);
        if (ids.isEmpty()) {
            return 0L;
        }
        mongoTemplate.remove(Query.query(Criteria.where("conversationId").in(ids)), AssistantMessage.class);
        return mongoTemplate.remove(query, AssistantConversation.class).getDeletedCount();
    }

    public Stats stats() {
        ZoneId zone = ZoneId.systemDefault();
        Instant startOfDay = LocalDate.now(zone).atStartOfDay(zone).toInstant();
        Instant now = Instant.now();
        BigDecimal totalCotizado = conversationRepository.findByCotizoTrue().stream()
                .map(AssistantConversation::getTotalCotizado)
                .filter(java.util.Objects::nonNull)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return new Stats(
                conversationRepository.count(),
                conversationRepository.countByEstado(AssistantConversation.ESTADO_ACTIVA),
                conversationRepository.countByEstado(AssistantConversation.ESTADO_ESCALADA),
                conversationRepository.countByEstado(AssistantConversation.ESTADO_CERRADA),
                conversationRepository.countByCotizoTrue(),
                conversationRepository.countByInicioBetween(startOfDay, now),
                totalCotizado);
    }

    private Query buildQuery(String estado, Boolean cotizo, Instant desde, Instant hasta, String q) {
        Query query = new Query();
        if (estado != null && !estado.isBlank() && !"ALL".equalsIgnoreCase(estado)) {
            query.addCriteria(Criteria.where("estado").is(estado.toUpperCase()));
        }
        if (cotizo != null) {
            query.addCriteria(Criteria.where("cotizo").is(cotizo));
        }
        if (desde != null || hasta != null) {
            Criteria rango = Criteria.where("ultimoMensaje");
            if (desde != null) {
                rango = rango.gte(desde);
            }
            if (hasta != null) {
                rango = rango.lte(hasta);
            }
            query.addCriteria(rango);
        }
        if (q != null && !q.isBlank()) {
            String texto = q.trim();
            String regex = Pattern.quote(texto);
            query.addCriteria(new Criteria().orOperator(
                    Criteria.where("pageContext").regex(regex, "i"),
                    Criteria.where("motivoEscalado").regex(regex, "i"),
                    Criteria.where("_id").is(texto),
                    Criteria.where("userId").is(texto)));
        }
        return query;
    }

    /**
     * Conteos del encabezado del panel.
     */
    public record Stats(long total, long activas, long escaladas, long cerradas,
                        long cotizadas, long hoy, BigDecimal totalCotizado) {
    }
}
