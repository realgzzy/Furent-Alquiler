package com.alquiler.furent.controller;

import com.alquiler.furent.assistant.AssistantConversationService;
import com.alquiler.furent.assistant.ToolContext;
import com.alquiler.furent.config.FeatureFlags;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.User;
import com.alquiler.furent.service.PdfService;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AssistantExtrasControllerTest {

    @Mock
    private AssistantConversationService conversations;
    @Mock
    private UserService userService;
    @Mock
    private PdfService pdfService;

    private final ObjectMapper mapper = new ObjectMapper();
    private FeatureFlags featureFlags;
    private AssistantExtrasController controller;
    private Authentication auth;

    @BeforeEach
    void setUp() {
        featureFlags = new FeatureFlags();
        featureFlags.setAssistantEnabled(true);
        controller = new AssistantExtrasController(featureFlags, conversations, userService, pdfService);
        auth = new UsernamePasswordAuthenticationToken("ana@test.com", null,
                java.util.List.of(new SimpleGrantedAuthority("ROLE_USER")));

        User user = new User();
        user.setId("user-1");
        user.setEmail("ana@test.com");
        org.mockito.Mockito.lenient().when(userService.findByEmail("ana@test.com")).thenReturn(Optional.of(user));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> body(String json) throws Exception {
        return mapper.readValue(json, Map.class);
    }

    @Test
    void feedbackRegistraValoracionPositiva() throws Exception {
        AssistantConversation conversation = new AssistantConversation();
        conversation.setId("conv-1");
        conversation.setUserId("user-1");
        when(conversations.find("conv-1")).thenReturn(Optional.of(conversation));
        when(conversations.owns(eq(conversation), any(ToolContext.class))).thenReturn(true);

        Map<String, Object> body = body("{\"conversationId\":\"conv-1\",\"valor\":\"POSITIVO\"}");
        ResponseEntity<?> response = controller.feedback(body, new MockHttpServletRequest(), auth);

        assertThat(response.getStatusCode().is2xxSuccessful())
                .as(String.valueOf(response.getBody()))
                .isTrue();
        verify(conversations).registerFeedback(conversation, true);
    }

    @Test
    void feedbackRechazaValorDesconocido() throws Exception {
        Map<String, Object> body = body("{\"conversationId\":\"conv-1\",\"valor\":\"quizas\"}");
        ResponseEntity<?> response = controller.feedback(body, new MockHttpServletRequest(), auth);

        assertThat(response.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void feedbackNoExponeConversacionAjena() throws Exception {
        when(conversations.find("conv-1")).thenReturn(Optional.empty());

        Map<String, Object> body = body("{\"conversationId\":\"conv-1\",\"valor\":\"NEGATIVO\"}");
        ResponseEntity<?> response = controller.feedback(body, new MockHttpServletRequest(), auth);

        assertThat(response.getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void cotizacionPdfDevuelveDocumento() throws Exception {
        when(pdfService.generatePdfFromHtml(eq("assistant/pdf/cotizacion"), any()))
                .thenReturn(new byte[] { 1, 2, 3, 4 });

        Map<String, Object> body = body("""
                {"dias":2,"subtotal":100000,"descuento":0,"total":200000,
                 "fechaInicio":"2026-06-01","fechaFin":"2026-06-02",
                 "items":[{"nombre":"Silla","cantidad":10,"precioDia":5000,"subtotal":50000}]}
                """);
        ResponseEntity<?> response = controller.cotizacionPdf(body, new MockHttpServletRequest(), auth);

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getHeaders().getContentType()).isEqualTo(MediaType.APPLICATION_PDF);
        assertThat((byte[]) response.getBody()).hasSize(4);
    }

    @Test
    void cotizacionPdfSinItemsDevuelveBadRequest() throws Exception {
        Map<String, Object> body = body("{\"items\":[]}");
        ResponseEntity<?> response = controller.cotizacionPdf(body, new MockHttpServletRequest(), auth);

        assertThat(response.getStatusCode().value()).isEqualTo(400);
    }
}
