package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class GeminiClientTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final AssistantMetrics metrics = new AssistantMetrics(new SimpleMeterRegistry());

    @Test
    void forwardsParsedChunks() {
        GeminiTransport transport = (body, onChunk) -> {
            onChunk.accept("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hola\"}]}}]}\n");
            onChunk.accept("data: [DONE]\n");
        };
        GeminiClient client = new GeminiClient(transport, mapper, metrics);

        List<GeminiChunk> received = new ArrayList<>();
        client.stream(mapper.createObjectNode(), received::add);

        assertEquals(1, received.size());
        assertEquals("Hola", received.get(0).text());
    }

    @Test
    void propagatesTransportExceptionWithCode() {
        GeminiTransport transport = (body, onChunk) -> {
            throw new AssistantException(AssistantException.Code.QUOTA_EXCEEDED, "sin cuota");
        };
        GeminiClient client = new GeminiClient(transport, mapper, metrics);

        AssistantException ex = assertThrows(AssistantException.class,
                () -> client.stream(mapper.createObjectNode(), chunk -> {
                }));

        assertEquals(AssistantException.Code.QUOTA_EXCEEDED, ex.getCode());
    }

    @Test
    void registersTokenMetrics() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        AssistantMetrics counted = new AssistantMetrics(registry);
        GeminiTransport transport = (body, onChunk) ->
                onChunk.accept("data: {\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5}}\n");
        GeminiClient client = new GeminiClient(transport, mapper, counted);

        client.stream(mapper.createObjectNode(), chunk -> {
        });

        assertEquals(10.0, registry.get("furent.assistant.tokens").tag("type", "input").counter().count());
        assertEquals(5.0, registry.get("furent.assistant.tokens").tag("type", "output").counter().count());
    }
}
