package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * Resultado de una herramienta: lo que se devuelve al modelo como {@code functionResponse}
 * y los eventos de interfaz que el backend emite al widget.
 */
public record ToolResult(JsonNode payload, List<UiEvent> uiEvents) {

    public static ToolResult of(JsonNode payload) {
        return new ToolResult(payload, List.of());
    }

    public static ToolResult of(JsonNode payload, List<UiEvent> uiEvents) {
        return new ToolResult(payload, uiEvents == null ? List.of() : uiEvents);
    }
}
