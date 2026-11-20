package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.Product;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.repository.ReservationRepository;
import com.alquiler.furent.service.CouponService;
import com.alquiler.furent.service.ProductService;
import com.alquiler.furent.service.ReservationService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AssistantToolServiceTest {

    @Mock
    private ProductService productService;
    @Mock
    private ReservationService reservationService;
    @Mock
    private ReservationRepository reservationRepository;
    @Mock
    private CouponService couponService;
    @Mock
    private AssistantKnowledgeService knowledgeService;
    @Mock
    private AssistantToolDefinitions toolDefinitions;
    @Mock
    private AssistantMetrics metrics;
    @Spy
    private ObjectMapper mapper = new ObjectMapper();

    private AssistantProperties properties;
    private AssistantToolService service;

    private static final String USER = "user-1";
    private static final ToolContext AUTH = new ToolContext(USER, "session-1");
    private static final ToolContext GUEST = new ToolContext(null, "session-1");

    @BeforeEach
    void setUp() {
        properties = new AssistantProperties();
        properties.setWhatsappNumber("573105782442");
        service = new AssistantToolService(productService, reservationService, reservationRepository,
                couponService, knowledgeService, toolDefinitions, properties, metrics, mapper);
        lenient().when(toolDefinitions.exists(anyString())).thenReturn(true);
    }

    private Product product(String id, String nombre, long precio, int stock) {
        Product p = new Product();
        p.setId(id);
        p.setNombre(nombre);
        p.setPrecioPorDia(BigDecimal.valueOf(precio));
        p.setStock(stock);
        p.setDisponible(true);
        p.setCategoriaNombre("Sillas");
        p.setImagenUrl("/img/" + id + ".jpg");
        return p;
    }

    private ObjectNode args(String json) {
        try {
            return (ObjectNode) mapper.readTree(json);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void buscarProductosEmitsCards() {
        when(productService.searchProducts("sillas"))
                .thenReturn(List.of(product("p1", "Silla Tiffany", 5000, 100)));

        ToolResult result = service.execute("buscar_productos", args("{\"consulta\":\"sillas\"}"), GUEST);

        assertEquals(1, result.payload().path("productos").size());
        assertEquals(1, result.uiEvents().size());
        assertEquals(UiEvent.CARD, result.uiEvents().get(0).type());
        assertEquals("p1", result.uiEvents().get(0).data().path("id").asText());
    }

    @Test
    void cotizarCalculaDiasInclusivosYTotal() {
        when(productService.getProductById("p1"))
                .thenReturn(Optional.of(product("p1", "Silla Tiffany", 5000, 100)));
        when(reservationService.validateAvailability(any(Reservation.class))).thenReturn(Map.of());

        LocalDate inicio = LocalDate.now().plusDays(5);
        LocalDate fin = inicio.plusDays(2); // 3 días inclusivos
        String json = "{\"items\":[{\"productoId\":\"p1\",\"cantidad\":10}],"
                + "\"fechaInicio\":\"" + inicio + "\",\"fechaFin\":\"" + fin + "\"}";

        ToolResult result = service.execute("cotizar", args(json), GUEST);

        JsonNode payload = result.payload();
        assertEquals(3, payload.path("dias").asInt());
        assertEquals(0, payload.path("subtotal").decimalValue().compareTo(BigDecimal.valueOf(50000)));
        assertEquals(0, payload.path("total").decimalValue().compareTo(BigDecimal.valueOf(150000)));
        assertTrue(payload.path("puedeContinuar").asBoolean());
        assertEquals(1, result.uiEvents().size());
        assertEquals(UiEvent.QUOTE, result.uiEvents().get(0).type());
        assertEquals("/cotizacion", result.uiEvents().get(0).data().path("checkoutUrl").asText());
    }

    @Test
    void cotizarConStockInsuficienteNoPermiteContinuar() {
        when(productService.getProductById("p1"))
                .thenReturn(Optional.of(product("p1", "Silla Tiffany", 5000, 5)));
        when(reservationService.validateAvailability(any(Reservation.class)))
                .thenReturn(Map.of("p1", "solo hay 5 disponibles"));

        LocalDate inicio = LocalDate.now().plusDays(1);
        String json = "{\"items\":[{\"productoId\":\"p1\",\"cantidad\":50}],"
                + "\"fechaInicio\":\"" + inicio + "\",\"fechaFin\":\"" + inicio + "\"}";

        ToolResult result = service.execute("cotizar", args(json), GUEST);

        assertFalse(result.payload().path("puedeContinuar").asBoolean());
        assertEquals(1, result.payload().path("erroresStock").size());
        assertTrue(result.uiEvents().isEmpty());
    }

    @Test
    void cotizarRechazaMasDeSieteDias() {
        when(productService.getProductById("p1"))
                .thenReturn(Optional.of(product("p1", "Silla Tiffany", 5000, 100)));
        LocalDate inicio = LocalDate.now().plusDays(1);
        LocalDate fin = inicio.plusDays(10);
        String json = "{\"items\":[{\"productoId\":\"p1\",\"cantidad\":1}],"
                + "\"fechaInicio\":\"" + inicio + "\",\"fechaFin\":\"" + fin + "\"}";

        ToolResult result = service.execute("cotizar", args(json), GUEST);

        assertEquals(1, result.payload().path("errores").size());
    }

    @Test
    void verProductoInexistenteDevuelveError() {
        when(productService.getProductById("nope")).thenReturn(Optional.empty());

        ToolResult result = service.execute("ver_producto", args("{\"productoId\":\"nope\"}"), GUEST);

        assertTrue(result.payload().has("error"));
    }

    @Test
    void consultarDisponibilidadRestaReservas() {
        Product p = product("p1", "Mesa", 10000, 20);
        when(productService.getProductById("p1")).thenReturn(Optional.of(p));

        Reservation reserva = new Reservation();
        reserva.setFechaInicio(LocalDate.now().plusDays(1));
        reserva.setFechaFin(LocalDate.now().plusDays(2));
        Reservation.ItemReserva item = new Reservation.ItemReserva();
        item.setProductoId("p1");
        item.setCantidad(5);
        reserva.setItems(List.of(item));

        when(reservationService.getActiveReservationsByProductIds(anyList()))
                .thenReturn(List.of(reserva));

        LocalDate inicio = LocalDate.now().plusDays(1);
        LocalDate fin = LocalDate.now().plusDays(2);
        String json = "{\"productoIds\":[\"p1\"],\"fechaInicio\":\"" + inicio + "\",\"fechaFin\":\"" + fin + "\"}";

        ToolResult result = service.execute("consultar_disponibilidad", args(json), GUEST);

        assertEquals(15, result.payload().path("productos").get(0).path("disponibleEnFechas").asInt());
    }

    @Test
    void misReservasRequiereSesion() {
        ToolResult result = service.execute("mis_reservas", args("{}"), GUEST);

        assertTrue(result.payload().has("error"));
    }

    @Test
    void misReservasDevuelveReservasDelUsuario() {
        Reservation reserva = new Reservation();
        reserva.setId("r1");
        reserva.setUsuarioId(USER);
        reserva.setEstado("PENDIENTE");
        reserva.setTotal(BigDecimal.valueOf(200000));
        when(reservationService.getByUsuarioId(USER)).thenReturn(List.of(reserva));

        ToolResult result = service.execute("mis_reservas", args("{}"), AUTH);

        assertEquals(1, result.payload().path("reservas").size());
        assertEquals("r1", result.payload().path("reservas").get(0).path("id").asText());
    }

    @Test
    void estadoReservaDeOtroUsuarioNoSeMuestra() {
        Reservation reserva = new Reservation();
        reserva.setId("r1");
        reserva.setUsuarioId("otro");
        when(reservationService.getById("r1")).thenReturn(Optional.of(reserva));

        ToolResult result = service.execute("estado_reserva", args("{\"referencia\":\"r1\"}"), AUTH);

        assertTrue(result.payload().has("error"));
    }

    @Test
    void escalarGeneraEnlaceDeWhatsApp() {
        ToolResult result = service.execute("escalar_a_humano",
                args("{\"motivo\":\"queja\",\"resumen\":\"daño en una mesa\"}"), GUEST);

        String url = result.payload().path("whatsappUrl").asText();
        assertTrue(url.startsWith("https://wa.me/573105782442?text="));
        assertEquals(UiEvent.ESCALATION, result.uiEvents().get(0).type());
    }

    @Test
    void validarCuponDelegaEnElServicio() {
        when(couponService.validateCoupon(eq("FURENT10"), any(BigDecimal.class)))
                .thenReturn(Map.of("valido", true, "descuento", BigDecimal.valueOf(10000),
                        "montoFinal", BigDecimal.valueOf(90000), "mensaje", "ok"));

        ToolResult result = service.execute("validar_cupon",
                args("{\"codigo\":\"FURENT10\",\"subtotal\":100000}"), GUEST);

        assertTrue(result.payload().path("valido").asBoolean());
        assertEquals(0, result.payload().path("descuento").decimalValue().compareTo(BigDecimal.valueOf(10000)));
    }

    @Test
    void herramientaDesconocidaFalla() {
        when(toolDefinitions.exists("nope")).thenReturn(false);

        AssistantException ex = assertThrows(AssistantException.class,
                () -> service.execute("nope", args("{}"), GUEST));
        assertEquals(AssistantException.Code.INVALID_INPUT, ex.getCode());
    }

    @Test
    void informacionNegocioUsaLaBaseDeConocimiento() {
        when(knowledgeService.buscarTema("envios")).thenReturn("envios:\n  domicilio: se cotiza");

        ToolResult result = service.execute("informacion_negocio", args("{\"tema\":\"envios\"}"), GUEST);

        assertTrue(result.payload().path("informacion").asText().contains("domicilio"));
    }
}
