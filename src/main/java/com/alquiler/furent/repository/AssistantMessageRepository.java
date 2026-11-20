package com.alquiler.furent.repository;

import com.alquiler.furent.model.AssistantMessage;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface AssistantMessageRepository extends MongoRepository<AssistantMessage, String> {

    List<AssistantMessage> findByConversationIdOrderByCreatedAtAsc(String conversationId);

    List<AssistantMessage> findByConversationIdAndRolOrderByCreatedAtAsc(String conversationId, String rol);

    long countByConversationId(String conversationId);

    void deleteByConversationId(String conversationId);
}
