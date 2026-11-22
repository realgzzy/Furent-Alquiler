package com.alquiler.furent.controller.admin;

import com.alquiler.furent.assistant.AssistantAdminService;
import com.alquiler.furent.assistant.AssistantConversationService;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.AssistantMessage;
import com.alquiler.furent.service.AuditLogService;
import com.alquiler.furent.service.UserService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.flash;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.model;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.redirectedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.view;

/**
 * Pruebas del panel admin del asistente.
 *
 * El control de acceso ("/admin/**" requiere ROLE_ADMIN) lo aplica SecurityConfig y queda
 * cubierto por las pruebas de seguridad; aquí se validan datos, filtros y exportación.
 */
@ExtendWith(MockitoExtension.class)
class AdminAssistantControllerTest {

    @Mock
    private AssistantAdminService adminService;
    @Mock
    private AssistantConversationService conversationService;
    @Mock
    private UserService userService;
    @Mock
    private AuditLogService auditLogService;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        AdminAssistantController controller = new AdminAssistantController(
                adminService, conversationService, userService, auditLogService);
        mockMvc = MockMvcBuilders.standaloneSetup(controller).build();
    }

    private AssistantConversation conversation(String id) {
        AssistantConversation c = new AssistantConversation();
        c.setId(id);
        c.setEstado(AssistantConversation.ESTADO_ACTIVA);
        return c;
    }

    private void stubStats() {
        when(adminService.stats()).thenReturn(new AssistantAdminService.Stats(
                0, 0, 0, 0, 0, 0, BigDecimal.ZERO));
    }

    @Test
    void listadoRenderizaLaPlantillaConMetricas() throws Exception {
        when(adminService.search(any(), any(), any(), any(), any(), anyInt(), anyInt()))
                .thenReturn(new PageImpl<>(List.of(conversation("c1"))));
        stubStats();

        mockMvc.perform(get("/admin/asistente"))
                .andExpect(status().isOk())
                .andExpect(view().name("admin/asistente"))
                .andExpect(model().attributeExists("conversaciones", "statsTotal", "statsHoy", "statsTotalCotizado"))
                .andExpect(model().attribute("totalConversaciones", 1L));
    }

    @Test
    void filtrosSeTraducenALaConsulta() throws Exception {
        when(adminService.search(any(), any(), any(), any(), any(), anyInt(), anyInt()))
                .thenReturn(new PageImpl<>(List.of()));
        stubStats();

        mockMvc.perform(get("/admin/asistente")
                        .param("estado", "ESCALADA")
                        .param("cotizo", "true")
                        .param("desde", "2026-11-01")
                        .param("hasta", "2026-11-20")
                        .param("q", "montaje"))
                .andExpect(status().isOk());

        ArgumentCaptor<String> estado = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Boolean> cotizo = ArgumentCaptor.forClass(Boolean.class);
        ArgumentCaptor<Instant> desde = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Instant> hasta = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<String> q = ArgumentCaptor.forClass(String.class);
        verify(adminService).search(estado.capture(), cotizo.capture(), desde.capture(),
                hasta.capture(), q.capture(), eq(0), eq(25));

        assertEquals("ESCALADA", estado.getValue());
        assertTrue(cotizo.getValue());
        assertEquals("montaje", q.getValue());
        assertNotNull(desde.getValue());
        assertNotNull(hasta.getValue());
        assertTrue(desde.getValue().isBefore(hasta.getValue()));
    }

    @Test
    void cotizoVacioONoEnviadoNoFiltra() throws Exception {
        when(adminService.search(any(), any(), any(), any(), any(), anyInt(), anyInt()))
                .thenReturn(new PageImpl<>(List.of()));
        stubStats();

        mockMvc.perform(get("/admin/asistente").param("cotizo", "ALL"))
                .andExpect(status().isOk());

        ArgumentCaptor<Boolean> cotizo = ArgumentCaptor.forClass(Boolean.class);
        verify(adminService).search(any(), cotizo.capture(), any(), any(), any(), anyInt(), anyInt());
        assertNull(cotizo.getValue());
    }

    @Test
    void detalleMuestraLaTranscripcion() throws Exception {
        AssistantConversation c = conversation("conv-1");
        c.setUserId("u1");
        when(conversationService.find("conv-1")).thenReturn(Optional.of(c));
        when(adminService.messages("conv-1")).thenReturn(List.of(new AssistantMessage("conv-1", "USER", "hola")));
        when(userService.findById("u1")).thenReturn(Optional.empty());

        mockMvc.perform(get("/admin/asistente/conv-1"))
                .andExpect(status().isOk())
                .andExpect(view().name("admin/asistente-detalle"))
                .andExpect(model().attributeExists("conversacion", "mensajes"));
    }

    @Test
    void detalleInexistenteRedirigeAlListado() throws Exception {
        when(conversationService.find("nope")).thenReturn(Optional.empty());

        mockMvc.perform(get("/admin/asistente/nope"))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("error"));
    }

    @Test
    void cerrarLlamaAlServicioYRegistraAuditoria() throws Exception {
        AssistantConversation c = conversation("conv-9");
        when(conversationService.find("conv-9")).thenReturn(Optional.of(c));

        mockMvc.perform(post("/admin/asistente/conv-9/cerrar")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente/conv-9"))
                .andExpect(flash().attributeExists("success"));

        verify(conversationService).close(c, AssistantConversation.MOTIVO_CIERRE_ADMIN);
        verify(auditLogService).log(eq("admin@furent.com"), eq("CERRAR_CONVERSACION_ASISTENTE"),
                eq("ASISTENTE"), eq("conv-9"), anyString());
    }

    @Test
    void eliminarBorraLaConversacionYRegistraAuditoria() throws Exception {
        AssistantConversation c = conversation("conv-9");
        when(conversationService.find("conv-9")).thenReturn(Optional.of(c));

        mockMvc.perform(post("/admin/asistente/conv-9/eliminar")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("success"));

        verify(conversationService).delete(c);
        verify(auditLogService).log(eq("admin@furent.com"), eq("ELIMINAR_CONVERSACION_ASISTENTE"),
                eq("ASISTENTE"), eq("conv-9"), anyString());
    }

    @Test
    void eliminarConversacionInexistenteRedirigeConError() throws Exception {
        when(conversationService.find("nope")).thenReturn(Optional.empty());

        mockMvc.perform(post("/admin/asistente/nope/eliminar")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("error"));

        verify(conversationService, org.mockito.Mockito.never()).delete(any());
    }

    @Test
    void contarDevuelveElTotalComoJson() throws Exception {
        when(adminService.count(any(), any(), any(), any(), any())).thenReturn(7L);

        mockMvc.perform(get("/admin/asistente/contar")
                        .param("estado", "ACTIVA")
                        .param("desde", "2026-11-01"))
                .andExpect(status().isOk())
                .andExpect(content().json("{\"count\":7}"));

        verify(adminService).count(eq("ACTIVA"), any(), any(), any(), any());
    }

    @Test
    void limpiarTodoExigeEscribirEliminar() throws Exception {
        mockMvc.perform(post("/admin/asistente/limpiar")
                        .param("alcance", "TODO")
                        .param("confirmacion", "borrar")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("error"));

        verify(adminService, org.mockito.Mockito.never()).deleteMatching(any(), any(), any(), any(), any());
    }

    @Test
    void limpiarTodoBorraYRegistraAuditoria() throws Exception {
        when(adminService.deleteMatching(null, null, null, null, null)).thenReturn(3L);

        mockMvc.perform(post("/admin/asistente/limpiar")
                        .param("alcance", "TODO")
                        .param("confirmacion", "ELIMINAR")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("success"));

        verify(adminService).deleteMatching(null, null, null, null, null);
        verify(auditLogService).log(eq("admin@furent.com"), eq("LIMPIAR_CONVERSACIONES_ASISTENTE"),
                eq("ASISTENTE"), any(), anyString());
    }

    @Test
    void limpiarRangoExigeAlgunaFecha() throws Exception {
        mockMvc.perform(post("/admin/asistente/limpiar")
                        .param("alcance", "RANGO")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("error"));

        verify(adminService, org.mockito.Mockito.never()).deleteMatching(any(), any(), any(), any(), any());
    }

    @Test
    void limpiarRangoUsaLosFiltrosDelRango() throws Exception {
        when(adminService.deleteMatching(any(), any(), any(), any(), any())).thenReturn(2L);

        mockMvc.perform(post("/admin/asistente/limpiar")
                        .param("alcance", "RANGO")
                        .param("desde", "2026-11-01")
                        .param("hasta", "2026-11-20")
                        .param("estado", "ESCALADA")
                        .principal(new TestingAuthenticationToken("admin@furent.com", "pw", "ROLE_ADMIN")))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/admin/asistente"))
                .andExpect(flash().attributeExists("success"));

        ArgumentCaptor<String> estado = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Instant> desde = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Instant> hasta = ArgumentCaptor.forClass(Instant.class);
        verify(adminService).deleteMatching(estado.capture(), any(), desde.capture(), hasta.capture(), any());

        assertEquals("ESCALADA", estado.getValue());
        assertNotNull(desde.getValue());
        assertNotNull(hasta.getValue());
        assertTrue(desde.getValue().isBefore(hasta.getValue()));
    }

    @Test
    void exportacionDevuelveCsv() throws Exception {        AssistantConversation c = conversation("c1");
        c.setSessionId("s1");
        c.setTotalMensajes(3);
        when(adminService.listForExport(any(), any(), any(), any(), any())).thenReturn(List.of(c));

        mockMvc.perform(get("/admin/asistente/export.csv"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.parseMediaType("text/csv")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("id,inicio")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("c1")));
    }
}
