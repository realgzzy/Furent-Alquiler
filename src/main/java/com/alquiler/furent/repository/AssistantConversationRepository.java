package com.alquiler.furent.repository;

import com.alquiler.furent.model.AssistantConversation;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.time.Instant;
import java.util.List;

public interface AssistantConversationRepository extends MongoRepository<AssistantConversation, String> {

    List<AssistantConversation> findBySessionIdOrderByUltimoMensajeDesc(String sessionId);

    List<AssistantConversation> findByUserIdOrderByUltimoMensajeDesc(String userId);

    List<AssistantConversation> findByEstadoOrderByUltimoMensajeDesc(String estado);

    Page<AssistantConversation> findAllByOrderByUltimoMensajeDesc(Pageable pageable);

    Page<AssistantConversation> findByEstado(String estado, Pageable pageable);

    Page<AssistantConversation> findByUltimoMensajeBetweenOrderByUltimoMensajeDesc(
            Instant desde, Instant hasta, Pageable pageable);

    List<AssistantConversation> findByUltimoMensajeBetween(Instant desde, Instant hasta);

    long countByEstado(String estado);

    long countByCotizoTrue();

    long countByInicioBetween(Instant desde, Instant hasta);

    long countByEstadoAndInicioBetween(String estado, Instant desde, Instant hasta);
}
