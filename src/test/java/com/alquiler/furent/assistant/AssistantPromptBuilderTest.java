package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.AssistantMessage;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.lenient;

@ExtendWith(MockitoExtension.class)
class AssistantPromptBuilderTest {

    @Mock
    private AssistantKnowledgeService knowledgeService;
    @Mock
    private AssistantToolDefinitions toolDefinitions;

    private final ObjectMapper mapper = new ObjectMapper();
    private AssistantProperties properties;
    private AssistantPromptBuilder builder;

    @BeforeEach
    void setUp() {
        properties = new AssistantProperties();
        properties.setHistoryWindow(2);
        properties.setMaxOutputTokens(800);
        builder = new AssistantPromptBuilder(properties, knowledgeService, toolDefinitions, mapper);
        lenient().when(knowledgeService.renderForPrompt()).thenReturn("negocio:\n  nombre: Furent");
        lenient().when(toolDefinitions.declarations()).thenReturn(mapper.createArrayNode());
    }

    private AssistantMessage message(String rol, String contenido) {
        return new AssistantMessage("conv-1", rol, contenido);
    }

    @Test
    void systemInstructionIncluyeReglasYContexto() {
        String system = builder.systemInstruction(new ToolContext("u1", "s1"), "/catalogo");

        assertTrue(system.contains("Furent"));
        assertTrue(system.contains("COP"));
        assertTrue(system.contains("Usuario autenticado: sí"));
        assertTrue(system.contains("/catalogo"));
        assertTrue(system.contains("negocio:"));
    }

    @Test
    void systemInstructionMarcaInvitado() {
        String system = builder.systemInstruction(new ToolContext(null, "s1"), null);
        assertTrue(system.contains("Usuario autenticado: no"));
    }

    @Test
    void historialSeRecortaAVentanaYMapeaRoles() {
        List<AssistantMessage> historial = List.of(
                message(AssistantMessage.ROL_USER, "uno"),
                message(AssistantMessage.ROL_ASSISTANT, "dos"),
                message(AssistantMessage.ROL_TOOL, "ignorado"),
                message(AssistantMessage.ROL_USER, "tres"));

        ObjectNode body = builder.buildBody(historial, "nuevo", new ToolContext(null, "s"), null);

        // ventana = últimos 2 mensajes almacenados; el TOOL se omite al mapear
        assertEquals(2, body.path("contents").size());
        assertEquals("tres", body.path("contents").get(0).path("parts").get(0).path("text").asText());
        assertEquals("user", body.path("contents").get(0).path("role").asText());
        assertEquals("nuevo", body.path("contents").get(1).path("parts").get(0).path("text").asText());
    }

    @Test
    void bodyIncluyeHerramientasYConfiguracion() {
        ObjectNode body = builder.buildBody(List.of(), "hola", new ToolContext(null, "s"), null);

        assertEquals(1, body.path("tools").size());
        assertTrue(body.path("tools").get(0).has("functionDeclarations"));
        assertEquals(800, body.path("generationConfig").path("maxOutputTokens").asInt());
        assertEquals("MINIMAL", body.path("generationConfig").path("thinkingConfig").path("thinkingLevel").asText());
        assertFalse(body.path("generationConfig").path("thinkingConfig").has("thinkingBudget"));
        assertEquals(4, body.path("safetySettings").size());
        assertTrue(body.path("systemInstruction").path("parts").get(0).path("text").asText().contains("Furent"));
    }

    @Test
    void modelosGemini2SiguenUsandoThinkingBudget() {
        properties.setModel("gemini-2.5-flash-lite");

        ObjectNode body = builder.buildBody(List.of(), "hola", new ToolContext(null, "s"), null);

        assertEquals(0, body.path("generationConfig").path("thinkingConfig").path("thinkingBudget").asInt());
        assertFalse(body.path("generationConfig").path("thinkingConfig").has("thinkingLevel"));
    }
}
