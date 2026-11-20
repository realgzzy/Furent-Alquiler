package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Salida de eventos del asistente. Se abstrae para poder probar el orquestador sin SSE.
 */
public interface AssistantStream {

    void event(String type, JsonNode data);

    void token(String text);

    void complete();

    boolean isOpen();
}
