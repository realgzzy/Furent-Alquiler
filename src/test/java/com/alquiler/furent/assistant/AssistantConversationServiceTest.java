package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.repository.AssistantConversationRepository;
import com.alquiler.furent.repository.AssistantMessageRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AssistantConversationServiceTest {

    @Mock
    private AssistantConversationRepository conversationRepository;
    @Mock
    private AssistantMessageRepository messageRepository;

    private AssistantConversationService service;

    @BeforeEach
    void setUp() {
        AssistantProperties properties = new AssistantProperties();
        properties.setRetentionDays(30);
        service = new AssistantConversationService(conversationRepository, messageRepository, properties);
        lenient().when(conversationRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    @Test
    void ownsCompruebaSesionYUsuario() {
        AssistantConversation guest = new AssistantConversation();
        guest.setSessionId("s1");

        assertTrue(service.owns(guest, new ToolContext(null, "s1")));
        assertFalse(service.owns(guest, new ToolContext(null, "s2")));

        AssistantConversation user = new AssistantConversation();
        user.setUserId("u1");
        assertTrue(service.owns(user, new ToolContext("u1", "s1")));
        assertFalse(service.owns(user, new ToolContext("u2", null)));
    }

    @Test
    void crearConversacionDeInvitadoAsignaExpiracion() {
        AssistantConversation created = service.resolve(null, new ToolContext(null, "s1"), "/catalogo");

        assertNotNull(created);
        assertNull(created.getUserId());
        assertNotNull(created.getExpireAt());
    }

    @Test
    void crearConversacionDeUsuarioNoExpira() {
        AssistantConversation created = service.resolve(null, new ToolContext("u1", "s1"), null);

        assertNotNull(created.getUserId());
        assertNull(created.getExpireAt());
    }

    @Test
    void conversacionDeInvitadoSeMigraAlIniciarSesion() {
        AssistantConversation guest = new AssistantConversation();
        guest.setId("conv-1");
        guest.setSessionId("s1");
        when(conversationRepository.findById("conv-1")).thenReturn(Optional.of(guest));

        AssistantConversation resolved = service.resolve("conv-1", new ToolContext("u1", "s1"), "/panel");

        assertNotNull(resolved);
        assertTrue("u1".equals(resolved.getUserId()));
        assertNull(resolved.getExpireAt());
    }
}
