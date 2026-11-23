package com.alquiler.furent.assistant;

import com.alquiler.furent.assistant.dto.AssistantChatRequest;
import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.AssistantConversation;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.never;

@ExtendWith(MockitoExtension.class)
class AssistantOrchestratorTest {

    @Mock
    private AssistantConversationService conversations;
    @Mock
    private AssistantQuotaService quota;
    @Mock
    private AssistantPromptBuilder promptBuilder;
    @Mock
    private GeminiClient geminiClient;
    @Mock
    private AssistantToolService toolService;
    @Mock
    private AssistantMetrics metrics;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ToolContext guest = new ToolContext(null, "session-1");

    private AssistantProperties properties;
    private AssistantOrchestrator orchestrator;
    private AssistantConversation conversation;

    @BeforeEach
    void setUp() {
        properties = new AssistantProperties();
        properties.setMaxToolIterations(3);
        orchestrator = new AssistantOrchestrator(properties, conversations, quota, promptBuilder,
                geminiClient, toolService, metrics, mapper);

        conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setSessionId("session-1");

        lenient().when(conversations.resolve(any(), any(), any())).thenReturn(conversation);
        lenient().when(conversations.history(anyString())).thenReturn(List.of());
        lenient().when(promptBuilder.initialContents(anyList(), anyString()))
                .thenReturn(new ArrayList<>(List.of()));
        lenient().when(promptBuilder.buildBody(anyList(), any(), any()))
                .thenReturn(mapper.createObjectNode());
    }

    /** Emite una secuencia de respuestas de Gemini, una por llamada a stream(). */
    private void stubGemini(List<List<GeminiChunk>> responses) {
        AtomicInteger index = new AtomicInteger();
        lenient().doAnswer(invocation -> {
            Consumer<GeminiChunk> consumer = invocation.getArgument(1);
            List<GeminiChunk> chunks = responses.get(Math.min(index.getAndIncrement(), responses.size() - 1));
            chunks.forEach(consumer);
            return null;
        }).when(geminiClient).stream(any(), any());
    }

    private AssistantChatRequest request() {
        AssistantChatRequest request = new AssistantChatRequest();
        request.setMessage("hola");
        return request;
    }

    @Test
    void textoSimpleEmiteMetaTokenYDone() {
        stubGemini(List.of(List.of(
                GeminiChunk.text("Hola "),
                GeminiChunk.text("mundo"),
                GeminiChunk.usage(10, 5))));

        RecordingStream stream = new RecordingStream();
        orchestrator.handle(request(), guest, stream);

        assertTrue(stream.types.contains("meta"));
        assertEquals("Hola mundo", stream.text.toString());
        assertTrue(stream.types.contains("done"));
        assertTrue(stream.completed);
        verify(conversations).saveAssistantMessage(conversation, "Hola mundo", properties.getModel());
    }

    @Test
    void toolCallDeBusquedaEmiteCardYVuelveAlModelo() {
        ObjectNode card = mapper.createObjectNode().put("tipo", "producto").put("id", "p1");
        when(toolService.execute(anyString(), any(), any()))
                .thenReturn(ToolResult.of(mapper.createObjectNode(), List.of(new UiEvent(UiEvent.CARD, card))));

        stubGemini(List.of(
                List.of(GeminiChunk.functionCall("buscar_productos", mapper.createObjectNode())),
                List.of(GeminiChunk.text("Encontré una opción"))));

        RecordingStream stream = new RecordingStream();
        orchestrator.handle(request(), guest, stream);

        assertTrue(stream.types.contains("card"));
        assertTrue(stream.text.toString().contains("Encontré una opción"));
        verify(conversations).saveToolMessage(conversation, "buscar_productos", "{}");
    }

    @Test
    void toolCallReenviaThoughtSignatureAlModelo() {
        when(toolService.execute(anyString(), any(), any()))
                .thenReturn(ToolResult.of(mapper.createObjectNode()));

        stubGemini(List.of(
                List.of(GeminiChunk.functionCall("buscar_productos", mapper.createObjectNode(), "firma-xyz")),
                List.of(GeminiChunk.text("ok"))));

        List<List<JsonNode>> captured = new ArrayList<>();
        doAnswer(invocation -> {
            captured.add(new ArrayList<>(invocation.getArgument(0)));
            return mapper.createObjectNode();
        }).when(promptBuilder).buildBody(anyList(), any(), any());

        orchestrator.handle(request(), guest, new RecordingStream());

        assertTrue(captured.size() >= 2);
        JsonNode modelTurn = captured.get(1).get(0);
        assertEquals("model", modelTurn.path("role").asText());
        assertEquals("firma-xyz", modelTurn.path("parts").get(0).path("thoughtSignature").asText());
    }

    @Test
    void toolCallDeCotizacionEmiteQuoteYRegistraLaCotizacion() {
        ObjectNode quote = mapper.createObjectNode();
        quote.put("total", 150000);
        quote.put("checkoutUrl", "/cotizacion");
        when(toolService.execute(anyString(), any(), any()))
                .thenReturn(ToolResult.of(mapper.createObjectNode(), List.of(new UiEvent(UiEvent.QUOTE, quote))));

        stubGemini(List.of(
                List.of(GeminiChunk.functionCall("cotizar", mapper.createObjectNode())),
                List.of(GeminiChunk.text("Listo"))));

        RecordingStream stream = new RecordingStream();
        orchestrator.handle(request(), guest, stream);

        assertTrue(stream.types.contains("quote"));
        verify(conversations).registerQuote(any(), any());
        verify(metrics).quote();
    }

    @Test
    void cuotaExcedidaEmiteErrorYNoLlamaAGemini() {
        doThrow(new AssistantException(AssistantException.Code.RATE_LIMITED, "tope"))
                .when(quota).checkAndConsume(guest);

        RecordingStream stream = new RecordingStream();
        orchestrator.handle(request(), guest, stream);

        assertTrue(stream.types.contains("error"));
        assertEquals(AssistantException.Code.RATE_LIMITED.name(), stream.lastErrorCodigo);
        assertFalse(stream.types.contains("done"));
        assertTrue(stream.completed);
        verify(geminiClient, never()).stream(any(), any());
    }

    @Test
    void respuestaBloqueadaEmiteErrorControlado() {
        stubGemini(List.of(List.of(GeminiChunk.blocked("SAFETY"))));

        RecordingStream stream = new RecordingStream();
        orchestrator.handle(request(), guest, stream);

        assertTrue(stream.types.contains("error"));
        assertEquals(AssistantException.Code.BLOCKED.name(), stream.lastErrorCodigo);
    }

    @Test
    void seCortaCuandoElClienteCierraElStream() {
        // El stream se cierra al recibir meta; el bucle no debe llamar a Gemini.
        stubGemini(List.of(List.of(GeminiChunk.text("x"))));
        RecordingStream stream = new RecordingStream() {
            @Override
            public void event(String type, JsonNode data) {
                super.event(type, data);
                if ("meta".equals(type)) {
                    open = false;
                }
            }
        };

        orchestrator.handle(request(), guest, stream);

        verify(geminiClient, never()).stream(any(), any());
    }

    private static class RecordingStream implements AssistantStream {
        final List<String> types = new ArrayList<>();
        final StringBuilder text = new StringBuilder();
        boolean completed;
        boolean open = true;
        String lastErrorCodigo;

        @Override
        public void event(String type, JsonNode data) {
            types.add(type);
            if ("error".equals(type) && data != null) {
                lastErrorCodigo = data.path("codigo").asText();
            }
        }

        @Override
        public void token(String value) {
            text.append(value);
        }

        @Override
        public void complete() {
            completed = true;
            open = false;
        }

        @Override
        public boolean isOpen() {
            return open;
        }
    }
}
