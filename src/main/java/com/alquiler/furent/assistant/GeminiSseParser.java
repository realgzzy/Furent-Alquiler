package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

/**
 * Parser incremental de Server-Sent Events de Gemini.
 *
 * No es thread-safe: el orquestador debe crear una instancia por conversación.
 * Tolera fragmentos partidos entre lecturas, eventos multilínea, comentarios y {@code [DONE]}.
 * Un {@code data:} con JSON inválido se ignora y se registra un warning.
 */
public class GeminiSseParser {

    private static final Logger log = LoggerFactory.getLogger(GeminiSseParser.class);

    private final ObjectMapper mapper;
    private final StringBuilder buffer = new StringBuilder();
    private final StringBuilder eventData = new StringBuilder();

    public GeminiSseParser(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /**
     * Procesa un fragmento crudo y devuelve los fragmentos completos detectados.
     */
    public List<GeminiChunk> accept(String raw) {
        List<GeminiChunk> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) {
            return out;
        }
        buffer.append(raw);
        int newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            String line = buffer.substring(0, newline);
            buffer.delete(0, newline + 1);
            handleLine(stripCr(line), out);
        }
        return out;
    }

    /**
     * Cierra el parser y procesa lo que quede pendiente.
     */
    public List<GeminiChunk> finish() {
        List<GeminiChunk> out = new ArrayList<>();
        if (buffer.length() > 0) {
            handleLine(stripCr(buffer.toString()), out);
            buffer.setLength(0);
        }
        flushEvent(out);
        return out;
    }

    private void handleLine(String line, List<GeminiChunk> out) {
        if (line.isEmpty()) {
            flushEvent(out);
            return;
        }
        // Comentarios SSE (":") y campos que no son datos.
        if (line.startsWith(":")) {
            return;
        }
        if (line.startsWith("data:")) {
            String value = line.substring(5);
            if (value.startsWith(" ")) {
                value = value.substring(1);
            }
            eventData.append(value).append('\n');
        }
        // event:, id:, retry: se ignoran.
    }

    private void flushEvent(List<GeminiChunk> out) {
        if (eventData.length() == 0) {
            return;
        }
        String payload = eventData.toString().trim();
        eventData.setLength(0);
        if (payload.isEmpty() || "[DONE]".equals(payload)) {
            return;
        }
        parsePayload(payload, out);
    }

    private void parsePayload(String payload, List<GeminiChunk> out) {
        JsonNode root;
        try {
            root = mapper.readTree(payload);
        } catch (Exception e) {
            log.warn("Fragmento SSE de Gemini con JSON inválido, se ignora: {}", e.getMessage());
            return;
        }

        JsonNode promptFeedback = root.path("promptFeedback");
        if (promptFeedback.hasNonNull("blockReason")) {
            out.add(GeminiChunk.blocked(promptFeedback.get("blockReason").asText()));
        }

        JsonNode candidates = root.path("candidates");
        if (candidates.isArray()) {
            for (JsonNode candidate : candidates) {
                JsonNode parts = candidate.path("content").path("parts");
                if (parts.isArray()) {
                    for (JsonNode part : parts) {
                        if (part.hasNonNull("text")) {
                            String text = part.get("text").asText();
                            if (!text.isEmpty()) {
                                out.add(GeminiChunk.text(text));
                            }
                        }
                        JsonNode functionCall = part.path("functionCall");
                        if (functionCall.isObject() && functionCall.hasNonNull("name")) {
                            String signature = part.hasNonNull("thoughtSignature")
                                    ? part.get("thoughtSignature").asText()
                                    : null;
                            out.add(GeminiChunk.functionCall(
                                    functionCall.get("name").asText(),
                                    functionCall.path("args"),
                                    signature));
                        }
                    }
                }
                String finishReason = candidate.path("finishReason").asText("");
                if ("SAFETY".equals(finishReason) || "RECITATION".equals(finishReason)) {
                    out.add(GeminiChunk.blocked(finishReason));
                }
            }
        }

        JsonNode usage = root.path("usageMetadata");
        if (usage.isObject() && usage.has("promptTokenCount")) {
            out.add(GeminiChunk.usage(
                    usage.path("promptTokenCount").asInt(0),
                    usage.path("candidatesTokenCount").asInt(0)));
        }
    }

    private String stripCr(String line) {
        if (line.endsWith("\r")) {
            return line.substring(0, line.length() - 1);
        }
        return line;
    }
}
