package com.alquiler.furent.assistant;

import com.alquiler.furent.model.ContactMessage;
import com.alquiler.furent.model.Product;
import com.alquiler.furent.repository.ReservationRepository;
import com.alquiler.furent.service.ContactService;
import com.alquiler.furent.service.InspirationService;
import com.alquiler.furent.service.NotificationService;
import com.alquiler.furent.service.ProductService;
import com.alquiler.furent.service.ReviewService;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AssistantExtraToolServiceTest {

    @Mock
    private ProductService productService;
    @Mock
    private ReservationRepository reservationRepository;
    @Mock
    private ReviewService reviewService;
    @Mock
    private InspirationService inspirationService;
    @Mock
    private UserService userService;
    @Mock
    private NotificationService notificationService;
    @Mock
    private ContactService contactService;

    private ObjectMapper mapper = new ObjectMapper();
    private AssistantExtraToolService service;

    private static final ToolContext AUTH = new ToolContext("user-1", "session-1");
    private static final ToolContext GUEST = new ToolContext(null, "session-1");

    @BeforeEach
    void setUp() {
        service = new AssistantExtraToolService(productService, reservationRepository, reviewService,
                inspirationService, userService, notificationService, contactService,
                new AssistantSemanticSearch(productService), mapper);
    }

    private Product product(String id, String nombre, long precio, double rating) {
        Product p = new Product();
        p.setId(id);
        p.setNombre(nombre);
        p.setPrecioPorDia(BigDecimal.valueOf(precio));
        p.setCalificacion(rating);
        p.setStock(30);
        p.setDisponible(true);
        p.setCategoriaNombre("Sillas");
        p.setImagenUrl("/img/" + id + ".jpg");
        return p;
    }

    private ObjectNode args(String json) throws Exception {
        return (ObjectNode) mapper.readTree(json);
    }

    @Test
    void compararProductosEmitePanelConGanadores() throws Exception {
        when(productService.getProductById("a")).thenReturn(Optional.of(product("a", "Silla A", 50000, 4.5)));
        when(productService.getProductById("b")).thenReturn(Optional.of(product("b", "Silla B", 80000, 4.9)));

        ToolResult result = service.execute("comparar_productos",
                args("{\"productoIds\":[\"a\",\"b\"]}"), AUTH);

        assertThat(result.payload().path("productos").size()).isEqualTo(2);
        assertThat(result.payload().path("mejorPrecio").asText()).isEqualTo("a");
        assertThat(result.payload().path("mejorCalificacion").asText()).isEqualTo("b");
        assertThat(result.uiEvents()).hasSize(1);
        assertThat(result.uiEvents().get(0).type()).isEqualTo(UiEvent.PANEL);
        assertThat(result.uiEvents().get(0).data().path("vista").asText()).isEqualTo("comparar");
    }

    @Test
    void compararProductosExigeAlMenosDos() throws Exception {
        ToolResult result = service.execute("comparar_productos",
                args("{\"productoIds\":[\"a\"]}"), AUTH);

        assertThat(result.payload().path("error").asText()).isNotBlank();
    }

    @Test
    void sugerirPaginaFiltraCatalogo() throws Exception {
        ToolResult result = service.execute("sugerir_pagina",
                args("{\"pagina\":\"catalogo\",\"categoria\":\"Mesas\"}"), AUTH);

        assertThat(result.uiEvents()).hasSize(1);
        String url = result.uiEvents().get(0).data().path("links").get(0).path("url").asText();
        assertThat(url).contains("/catalogo").contains("categoria=Mesas");
    }

    @Test
    void guardarContactoRegistraMensaje() throws Exception {
        when(contactService.save(any(ContactMessage.class))).thenAnswer(inv -> inv.getArgument(0));

        ToolResult result = service.execute("guardar_contacto",
                args("{\"nombre\":\"Ana\",\"telefono\":\"3000000000\",\"motivo\":\"Boda\"}"), GUEST);

        assertThat(result.payload().path("ok").asBoolean()).isTrue();
        verify(contactService).save(any(ContactMessage.class));
    }

    @Test
    void guardarContactoSinContactoDevuelveError() throws Exception {
        ToolResult result = service.execute("guardar_contacto",
                args("{\"nombre\":\"Ana\"}"), GUEST);

        assertThat(result.payload().path("error").asText()).isNotBlank();
    }

    @Test
    void misDireccionesRequiereSesion() throws Exception {
        ToolResult result = service.execute("mis_direcciones", mapper.createObjectNode(), GUEST);

        assertThat(result.payload().path("error").asText()).isNotBlank();
    }

    @Test
    void supportsReconoceHerramientasExtra() {
        assertThat(service.supports("comparar_productos")).isTrue();
        assertThat(service.supports("guardar_contacto")).isTrue();
        assertThat(service.supports("cotizar")).isFalse();
    }

    @Test
    void productosSimilaresDevuelveTarjetas() throws Exception {
        when(productService.getProductById("a")).thenReturn(Optional.of(product("a", "Silla A", 50000, 4.5)));
        when(productService.getRelatedProducts("a", "Sillas")).thenReturn(List.of(
                product("b", "Silla B", 52000, 4.6),
                product("c", "Silla C", 54000, 4.7)));

        ToolResult result = service.execute("productos_similares",
                args("{\"productoId\":\"a\"}"), AUTH);

        assertThat(result.payload().path("productos").size()).isEqualTo(2);
        assertThat(result.uiEvents()).extracting(UiEvent::type).containsOnly(UiEvent.CARD);
    }
}
