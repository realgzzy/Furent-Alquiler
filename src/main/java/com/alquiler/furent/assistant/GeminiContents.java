package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Constructores de los objetos {@code contents} que espera la API de Gemini.
 */
public final class GeminiContents {

    private GeminiContents() {
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
