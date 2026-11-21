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

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
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
        properties.setSessionHours(24);
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
    void crearConversacionDeUsuarioTambienEsTemporal() {
        AssistantConversation created = service.resolve(null, new ToolContext("u1", "s1"), null);

        assertNotNull(created.getUserId());
        assertNotNull(created.getExpireAt());
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
        assertNotNull(resolved.getExpireAt());
    }

    @Test
    void listDeUsuarioAutenticadoUsaElUserId() {
        List<AssistantConversation> esperadas = new ArrayList<>();
        esperadas.add(new AssistantConversation());
        when(conversationRepository.findByUserIdOrderByUltimoMensajeDesc("u1")).thenReturn(esperadas);

        List<AssistantConversation> resultado = service.list(new ToolContext("u1", "s1"), 30);

        assertEquals(1, resultado.size());
    }

    @Test
    void listDeInvitadoUsaElSessionId() {
        when(conversationRepository.findBySessionIdOrderByUltimoMensajeDesc("s1"))
                .thenReturn(List.of());

        List<AssistantConversation> resultado = service.list(new ToolContext(null, "s1"), 30);

        assertTrue(resultado.isEmpty());
    }

    @Test
    void deleteBorraMensajesYConversacion() {
        AssistantConversation conv = new AssistantConversation();
        conv.setId("conv-1");

        service.delete(conv);

        verify(messageRepository).deleteByConversationId("conv-1");
        verify(conversationRepository).delete(conv);
    }

    @Test
    void deleteIgnoraConversacionSinId() {
        service.delete(new AssistantConversation());

        verify(messageRepository, times(0)).deleteByConversationId(any());
    }

    @Test
    void saveUserMessageFijaElTituloConElPrimerMensaje() {
        AssistantConversation conv = new AssistantConversation();
        conv.setId("conv-1");

        service.saveUserMessage(conv, "  Necesito sillas   para un cumpleaños  ");

        assertEquals("Necesito sillas para un cumpleaños", conv.getTitulo());
    }

    @Test
    void elTituloNoCambiaConMensajesPosteriores() {
        AssistantConversation conv = new AssistantConversation();
        conv.setId("conv-1");
        conv.setTitulo("Primer tema");

        service.saveUserMessage(conv, "segundo mensaje");

        assertEquals("Primer tema", conv.getTitulo());
    }
}
