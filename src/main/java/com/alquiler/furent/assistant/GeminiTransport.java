package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.function.Consumer;

/**
 * Transporte hacia Gemini. Se abstrae para poder probar el orquestador sin red.
 *
 * Los errores HTTP se traducen a {@link AssistantException} con el código correspondiente.
 */
public interface GeminiTransport {

    /**
     * Ejecuta la petición en modo streaming y entrega cada línea cruda recibida.
     *
     * @param body       cuerpo JSON ya construido
     * @param onRawChunk consumidor de fragmentos crudos (pueden partir una línea)
     */
    void stream(JsonNode body, Consumer<String> onRawChunk);
}
