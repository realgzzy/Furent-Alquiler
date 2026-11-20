package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.function.Consumer;

/**
 * Cliente de Gemini. Construye un parser nuevo por llamada (no es thread-safe) y
 * reporta métricas de uso y tokens.
 */
@Component
public class GeminiClient {

    private final GeminiTransport transport;
    private final ObjectMapper mapper;
    private final AssistantMetrics metrics;

    public GeminiClient(GeminiTransport transport, ObjectMapper mapper, AssistantMetrics metrics) {
        this.transport = transport;
        this.mapper = mapper;
        this.metrics = metrics;
    }

    /**
     * Ejecuta una petición en streaming y entrega los fragmentos normalizados.
     *
     * @param body    cuerpo JSON de la petición
     * @param onChunk consumidor de fragmentos
     */
    public void stream(JsonNode body, Consumer<GeminiChunk> onChunk) {
        GeminiSseParser parser = new GeminiSseParser(mapper);
        try {
            transport.stream(body, raw -> emit(parser.accept(raw), onChunk));
            emit(parser.finish(), onChunk);
        } catch (AssistantException e) {
            metrics.error(e.getCode().name());
            throw e;
        }
    }

    private void emit(java.util.List<GeminiChunk> chunks, Consumer<GeminiChunk> onChunk) {
        for (GeminiChunk chunk : chunks) {
            if (chunk.kind() == GeminiChunk.Kind.USAGE && chunk.usage() != null) {
                metrics.tokens("input", chunk.usage().promptTokens());
                metrics.tokens("output", chunk.usage().outputTokens());
            }
            if (chunk.kind() == GeminiChunk.Kind.BLOCKED) {
                metrics.error(AssistantException.Code.BLOCKED.name());
            }
            onChunk.accept(chunk);
        }
    }
}
