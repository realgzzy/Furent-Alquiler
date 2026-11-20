package com.alquiler.furent.assistant;

/**
 * Contexto de ejecución de una herramienta.
 *
 * @param userId    id del usuario autenticado, o {@code null} para invitados
 * @param sessionId identificador de sesión del navegador (generado en el servidor)
 */
public record ToolContext(String userId, String sessionId) {

    public boolean authenticated() {
        return userId != null && !userId.isBlank();
    }
}
