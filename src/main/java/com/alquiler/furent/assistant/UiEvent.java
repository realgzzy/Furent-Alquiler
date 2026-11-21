package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Evento de interfaz que el backend emite directamente al widget, sin depender del texto
 * del modelo.
 *
 * @param type uno de {@link #CARD}, {@link #QUOTE}, {@link #ESCALATION}, {@link #PANEL},
 *             {@link #BAG}, {@link #RESERVATION}
 * @param data datos ya calculados con precios y stock reales
 */
public record UiEvent(String type, JsonNode data) {

    public static final String CARD = "card";
    public static final String QUOTE = "quote";
    public static final String ESCALATION = "escalation";
    /** Abre el panel lateral izquierdo con una vista concreta (formulario, fechas, bolsa, alquiler). */
    public static final String PANEL = "panel";
    /** Instrucción para mutar la bolsa local del navegador. */
    public static final String BAG = "bag";
    /** Resumen de una reserva con su línea de tiempo y pagos (panel de seguimiento). */
    public static final String RESERVATION = "reservation";
}
