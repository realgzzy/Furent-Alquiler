package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class GeminiContentsTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void modelFunctionCallsIncluyeThoughtSignature() {
        ObjectNode args = mapper.createObjectNode().put("consulta", "sillas");
        GeminiContents.Call call = new GeminiContents.Call("buscar_productos", args, "firma-abc");

        ObjectNode content = GeminiContents.modelFunctionCalls(mapper, List.of(call));

        assertEquals("model", content.path("role").asText());
        ObjectNode part = (ObjectNode) content.path("parts").get(0);
        assertEquals("buscar_productos", part.path("functionCall").path("name").asText());
        assertEquals("sillas", part.path("functionCall").path("args").path("consulta").asText());
        assertEquals("firma-abc", part.path("thoughtSignature").asText());
    }

    @Test
    void modelFunctionCallsOmiteThoughtSignatureVacia() {
        GeminiContents.Call call = new GeminiContents.Call("cotizar", mapper.createObjectNode());

        ObjectNode content = GeminiContents.modelFunctionCalls(mapper, List.of(call));

        ObjectNode part = (ObjectNode) content.path("parts").get(0);
        assertFalse(part.has("thoughtSignature"));
    }
}
