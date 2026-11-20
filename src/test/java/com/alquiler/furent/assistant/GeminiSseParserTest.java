package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GeminiSseParserTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private List<GeminiChunk> feed(String... fragments) {
        GeminiSseParser parser = new GeminiSseParser(mapper);
        List<GeminiChunk> all = new ArrayList<>();
        for (String fragment : fragments) {
            all.addAll(parser.accept(fragment));
        }
        all.addAll(parser.finish());
        return all;
    }

    @Test
    void textChunkIsEmitted() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hola \"}],\"role\":\"model\"}}]}\n");

        assertEquals(1, chunks.size());
        assertEquals(GeminiChunk.Kind.TEXT, chunks.get(0).kind());
        assertEquals("Hola ", chunks.get(0).text());
    }

    @Test
    void functionCallIsEmitted() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"buscar_productos\",\"args\":{\"consulta\":\"sillas\"}}}]}}]}\n");

        assertEquals(1, chunks.size());
        GeminiChunk chunk = chunks.get(0);
        assertEquals(GeminiChunk.Kind.FUNCTION_CALL, chunk.kind());
        assertEquals("buscar_productos", chunk.functionName());
        assertEquals("sillas", chunk.functionArgs().path("consulta").asText());
    }

    @Test
    void functionCallKeepsThoughtSignature() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"buscar_productos\",\"args\":{}},\"thoughtSignature\":\"firma-123\"}]}}]}\n");

        assertEquals(1, chunks.size());
        assertEquals("firma-123", chunks.get(0).thoughtSignature());
    }

    @Test
    void functionCallWithoutSignatureIsNull() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"cotizar\",\"args\":{}}}]}}]}\n");

        assertEquals(1, chunks.size());
        assertEquals(null, chunks.get(0).thoughtSignature());
    }

    @Test
    void usageMetadataIsEmitted() {
        List<GeminiChunk> chunks = feed(
                "data: {\"usageMetadata\":{\"promptTokenCount\":120,\"candidatesTokenCount\":30}}\n");

        assertEquals(1, chunks.size());
        assertEquals(GeminiChunk.Kind.USAGE, chunks.get(0).kind());
        assertEquals(120, chunks.get(0).usage().promptTokens());
        assertEquals(30, chunks.get(0).usage().outputTokens());
    }

    @Test
    void jsonSplitAcrossReadsIsReassembled() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"con",
                "tent\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n");

        assertEquals(1, chunks.size());
        assertEquals("hi", chunks.get(0).text());
    }

    @Test
    void multilineEventIsJoined() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":\n",
                "data: [{\"text\":\"linea\"}]}}]}\n",
                "\n");

        assertEquals(1, chunks.size());
        assertEquals("linea", chunks.get(0).text());
    }

    @Test
    void doneMarkerIsIgnored() {
        assertTrue(feed("data: [DONE]\n").isEmpty());
    }

    @Test
    void invalidJsonIsIgnored() {
        assertTrue(feed("data: {esto no es json}\n").isEmpty());
    }

    @Test
    void commentLineIsIgnored() {
        assertTrue(feed(": keep-alive\n").isEmpty());
    }

    @Test
    void crlfLinesAreSupported() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]}}]}\r\n");

        assertEquals(1, chunks.size());
        assertEquals("ok", chunks.get(0).text());
    }

    @Test
    void promptFeedbackBlocks() {
        List<GeminiChunk> chunks = feed("data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n");

        assertEquals(1, chunks.size());
        assertEquals(GeminiChunk.Kind.BLOCKED, chunks.get(0).kind());
        assertEquals("SAFETY", chunks.get(0).blockReason());
    }

    @Test
    void finishReasonSafetyBlocks() {
        List<GeminiChunk> chunks = feed(
                "data: {\"candidates\":[{\"content\":{\"parts\":[]},\"finishReason\":\"SAFETY\"}]}\n");

        assertEquals(1, chunks.size());
        assertEquals(GeminiChunk.Kind.BLOCKED, chunks.get(0).kind());
    }

    @Test
    void emptyTextPartIsNotEmitted() {
        assertTrue(feed("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"\"}]}}]}\n").isEmpty());
    }
}
