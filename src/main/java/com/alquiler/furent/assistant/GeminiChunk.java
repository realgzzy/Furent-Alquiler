package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Fragmento normalizado de la respuesta de Gemini.
 *
 * @param kind         tipo de fragmento
 * @param text         texto incremental (solo {@link Kind#TEXT})
 * @param functionName nombre de la función solicitada (solo {@link Kind#FUNCTION_CALL})
 * @param functionArgs argumentos de la función (solo {@link Kind#FUNCTION_CALL})
 * @param usage        metadatos de uso de tokens (solo {@link Kind#USAGE})
 * @param blockReason  motivo de bloqueo (solo {@link Kind#BLOCKED})
 */
public record GeminiChunk(
        Kind kind,
        String text,
        String functionName,
        JsonNode functionArgs,
        Usage usage,
        String blockReason) {

    public enum Kind {
        TEXT,
        FUNCTION_CALL,
        USAGE,
        BLOCKED
    }

    public record Usage(int promptTokens, int outputTokens) {
    }

    public static GeminiChunk text(String text) {
        return new GeminiChunk(Kind.TEXT, text, null, null, null, null);
    }

    public static GeminiChunk functionCall(String name, JsonNode args) {
        return new GeminiChunk(Kind.FUNCTION_CALL, null, name, args, null, null);
    }

    public static GeminiChunk usage(int promptTokens, int outputTokens) {
        return new GeminiChunk(Kind.USAGE, null, null, null, new Usage(promptTokens, outputTokens), null);
    }

    public static GeminiChunk blocked(String reason) {
        return new GeminiChunk(Kind.BLOCKED, null, null, null, null, reason);
    }
}
