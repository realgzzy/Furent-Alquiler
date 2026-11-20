package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Implementación de {@link AssistantStream} sobre {@link SseEmitter}.
 *
 * Si el cliente se desconecta, {@link #isOpen()} pasa a falso y el orquestador detiene el
 * envío de eventos.
 */
public class SseAssistantStream implements AssistantStream {

    private static final Logger log = LoggerFactory.getLogger(SseAssistantStream.class);

    private final SseEmitter emitter;
    private final ObjectMapper mapper;
    private volatile boolean open = true;

    public SseAssistantStream(SseEmitter emitter, ObjectMapper mapper) {
        this.emitter = emitter;
        this.mapper = mapper;
        emitter.onCompletion(() -> open = false);
        emitter.onTimeout(() -> open = false);
        emitter.onError(error -> open = false);
    }

    @Override
    public void event(String type, JsonNode data) {
        if (!open) {
            return;
        }
        try {
            emitter.send(SseEmitter.event()
                    .name(type)
                    .data(data == null ? "{}" : data.toString(), MediaType.APPLICATION_JSON));
        } catch (Exception e) {
            open = false;
            log.debug("Stream SSE cerrado por el cliente: {}", e.getMessage());
        }
    }

    @Override
    public void token(String text) {
        if (text == null || text.isEmpty()) {
            return;
        }
        ObjectNode data = mapper.createObjectNode();
        data.put("text", text);
        event("token", data);
    }

    @Override
    public void complete() {
        if (!open) {
            return;
        }
        open = false;
        try {
            emitter.complete();
        } catch (Exception e) {
            log.debug("No se pudo completar el SSE: {}", e.getMessage());
        }
    }

    @Override
    public boolean isOpen() {
        return open;
    }
}
