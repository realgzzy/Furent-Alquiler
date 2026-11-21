package com.alquiler.furent.assistant;

import java.util.List;

/**
 * Contexto de ejecución de una herramienta.
 *
 * @param userId    id del usuario autenticado, o {@code null} para invitados
 * @param sessionId identificador de sesión del navegador (generado en el servidor)
 * @param bag       artículos que el usuario tiene en su bolsa (puede venir vacío)
 * @param memoria   memoria de la conversación (productos mostrados, cotizaciones) para resolver
 *                  referencias como "agrégalas"; puede ser {@code null}
 */
public record ToolContext(String userId, String sessionId, List<BagItem> bag, String memoria) {

    public ToolContext(String userId, String sessionId) {
        this(userId, sessionId, List.of(), null);
    }

    public ToolContext(String userId, String sessionId, List<BagItem> bag) {
        this(userId, sessionId, bag, null);
    }

    /** Copia este contexto con la memoria indicada. */
    public ToolContext withMemory(String memoria) {
        return new ToolContext(userId, sessionId, bag, memoria);
    }

    public boolean authenticated() {
        return userId != null && !userId.isBlank();
    }
}
