package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Evento de interfaz que el backend emite directamente al widget, sin depender del texto
 * del modelo.
 *
 * @param type uno de {@link #CARD}, {@link #QUOTE}, {@link #ESCALATION}
 * @param data datos ya calculados con precios y stock reales
 */
public record UiEvent(String type, JsonNode data) {

    public static final String CARD = "card";
    public static final String QUOTE = "quote";
    public static final String ESCALATION = "escalation";
}
