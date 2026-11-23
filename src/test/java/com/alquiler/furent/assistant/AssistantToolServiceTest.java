package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.Coupon;
import com.alquiler.furent.model.Payment;
import com.alquiler.furent.model.Product;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.repository.PaymentRepository;
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
    private PaymentRepository paymentRepository;
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
    @Mock
    private AssistantExtraToolService extraTools;

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
                couponService, knowledgeService, toolDefinitions, new AssistantSemanticSearch(productService),
                properties, metrics, mapper, paymentRepository, extraTools);
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
    void cotizarPropagaDatosDelEventoParaElCheckout() {
        when(productService.getProductById("p1"))
                .thenReturn(Optional.of(product("p1", "Silla Tiffany", 5000, 100)));
        when(reservationService.validateAvailability(any(Reservation.class))).thenReturn(Map.of());

        LocalDate inicio = LocalDate.now().plusDays(5);
        String json = "{\"items\":[{\"productoId\":\"p1\",\"cantidad\":10}],"
                + "\"fechaInicio\":\"" + inicio + "\",\"fechaFin\":\"" + inicio + "\","
                + "\"tipoEvento\":\"Boda\",\"invitados\":150,\"horaEntrega\":\"15:00\"}";

        ToolResult result = service.execute("cotizar", args(json), GUEST);

        JsonNode quote = result.uiEvents().get(0).data();
        assertEquals("Boda", quote.path("tipoEvento").asText());
        assertEquals("150", quote.path("invitados").asText());
        assertEquals("15:00", quote.path("horaEntrega").asText());
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

    // ───────────────────────── Bolsa ─────────────────────────

    @Test
    void miBolsaDevuelveItemsConPreciosRealesYEventoPanel() {
        ToolContext conBolsa = new ToolContext(USER, "session-1",
                List.of(new BagItem("p1", "Silla vieja", 3, BigDecimal.valueOf(1))));
        when(productService.getProductById("p1"))
                .thenReturn(Optional.of(product("p1", "Silla Tiffany", 5000, 100)));

        ToolResult result = service.execute("mi_bolsa", args("{}"), conBolsa);

        assertEquals(1, result.payload().path("items").size());
        assertEquals("Silla Tiffany", result.payload().path("items").get(0).path("nombre").asText());
        assertEquals(0, result.payload().path("totalDia").decimalValue()
                .compareTo(BigDecimal.valueOf(15000)));
        assertEquals(UiEvent.PANEL, result.uiEvents().get(0).type());
        assertEquals("bolsa", result.uiEvents().get(0).data().path("vista").asText());
    }

    @Test
    void editarBolsaEmiteEventoBag() {
        when(productService.getProductById("p1"))
                .thenReturn(Optional.of(product("p1", "Silla Tiffany", 5000, 100)));

        ToolResult result = service.execute("editar_bolsa",
                args("{\"operacion\":\"agregar\",\"items\":[{\"productoId\":\"p1\",\"cantidad\":4}]}"),
                GUEST);

        assertTrue(result.payload().path("ok").asBoolean());
        assertEquals("agregar", result.payload().path("operacion").asText());
        assertEquals(UiEvent.BAG, result.uiEvents().get(0).type());
        assertEquals(4, result.uiEvents().get(0).data().path("items").get(0).path("cantidad").asInt());
    }

    @Test
    void editarBolsaSinItemsEsErrorSalvoVaciar() {
        ToolResult sinItems = service.execute("editar_bolsa", args("{\"operacion\":\"agregar\"}"), GUEST);
        assertTrue(sinItems.payload().has("error"));

        ToolResult vaciar = service.execute("editar_bolsa", args("{\"operacion\":\"vaciar\"}"), GUEST);
        assertTrue(vaciar.payload().path("ok").asBoolean());
        assertEquals(UiEvent.BAG, vaciar.uiEvents().get(0).type());
    }

    // ───────────────────────── Recomendación y panel ─────────────────────────

    @Test
    void recomendarEventoEmitePanelConCantidades() {
        Product sillas = product("s1", "Silla Tiffany", 5000, 500);
        sillas.setCategoriaNombre("Sillas");
        Product mesas = product("m1", "Mesa Redonda", 20000, 50);
        mesas.setCategoriaNombre("Mesas");
        when(productService.searchProducts(anyString())).thenReturn(List.of(sillas, mesas));
        when(knowledgeService.buscarOcasion("boda")).thenReturn(List.of());

        ToolResult result = service.execute("recomendar_evento",
                args("{\"tipoEvento\":\"boda\",\"invitados\":80,\"estilo\":\"elegante\"}"), GUEST);

        assertEquals(80, result.payload().path("invitados").asInt());
        assertTrue(result.payload().path("totalEstimado").decimalValue().compareTo(BigDecimal.ZERO) > 0);
        assertTrue(result.payload().path("items").size() >= 1);
        assertEquals(UiEvent.PANEL, result.uiEvents().get(0).type());
        assertEquals("recomendacion", result.uiEvents().get(0).data().path("vista").asText());
    }

    @Test
    void pedirDatosEventoEmitePanelDeFormulario() {
        ToolResult result = service.execute("pedir_datos_evento", args("{}"), GUEST);

        assertTrue(result.payload().path("ok").asBoolean());
        assertEquals(UiEvent.PANEL, result.uiEvents().get(0).type());
        JsonNode data = result.uiEvents().get(0).data();
        assertEquals("form", data.path("vista").asText());
        assertTrue(data.path("fields").size() >= 6);
    }

    @Test
    void pedirDetallesAlquilerEmitePanelDeDetalles() {
        ToolResult result = service.execute("pedir_detalles_alquiler", args("{}"), GUEST);

        assertTrue(result.payload().path("ok").asBoolean());
        assertEquals(UiEvent.PANEL, result.uiEvents().get(0).type());
        JsonNode data = result.uiEvents().get(0).data();
        assertEquals("detalles", data.path("vista").asText());
        assertEquals("Detalles del alquiler", data.path("titulo").asText());
    }

    @Test
    void pedirDetallesAlquilerPrecargaDatosConocidos() {
        ObjectNode input = args("{\"tipoEvento\":\"Boda\",\"invitados\":120,\"horaEntrega\":\"15:00\","
                + "\"fechaInicio\":\"2026-12-01\",\"fechaFin\":\"2026-12-03\"}");

        ToolResult result = service.execute("pedir_detalles_alquiler", input, GUEST);

        JsonNode fields = result.uiEvents().get(0).data().path("fields");
        String tipo = null;
        String invitados = null;
        String hora = null;
        String inicio = null;
        String fin = null;
        for (JsonNode field : fields) {
            switch (field.path("name").asText()) {
                case "tipoEvento" -> tipo = field.path("value").asText();
                case "invitados" -> invitados = field.path("value").asText();
                case "horaEntrega" -> hora = field.path("value").asText();
                case "fechaInicio" -> inicio = field.path("value").asText();
                case "fechaFin" -> fin = field.path("value").asText();
                default -> { }
            }
        }
        assertEquals("Boda", tipo);
        assertEquals("120", invitados);
        assertEquals("15:00", hora);
        assertEquals("2026-12-01", inicio);
        assertEquals("2026-12-03", fin);
    }

    @Test
    void listarCuponesDevuelveVigentesConDescuento() {
        Coupon cupon = new Coupon();
        cupon.setCodigo("BIENVENIDA10");
        cupon.setTipo("PORCENTAJE");
        cupon.setValor(BigDecimal.valueOf(10));
        cupon.setMontoMinimo(BigDecimal.valueOf(300000));
        cupon.setActivo(true);
        when(couponService.getAll()).thenReturn(List.of(cupon));

        ToolResult result = service.execute("listar_cupones", args("{\"montoTotal\":1000000}"), GUEST);

        JsonNode cupones = result.payload().path("cupones");
        assertEquals(1, cupones.size());
        assertEquals("BIENVENIDA10", cupones.get(0).path("codigo").asText());
        assertEquals(0, cupones.get(0).path("descuento").decimalValue()
                .compareTo(BigDecimal.valueOf(100000)));
    }

    @Test
    void consultarAlquilerRequiereSesion() {
        ToolResult result = service.execute("consultar_alquiler", args("{}"), GUEST);

        assertTrue(result.payload().has("error"));
    }

    @Test
    void consultarAlquilerDevuelvePagosYLineaDeTiempo() {
        Reservation reserva = new Reservation();
        reserva.setId("r1");
        reserva.setUsuarioId(USER);
        reserva.setEstado("CONFIRMADA");
        reserva.setFechaInicio(LocalDate.now().plusDays(2));
        reserva.setFechaFin(LocalDate.now().plusDays(3));
        reserva.setTotal(BigDecimal.valueOf(200000));
        reserva.setMontoAbonado(BigDecimal.valueOf(50000));
        reserva.setEstadoPago("ABONO");
        when(reservationService.getById("r1")).thenReturn(Optional.of(reserva));

        Payment pago = new Payment();
        pago.setMonto(BigDecimal.valueOf(50000));
        pago.setMetodoPago("TARJETA");
        pago.setEstado("APROBADO");
        pago.setTipoPago("ANTICIPO");
        when(paymentRepository.findByReservaId("r1")).thenReturn(List.of(pago));

        ToolResult result = service.execute("consultar_alquiler", args("{\"referencia\":\"r1\"}"), AUTH);

        JsonNode detalle = result.payload().path("reserva");
        assertEquals("r1", detalle.path("id").asText());
        assertEquals(1, detalle.path("pagos").size());
        assertEquals("APROBADO", detalle.path("pagos").get(0).path("estado").asText());
        assertEquals(4, detalle.path("timeline").size());
        assertEquals(UiEvent.RESERVATION, result.uiEvents().get(0).type());
    }
}
