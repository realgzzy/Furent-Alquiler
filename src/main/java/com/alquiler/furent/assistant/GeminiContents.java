package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.List;

/**
 * Constructores de los objetos {@code contents} que espera la API de Gemini.
 */
public final class GeminiContents {

    private GeminiContents() {
    }

    /**
     * Llamada a función solicitada por el modelo.
     *
     * @param thoughtSignature firma de pensamiento exigida por Gemini 3.x; viaja junto a la
     *                         llamada al reenviar el historial. Puede ser nula en modelos 2.x.
     */
    public record Call(String name, JsonNode args, String thoughtSignature) {

        public Call(String name, JsonNode args) {
            this(name, args, null);
        }
    }

    /**
     * Respuesta que el backend devuelve al modelo para una llamada.
     */
    public record Response(String name, JsonNode payload) {
    }

    /**
     * Un único turno de modelo con varias llamadas a función.
     */
    public static ObjectNode modelFunctionCalls(ObjectMapper mapper, List<Call> calls) {
        ObjectNode content = mapper.createObjectNode();
        content.put("role", "model");
        ArrayNode parts = content.putArray("parts");
        for (Call call : calls) {
            ObjectNode part = parts.addObject();
            ObjectNode functionCall = part.putObject("functionCall");
            functionCall.put("name", call.name());
            functionCall.set("args", call.args() == null ? mapper.createObjectNode() : call.args());
            if (call.thoughtSignature() != null && !call.thoughtSignature().isBlank()) {
                part.put("thoughtSignature", call.thoughtSignature());
            }
        }
        return content;
    }

    /**
     * Un único turno de usuario con varias respuestas de función.
     */
    public static ObjectNode userFunctionResponses(ObjectMapper mapper, List<Response> responses) {
        ObjectNode content = mapper.createObjectNode();
        content.put("role", "user");
        ArrayNode parts = content.putArray("parts");
        for (Response response : responses) {
            ObjectNode part = parts.addObject();
            ObjectNode functionResponse = part.putObject("functionResponse");
            functionResponse.put("name", response.name());
            functionResponse.set("response", response.payload() == null
                    ? mapper.createObjectNode() : response.payload());
        }
        return content;
    }

    public static ObjectNode userText(ObjectMapper mapper, String text) {
        ObjectNode content = mapper.createObjectNode();
        content.put("role", "user");
        content.putArray("parts").addObject().put("text", text);
        return content;
    }

    public static ObjectNode modelText(ObjectMapper mapper, String text) {
        ObjectNode content = mapper.createObjectNode();
        content.put("role", "model");
        content.putArray("parts").addObject().put("text", text);
        return content;
    }

    public static ObjectNode modelFunctionCall(ObjectMapper mapper, String name, JsonNode args) {
        ObjectNode content = mapper.createObjectNode();
        content.put("role", "model");
        ObjectNode functionCall = content.putArray("parts").addObject().putObject("functionCall");
        functionCall.put("name", name);
        functionCall.set("args", args == null ? mapper.createObjectNode() : args);
        return content;
    }

    public static ObjectNode userFunctionResponse(ObjectMapper mapper, String name, JsonNode response) {
        ObjectNode content = mapper.createObjectNode();
        content.put("role", "user");
        ObjectNode functionResponse = content.putArray("parts").addObject().putObject("functionResponse");
        functionResponse.put("name", name);
        functionResponse.set("response", response == null ? mapper.createObjectNode() : response);
        return content;
    }

    public static ArrayNode parts(ObjectMapper mapper) {
        return mapper.createArrayNode();
    }
}
