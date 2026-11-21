package com.alquiler.furent.controller;

import com.alquiler.furent.assistant.AssistantConversationService;
import com.alquiler.furent.assistant.AssistantOrchestrator;
import com.alquiler.furent.assistant.AssistantStream;
import com.alquiler.furent.assistant.ToolContext;
import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.config.FeatureFlags;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.task.TaskExecutor;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.scheduling.concurrent.ConcurrentTaskExecutor;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@ExtendWith(MockitoExtension.class)
class AssistantControllerTest {

    @Mock
    private AssistantOrchestrator orchestrator;
    @Mock
    private AssistantConversationService conversations;
    @Mock
    private UserService userService;

    private final ObjectMapper mapper = new ObjectMapper();
    private ExecutorService executorService;
    private TaskExecutor executor;

    private AssistantProperties properties;
    private FeatureFlags featureFlags;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        properties = new AssistantProperties();
        properties.setApiKey("test-key");
        featureFlags = new FeatureFlags();
        featureFlags.setAssistantEnabled(true);

        executorService = Executors.newSingleThreadExecutor();
        executor = new ConcurrentTaskExecutor(executorService);

        AssistantController controller = new AssistantController(properties, featureFlags, orchestrator,
                conversations, userService, mapper, executor);
        mockMvc = MockMvcBuilders.standaloneSetup(controller).build();
    }

    @AfterEach
    void tearDown() {
        executorService.shutdownNow();
    }

    @Test
    void sinFlagResponde503() throws Exception {
        featureFlags.setAssistantEnabled(false);

        mockMvc.perform(post("/api/asistente/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"hola\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.codigo").value("UNAVAILABLE"));
    }

    @Test
    void sinApiKeyResponde503() throws Exception {
        properties.setApiKey("");

        mockMvc.perform(post("/api/asistente/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"hola\"}"))
                .andExpect(status().isServiceUnavailable());
    }

    @Test
    void mensajeVacioResponde400() throws Exception {
        mockMvc.perform(post("/api/asistente/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"  \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.codigo").value("INVALID_INPUT"));
    }

    @Test
    void chatExitosoEmiteEventosSse() throws Exception {
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        doAnswer(invocation -> {
            AssistantStream stream = invocation.getArgument(2);
            try {
                release.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            stream.event("meta", mapper.createObjectNode().put("conversationId", "conv-1"));
            stream.token("Hola");
            stream.event("done", mapper.createObjectNode().put("tokens", 12));
            stream.complete();
            return null;
        }).when(orchestrator).handle(any(), any(ToolContext.class), any(AssistantStream.class));

        MvcResult result = mockMvc.perform(post("/api/asistente/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .content("{\"message\":\"hola\"}"))
                .andExpect(request().asyncStarted())
                .andReturn();

        release.countDown();

        mockMvc.perform(asyncDispatch(result))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("event:meta")))
                .andExpect(content().string(containsString("Hola")));
    }

    @Test
    void conversacionDeOtraSesionResponde404() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setSessionId("otra-sesion");
        when(conversations.find("conv-1")).thenReturn(Optional.of(conversation));
        lenient().when(conversations.owns(any(), any())).thenReturn(false);

        MockHttpSession session = new MockHttpSession();
        session.setAttribute(AssistantController.SESSION_ATTR, "session-1");

        mockMvc.perform(get("/api/asistente/conversations/conv-1").session(session))
                .andExpect(status().isNotFound());
    }

    @Test
    void conversacionPropiaDevuelveMensajes() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setSessionId("session-1");
        when(conversations.find("conv-1")).thenReturn(Optional.of(conversation));
        when(conversations.owns(any(), any())).thenReturn(true);
        when(conversations.messages("conv-1")).thenReturn(List.of());

        MockHttpSession session = new MockHttpSession();
        session.setAttribute(AssistantController.SESSION_ATTR, "session-1");

        mockMvc.perform(get("/api/asistente/conversations/conv-1").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.conversationId").value("conv-1"))
                .andExpect(jsonPath("$.messages").isArray());
    }

    @Test
    void closeMarcaLaConversacionYDevuelveEstado() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setSessionId("session-1");
        when(conversations.find("conv-1")).thenReturn(Optional.of(conversation));
        when(conversations.owns(any(), any())).thenReturn(true);

        MockHttpSession session = new MockHttpSession();
        session.setAttribute(AssistantController.SESSION_ATTR, "session-1");

        mockMvc.perform(post("/api/asistente/conversations/conv-1/close").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.conversationId").value("conv-1"));
    }

    @Test
    void listarConversacionesDevuelveResumenes() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setTitulo("Cumpleaños de Ana");
        conversation.setEstado("ACTIVA");
        conversation.setTotalMensajes(4);
        when(conversations.list(any(ToolContext.class), anyInt())).thenReturn(List.of(conversation));

        MockHttpSession session = new MockHttpSession();
        session.setAttribute(AssistantController.SESSION_ATTR, "session-1");

        mockMvc.perform(get("/api/asistente/conversations").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.conversations[0].conversationId").value("conv-1"))
                .andExpect(jsonPath("$.conversations[0].titulo").value("Cumpleaños de Ana"))
                .andExpect(jsonPath("$.conversations[0].totalMensajes").value(4));
    }

    @Test
    void listarConversacionesSinFlagResponde503() throws Exception {
        featureFlags.setAssistantEnabled(false);

        mockMvc.perform(get("/api/asistente/conversations"))
                .andExpect(status().isServiceUnavailable());
    }

    @Test
    void deleteConversacionPropiaLaElimina() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setSessionId("session-1");
        when(conversations.find("conv-1")).thenReturn(Optional.of(conversation));
        when(conversations.owns(any(), any())).thenReturn(true);

        MockHttpSession session = new MockHttpSession();
        session.setAttribute(AssistantController.SESSION_ATTR, "session-1");

        mockMvc.perform(delete("/api/asistente/conversations/conv-1").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.eliminada").value(true));

        verify(conversations).delete(conversation);
    }

    @Test
    void deleteConversacionAjenaResponde404() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setSessionId("otra-sesion");
        when(conversations.find("conv-1")).thenReturn(Optional.of(conversation));
        lenient().when(conversations.owns(any(), any())).thenReturn(false);

        MockHttpSession session = new MockHttpSession();
        session.setAttribute(AssistantController.SESSION_ATTR, "session-1");

        mockMvc.perform(delete("/api/asistente/conversations/conv-1").session(session))
                .andExpect(status().isNotFound());
    }
}
