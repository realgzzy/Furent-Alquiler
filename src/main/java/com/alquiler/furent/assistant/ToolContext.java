package com.alquiler.furent.assistant;

import java.util.List;

/**
 * Contexto de ejecución de una herramienta.
 *
 * @param userId    id del usuario autenticado, o {@code null} para invitados
 * @param sessionId identificador de sesión del navegador (generado en el servidor)
 * @param bag       artículos que el usuario tiene en su bolsa (puede venir vacío)
 */
public record ToolContext(String userId, String sessionId, List<BagItem> bag) {

    public ToolContext(String userId, String sessionId) {
        this(userId, sessionId, List.of());
    }

    public boolean authenticated() {
        return userId != null && !userId.isBlank();
    }
}
