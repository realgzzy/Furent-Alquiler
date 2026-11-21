package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.Category;
import com.alquiler.furent.model.Combo;
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
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Implementación de las herramientas del asistente.
 *
 * Todas las herramientas son de solo lectura salvo {@code escalar_a_humano}, que solo marca
 * la conversación. Los precios y el stock siempre provienen de la base de datos.
 */
@Service
public class AssistantToolService {

    private static final Logger log = LoggerFactory.getLogger(AssistantToolService.class);
    private static final int MAX_PRODUCTOS = 6;
    private static final int MAX_IDS_DISPONIBILIDAD = 10;
    private static final long MAX_DIAS_ALQUILER = 7;

    private final ProductService productService;
    private final ReservationService reservationService;
    private final ReservationRepository reservationRepository;
    private final CouponService couponService;
    private final AssistantKnowledgeService knowledgeService;
    private final AssistantToolDefinitions toolDefinitions;
    private final AssistantSemanticSearch semanticSearch;
    private final AssistantProperties properties;
    private final AssistantMetrics metrics;
    private final ObjectMapper mapper;
    private final PaymentRepository paymentRepository;

    public AssistantToolService(ProductService productService,
                                ReservationService reservationService,
                                ReservationRepository reservationRepository,
                                CouponService couponService,
                                AssistantKnowledgeService knowledgeService,
                                AssistantToolDefinitions toolDefinitions,
                                AssistantSemanticSearch semanticSearch,
                                AssistantProperties properties,
                                AssistantMetrics metrics,
                                ObjectMapper mapper,
                                PaymentRepository paymentRepository) {
        this.productService = productService;
        this.reservationService = reservationService;
        this.reservationRepository = reservationRepository;
        this.couponService = couponService;
        this.knowledgeService = knowledgeService;
        this.toolDefinitions = toolDefinitions;
        this.semanticSearch = semanticSearch;
        this.properties = properties;
        this.metrics = metrics;
        this.mapper = mapper;
        this.paymentRepository = paymentRepository;
    }

    public ToolResult execute(String name, JsonNode rawArgs, ToolContext context) {
        JsonNode args = rawArgs == null || rawArgs.isNull() ? mapper.createObjectNode() : rawArgs;
        if (!toolDefinitions.exists(name)) {
            throw new AssistantException(AssistantException.Code.INVALID_INPUT,
                    "Herramienta desconocida: " + name);
        }
        try {
            ToolResult result = dispatch(name, args, context);
            metrics.toolCall(name, "ok");
            return result;
        } catch (AssistantException e) {
            metrics.toolCall(name, "error");
            throw e;
        } catch (RuntimeException e) {
            metrics.toolCall(name, "error");
            log.warn("Error ejecutando la herramienta {}: {}", name, e.getMessage());
            throw AssistantException.internal("No se pudo ejecutar la herramienta " + name, e);
        }
    }

    private ToolResult dispatch(String name, JsonNode args, ToolContext context) {
        return switch (name) {
            case "buscar_productos" -> buscarProductos(args);
            case "ver_producto" -> verProducto(args);
            case "listar_categorias" -> listarCategorias();
            case "consultar_disponibilidad" -> consultarDisponibilidad(args);
            case "cotizar" -> cotizar(args);
            case "validar_cupon" -> validarCupon(args);
            case "informacion_negocio" -> informacionNegocio(args);
            case "mis_reservas" -> misReservas(args, context);
            case "estado_reserva" -> estadoReserva(args, context);
            case "mi_bolsa" -> miBolsa(context);
            case "editar_bolsa" -> editarBolsa(args);
            case "recomendar_evento" -> recomendarEvento(args);
            case "pedir_datos_evento" -> pedirDatosEvento();
            case "consultar_alquiler" -> consultarAlquiler(args, context);
            case "escalar_a_humano" -> escalarAHumano(args, context);
            default -> throw new AssistantException(AssistantException.Code.INVALID_INPUT,
                    "Herramienta desconocida: " + name);
        };
    }

    // ───────────────────────── Catálogo ─────────────────────────

    private ToolResult buscarProductos(JsonNode args) {
        String consulta = text(args, "consulta");
        String categoria = text(args, "categoria");
        String ocasion = text(args, "ocasion");
        BigDecimal precioMaximo = decimal(args, "precioMaximo");
        int limite = (int) Math.min(Math.max(args.path("limite").asInt(MAX_PRODUCTOS), 1), MAX_PRODUCTOS);

        Map<String, Product> encontrados = new LinkedHashMap<>();
        if (!consulta.isBlank()) {
            // Búsqueda híbrida: primero semántica (conceptos), luego literal (regex exacta).
            addAll(encontrados, semanticSearch.search(consulta, limite * 2));
            addAll(encontrados, productService.searchProducts(consulta));
        }
        if (!categoria.isBlank()) {
            addAll(encontrados, productService.getProductsByCategory(categoria));
        }
        if (!ocasion.isBlank()) {
            for (String palabra : knowledgeService.buscarOcasion(ocasion)) {
                addAll(encontrados, productService.searchProducts(palabra));
            }
        }
        if (consulta.isBlank() && categoria.isBlank() && ocasion.isBlank()) {
            addAll(encontrados, productService.getFeaturedProducts());
            if (encontrados.size() < limite) {
                addAll(encontrados, productService.getAllProducts());
            }
        }

        List<Product> seleccionados = encontrados.values().stream()
                .filter(Product::isDisponible)
                .filter(p -> precioMaximo == null || (p.getPrecioPorDia() != null
                        && p.getPrecioPorDia().compareTo(precioMaximo) <= 0))
                .limit(limite)
                .toList();

        ObjectNode payload = mapper.createObjectNode();
        ArrayNode productos = payload.putArray("productos");
        List<UiEvent> events = new ArrayList<>();
        for (Product p : seleccionados) {
            productos.add(productoResumen(p));
            events.add(new UiEvent(UiEvent.CARD, productoCard(p)));
        }
        if (seleccionados.isEmpty()) {
            payload.put("nota", "No se encontraron productos con esos criterios. "
                    + "Ofrece alternativas o pide menos filtros.");
        }
        return ToolResult.of(payload, events);
    }

    private ToolResult verProducto(JsonNode args) {
        String id = text(args, "productoId");
        ObjectNode payload = mapper.createObjectNode();
        if (id.isBlank()) {
            payload.put("error", "Falta el ID del producto.");
            return ToolResult.of(payload);
        }
        Optional<Product> product = productService.getProductById(id);
        if (product.isEmpty()) {
            payload.put("error", "El producto no existe en el catálogo.");
            return ToolResult.of(payload);
        }
        Product p = product.get();
        ObjectNode detalle = payload.putObject("producto");
        detalle.put("id", p.getId());
        detalle.put("nombre", p.getNombre());
        detalle.put("descripcion", p.getDescripcion());
        detalle.put("descripcionCorta", p.getDescripcionCorta());
        detalle.put("categoria", p.getCategoriaNombre());
        detalle.put("precioDia", p.getPrecioPorDia());
        detalle.put("material", p.getMaterial());
        detalle.put("dimensiones", p.getDimensiones());
        detalle.put("color", p.getColor());
        detalle.put("stock", p.getStock());
        detalle.put("cantidadMinima", p.getCantidadMinima());
        detalle.put("cantidadMaxima", p.getCantidadMaxima());
        detalle.put("disponible", p.isDisponible());
        detalle.put("calificacion", p.getCalificacion());
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.CARD, productoCard(p))));
    }

    private ToolResult listarCategorias() {
        ObjectNode payload = mapper.createObjectNode();
        ArrayNode categorias = payload.putArray("categorias");
        for (Category c : productService.getAllCategories()) {
            ObjectNode node = categorias.addObject();
            node.put("nombre", c.getNombre());
            node.put("descripcion", c.getDescripcion());
            node.put("cantidadProductos", c.getCantidadProductos());
        }
        ArrayNode combos = payload.putArray("combos");
        List<UiEvent> events = new ArrayList<>();
        for (Combo combo : productService.getActiveCombos()) {
            ObjectNode node = combos.addObject();
            node.put("id", combo.getId());
            node.put("nombre", combo.getNombre());
            node.put("descripcion", combo.getDescripcion());
            node.put("precioCombo", combo.getPrecioCombo());
            node.put("porcentajeDescuento", combo.getPorcentajeDescuento());
            events.add(new UiEvent(UiEvent.CARD, comboCard(combo)));
        }
        return ToolResult.of(payload, events);
    }

    // ───────────────────────── Disponibilidad ─────────────────────────

    private ToolResult consultarDisponibilidad(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        List<String> errores = new ArrayList<>();

        List<String> ids = new ArrayList<>();
        JsonNode idsNode = args.path("productoIds");
        if (idsNode.isArray()) {
            for (JsonNode idNode : idsNode) {
                String id = idNode.asText("").trim();
                if (!id.isEmpty() && !ids.contains(id)) {
                    ids.add(id);
                }
                if (ids.size() >= MAX_IDS_DISPONIBILIDAD) {
                    break;
                }
            }
        }
        LocalDate inicio = fecha(args, "fechaInicio", errores);
        LocalDate fin = fecha(args, "fechaFin", errores);
        validarRango(inicio, fin, errores);

        if (ids.isEmpty()) {
            errores.add("Debes indicar al menos un producto.");
        }

        if (!errores.isEmpty()) {
            ArrayNode err = payload.putArray("errores");
            errores.forEach(err::add);
            return ToolResult.of(payload);
        }

        payload.put("fechaInicio", inicio.toString());
        payload.put("fechaFin", fin.toString());
        ArrayNode productos = payload.putArray("productos");
        List<UiEvent> events = new ArrayList<>();

        List<Reservation> activas = reservationService.getActiveReservationsByProductIds(ids);
        for (String id : ids) {
            Optional<Product> productOpt = productService.getProductById(id);
            if (productOpt.isEmpty()) {
                ObjectNode node = productos.addObject();
                node.put("productoId", id);
                node.put("error", "Producto no encontrado.");
                continue;
            }
            Product p = productOpt.get();
            int disponibles = calcularDisponible(p, inicio, fin, activas);
            ObjectNode node = productos.addObject();
            node.put("productoId", p.getId());
            node.put("nombre", p.getNombre());
            node.put("stockTotal", p.getStock());
            node.put("disponibleEnFechas", disponibles);
            if (!p.isDisponible() || "EN_REPARACION".equals(p.getEstadoMantenimiento())) {
                node.put("nota", "El producto no está disponible para alquiler.");
            }
            events.add(new UiEvent(UiEvent.CARD, productoCard(p).put("stockDisponible", disponibles)));
        }
        payload.put("nota", "La disponibilidad no bloquea el inventario hasta confirmar y pagar.");
        return ToolResult.of(payload, events);
    }

    // ───────────────────────── Cotización ─────────────────────────

    private ToolResult cotizar(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        List<String> errores = new ArrayList<>();

        LocalDate inicio = fecha(args, "fechaInicio", errores);
        LocalDate fin = fecha(args, "fechaFin", errores);
        validarRango(inicio, fin, errores);

        // Items
        List<ItemCotizacion> items = new ArrayList<>();
        JsonNode itemsNode = args.path("items");
        if (!itemsNode.isArray() || itemsNode.isEmpty()) {
            errores.add("Tu bolsa está vacía. Agrega al menos un producto para poder cotizarlo.");
        } else {
            for (JsonNode itemNode : itemsNode) {
                String id = itemNode.path("productoId").asText("").trim();
                int cantidad = itemNode.path("cantidad").asInt(0);
                if (cantidad <= 0) {
                    errores.add("Las cantidades deben ser mayores a cero. ¿Cuántas unidades necesitas?");
                    continue;
                }
                Optional<Product> productOpt = productService.getProductById(id);
                if (productOpt.isEmpty()) {
                    errores.add("Uno de los productos ya no está en el catálogo. ¿Quieres que busque alternativas?");
                    continue;
                }
                items.add(new ItemCotizacion(productOpt.get(), cantidad));
            }
        }

        if (!errores.isEmpty()) {
            ArrayNode err = payload.putArray("errores");
            errores.forEach(err::add);
            return ToolResult.of(payload);
        }

        long dias = ChronoUnit.DAYS.between(inicio, fin) + 1;

        Reservation reserva = new Reservation();
        reserva.setFechaInicio(inicio);
        reserva.setFechaFin(fin);
        List<Reservation.ItemReserva> itemEntities = new ArrayList<>();
        BigDecimal subtotal = BigDecimal.ZERO;
        for (ItemCotizacion item : items) {
            Product p = item.producto();
            Reservation.ItemReserva entity = new Reservation.ItemReserva();
            entity.setProductoId(p.getId());
            entity.setProductoNombre(p.getNombre());
            entity.setProductoImagen(p.getImagenUrl());
            entity.setPrecioPorDia(p.getPrecioPorDia());
            entity.setCantidad(item.cantidad());
            BigDecimal linea = p.getPrecioPorDia().multiply(BigDecimal.valueOf(item.cantidad()));
            entity.setSubtotal(linea);
            itemEntities.add(entity);
            subtotal = subtotal.add(linea);
        }
        reserva.setItems(itemEntities);

        Map<String, String> disponibilidad = reservationService.validateAvailability(reserva);
        BigDecimal totalBruto = subtotal.multiply(BigDecimal.valueOf(dias));

        BigDecimal descuento = BigDecimal.ZERO;
        String avisoCupon = null;
        String codigoCupon = text(args, "codigoCupon");
        if (!codigoCupon.isEmpty()) {
            Map<String, Object> cupon = couponService.validateCoupon(codigoCupon, totalBruto);
            if (Boolean.TRUE.equals(cupon.get("valido")) && cupon.get("descuento") instanceof BigDecimal d) {
                descuento = d;
            } else {
                avisoCupon = String.valueOf(cupon.getOrDefault("mensaje", "El cupón no es válido."));
            }
        }
        BigDecimal total = totalBruto.subtract(descuento);

        payload.put("moneda", "COP");
        payload.put("dias", dias);
        payload.put("subtotal", subtotal);
        payload.put("totalBruto", totalBruto);
        payload.put("descuento", descuento);
        payload.put("total", total);
        if (avisoCupon != null) {
            payload.put("avisoCupon", avisoCupon);
        }
        ArrayNode itemsPayload = payload.putArray("items");
        for (Reservation.ItemReserva item : itemEntities) {
            ObjectNode node = itemsPayload.addObject();
            node.put("productoId", item.getProductoId());
            node.put("nombre", item.getProductoNombre());
            node.put("cantidad", item.getCantidad());
            node.put("precioDia", item.getPrecioPorDia());
            node.put("subtotal", item.getSubtotal());
        }
        if (!disponibilidad.isEmpty()) {
            ArrayNode err = payload.putArray("erroresStock");
            disponibilidad.values().forEach(err::add);
            payload.put("puedeContinuar", false);
            payload.put("mensaje", "Para esas fechas no alcanza el stock de algunos productos. "
                    + "Puedes ajustar las cantidades, cambiar las fechas o hablar con un asesor.");
            return ToolResult.of(payload);
        }

        payload.put("puedeContinuar", true);
        payload.put("nota", "La disponibilidad no bloquea el inventario hasta confirmar y pagar. "
                + "Máximo " + MAX_DIAS_ALQUILER + " días por alquiler.");

        ObjectNode quoteData = mapper.createObjectNode();
        ArrayNode quoteItems = quoteData.putArray("items");
        for (Reservation.ItemReserva item : itemEntities) {
            ObjectNode node = quoteItems.addObject();
            node.put("id", item.getProductoId());
            node.put("nombre", item.getProductoNombre());
            node.put("imagen", item.getProductoImagen());
            node.put("precioDia", item.getPrecioPorDia());
            node.put("cantidad", item.getCantidad());
            node.put("subtotal", item.getSubtotal());
        }
        quoteData.put("dias", dias);
        quoteData.put("fechaInicio", inicio.toString());
        quoteData.put("fechaFin", fin.toString());
        quoteData.put("subtotal", subtotal);
        quoteData.put("descuento", descuento);
        quoteData.put("total", total);
        quoteData.put("checkoutUrl", "/cotizacion");
        quoteData.put("puedeContinuar", true);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.QUOTE, quoteData)));
    }

    // ───────────────────────── Cupones y negocio ─────────────────────────

    private ToolResult validarCupon(JsonNode args) {
        String codigo = text(args, "codigo");
        BigDecimal subtotal = decimal(args, "subtotal");
        ObjectNode payload = mapper.createObjectNode();
        if (codigo.isBlank() || subtotal == null) {
            payload.put("error", "Necesito el código del cupón y el subtotal para validarlo.");
            return ToolResult.of(payload);
        }
        Map<String, Object> result = couponService.validateCoupon(codigo, subtotal);
        payload.put("valido", Boolean.TRUE.equals(result.get("valido")));
        if (result.get("descuento") != null) {
            payload.put("descuento", (BigDecimal) result.get("descuento"));
        }
        if (result.get("montoFinal") != null) {
            payload.put("totalConDescuento", (BigDecimal) result.get("montoFinal"));
        }
        payload.put("mensaje", String.valueOf(result.getOrDefault("mensaje", "")));
        return ToolResult.of(payload);
    }

    private ToolResult informacionNegocio(JsonNode args) {
        String tema = text(args, "tema");
        String info = knowledgeService.buscarTema(tema);
        ObjectNode payload = mapper.createObjectNode();
        payload.put("tema", tema);
        if (info.isBlank()) {
            payload.put("informacion", "No tengo una política específica para ese tema. "
                    + "Puedo ayudarte con envíos, pagos, garantía, cancelaciones, montaje o horarios.");
        } else {
            payload.put("informacion", info);
        }
        return ToolResult.of(payload);
    }

    // ───────────────────────── Reservas del usuario ─────────────────────────

    private ToolResult misReservas(JsonNode args, ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        if (!context.authenticated()) {
            payload.put("error", "El usuario debe iniciar sesión para ver sus reservas.");
            return ToolResult.of(payload);
        }
        String estado = text(args, "estado").toUpperCase(Locale.ROOT);
        List<Reservation> reservas = estado.isBlank()
                ? reservationService.getByUsuarioId(context.userId())
                : reservationService.getByUsuarioId(context.userId()).stream()
                        .filter(r -> estado.equals(r.getEstado()))
                        .toList();

        ArrayNode array = payload.putArray("reservas");
        reservas.stream().limit(10).forEach(r -> array.add(reservaResumen(r)));
        if (array.isEmpty()) {
            payload.put("nota", "El usuario no tiene reservas con ese criterio.");
        }
        return ToolResult.of(payload);
    }

    private ToolResult estadoReserva(JsonNode args, ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        if (!context.authenticated()) {
            payload.put("error", "El usuario debe iniciar sesión para consultar una reserva.");
            return ToolResult.of(payload);
        }
        String referencia = text(args, "referencia");
        if (referencia.isBlank()) {
            payload.put("error", "Falta la referencia de la reserva.");
            return ToolResult.of(payload);
        }
        Optional<Reservation> reservaOpt = reservationService.getById(referencia);
        if (reservaOpt.isEmpty()) {
            reservaOpt = reservationRepository.findByCodigoPagoEfectivo(referencia);
        }
        if (reservaOpt.isEmpty() || !context.userId().equals(reservaOpt.get().getUsuarioId())) {
            payload.put("error", "No encontré una reserva tuya con esa referencia.");
            return ToolResult.of(payload);
        }
        payload.set("reserva", reservaResumen(reservaOpt.get()));
        return ToolResult.of(payload);
    }

    // ───────────────────────── Bolsa ─────────────────────────

    private ToolResult miBolsa(ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        ArrayNode items = payload.putArray("items");
        BigDecimal totalDia = BigDecimal.ZERO;
        for (BagItem item : context.bag()) {
            Optional<Product> productOpt = productService.getProductById(item.id());
            ObjectNode node = items.addObject();
            node.put("id", item.id());
            node.put("nombre", productOpt.map(Product::getNombre).orElse(item.nombre()));
            node.put("cantidad", item.cantidad());
            BigDecimal precio = productOpt.map(Product::getPrecioPorDia).orElse(item.precioDia());
            if (precio != null) {
                node.put("precioDia", precio);
                totalDia = totalDia.add(precio.multiply(BigDecimal.valueOf(item.cantidad())));
            }
            productOpt.ifPresent(p -> {
                node.put("imagen", p.getImagenUrl());
                node.put("stock", p.getStock());
            });
        }
        payload.put("totalDia", totalDia);
        if (items.isEmpty()) {
            payload.put("nota", "La bolsa del usuario está vacía.");
        }
        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "bolsa");
        data.put("titulo", "Tu bolsa");
        data.put("totalDia", totalDia);
        data.set("items", items.deepCopy());
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ToolResult editarBolsa(JsonNode args) {
        String operacion = text(args, "operacion").toLowerCase(Locale.ROOT);
        if (operacion.isBlank()) {
            operacion = "agregar";
        }
        ObjectNode payload = mapper.createObjectNode();
        ObjectNode data = mapper.createObjectNode();
        data.put("operacion", operacion);
        ArrayNode items = data.putArray("items");

        JsonNode itemsNode = args.path("items");
        if (itemsNode.isArray()) {
            for (JsonNode itemNode : itemsNode) {
                String id = itemNode.path("productoId").asText("");
                if (id.isBlank()) {
                    id = itemNode.path("id").asText("");
                }
                id = id.trim();
                if (id.isEmpty()) {
                    continue;
                }
                ObjectNode node = items.addObject();
                node.put("id", id);
                node.put("cantidad", Math.max(1, itemNode.path("cantidad").asInt(1)));
                productService.getProductById(id).ifPresent(p -> {
                    node.put("nombre", p.getNombre());
                    node.put("imagen", p.getImagenUrl());
                    node.put("precioDia", p.getPrecioPorDia());
                    node.put("stock", p.getStock());
                });
            }
        }
        if (!"vaciar".equals(operacion) && items.isEmpty()) {
            payload.put("error", "Indica al menos un producto y su cantidad.");
            return ToolResult.of(payload);
        }
        payload.put("ok", true);
        payload.put("operacion", operacion);
        payload.set("items", items.deepCopy());
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.BAG, data)));
    }

    // ───────────────────────── Recomendación por evento ─────────────────────────

    private ToolResult recomendarEvento(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        String tipo = text(args, "tipoEvento");
        String estilo = text(args, "estilo");
        int invitados = args.path("invitados").asInt(0);
        BigDecimal presupuesto = decimal(args, "presupuesto");
        LocalDate inicio = parseFechaOpcional(text(args, "fechaInicio"));
        LocalDate fin = parseFechaOpcional(text(args, "fechaFin"));
        long dias = (inicio != null && fin != null && !fin.isBefore(inicio))
                ? ChronoUnit.DAYS.between(inicio, fin) + 1 : 1;
        if (invitados <= 0) {
            invitados = 30;
            payload.put("nota", "No se indicó el número de invitados; se asumieron 30.");
        }
        final int mesas = Math.max(1, (int) Math.ceil(invitados / 8.0));

        List<String> terminos = new ArrayList<>();
        terminos.add("sillas");
        terminos.add("mesas");
        terminos.addAll(estiloTerminos(estilo));
        if (!tipo.isBlank()) {
            terminos.addAll(knowledgeService.buscarOcasion(tipo));
        }

        Map<String, Product> candidatos = new LinkedHashMap<>();
        for (String termino : terminos) {
            if (termino != null && !termino.isBlank()) {
                addAll(candidatos, productService.searchProducts(termino));
            }
        }
        List<Product> disponibles = candidatos.values().stream()
                .filter(Product::isDisponible)
                .filter(p -> p.getPrecioPorDia() != null)
                .toList();

        Map<String, Product> porCategoria = new LinkedHashMap<>();
        for (Product p : disponibles) {
            String cat = p.getCategoriaNombre() == null ? "otros" : p.getCategoriaNombre();
            porCategoria.putIfAbsent(cat, p);
        }
        if (porCategoria.isEmpty()) {
            addAll(candidatos, productService.getFeaturedProducts());
            for (Product p : candidatos.values()) {
                if (p.isDisponible() && p.getPrecioPorDia() != null) {
                    porCategoria.putIfAbsent(p.getId(), p);
                }
            }
        }
        List<Product> seleccion = new ArrayList<>(porCategoria.values());
        if (seleccion.size() > MAX_PRODUCTOS) {
            seleccion = seleccion.subList(0, MAX_PRODUCTOS);
        }
        if (seleccion.isEmpty()) {
            payload.put("error", "No encontré mobiliario para recomendar. Ofrece alternativas o WhatsApp.");
            return ToolResult.of(payload);
        }

        List<Recomendacion> plan = new ArrayList<>();
        for (Product p : seleccion) {
            plan.add(new Recomendacion(p, cantidadPorCategoria(p.getCategoriaNombre(), invitados, mesas)));
        }
        BigDecimal total = totalPlan(plan, dias);
        if (presupuesto != null && presupuesto.compareTo(BigDecimal.ZERO) > 0) {
            total = reducirPorPresupuesto(plan, dias, presupuesto);
        }

        ArrayNode items = payload.putArray("items");
        for (Recomendacion rec : plan) {
            ObjectNode node = items.addObject();
            node.put("productoId", rec.producto().getId());
            node.put("nombre", rec.producto().getNombre());
            node.put("cantidad", rec.cantidad());
            node.put("precioDia", rec.producto().getPrecioPorDia());
            node.put("subtotalDia", rec.producto().getPrecioPorDia().multiply(BigDecimal.valueOf(rec.cantidad())));
        }
        payload.put("tipoEvento", tipo);
        payload.put("invitados", invitados);
        if (!estilo.isBlank()) {
            payload.put("estilo", estilo);
        }
        payload.put("dias", dias);
        payload.put("totalEstimado", total);
        if (presupuesto != null) {
            payload.put("presupuesto", presupuesto);
        }
        payload.put("nota", "Los precios son reales; la disponibilidad se confirma al cotizar y pagar.");

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "recomendacion");
        data.put("titulo", tipo.isBlank() ? "Recomendación para tu evento" : "Recomendación: " + tipo);
        data.put("invitados", invitados);
        if (!estilo.isBlank()) {
            data.put("estilo", estilo);
        }
        data.put("dias", dias);
        data.put("totalEstimado", total);
        if (presupuesto != null) {
            data.put("presupuesto", presupuesto);
        }
        ArrayNode dataItems = data.putArray("items");
        for (Recomendacion rec : plan) {
            ObjectNode node = dataItems.addObject();
            node.put("id", rec.producto().getId());
            node.put("nombre", rec.producto().getNombre());
            node.put("imagen", rec.producto().getImagenUrl());
            node.put("precioDia", rec.producto().getPrecioPorDia());
            node.put("cantidad", rec.cantidad());
            node.put("subtotalDia", rec.producto().getPrecioPorDia().multiply(BigDecimal.valueOf(rec.cantidad())));
        }
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private List<String> estiloTerminos(String estilo) {
        String e = estilo == null ? "" : estilo.toLowerCase(Locale.ROOT);
        if (e.contains("modern")) {
            return List.of("ghost", "cristal");
        }
        if (e.contains("rust") || e.contains("madera")) {
            return List.of("madera");
        }
        if (e.contains("elegant")) {
            return List.of("tiffany", "imperial");
        }
        if (e.contains("minimal")) {
            return List.of("minimalista");
        }
        return List.of();
    }

    private int cantidadPorCategoria(String categoria, int invitados, int mesas) {
        String c = categoria == null ? "" : categoria.toLowerCase(Locale.ROOT);
        if (c.contains("silla")) {
            return invitados;
        }
        if (c.contains("mesa") || c.contains("mantel")) {
            return mesas;
        }
        if (c.contains("carpa")) {
            return Math.max(1, (int) Math.ceil(mesas / 4.0));
        }
        if (c.contains("arco") || c.contains("tarima") || c.contains("pasarela") || c.contains("centro")) {
            return 1;
        }
        if (c.contains("decor") || c.contains("globo")) {
            return Math.max(1, mesas);
        }
        return mesas;
    }

    private BigDecimal totalPlan(List<Recomendacion> plan, long dias) {
        BigDecimal total = BigDecimal.ZERO;
        long factor = Math.max(1, dias);
        for (Recomendacion r : plan) {
            total = total.add(r.producto().getPrecioPorDia()
                    .multiply(BigDecimal.valueOf(r.cantidad()))
                    .multiply(BigDecimal.valueOf(factor)));
        }
        return total;
    }

    private BigDecimal reducirPorPresupuesto(List<Recomendacion> plan, long dias, BigDecimal presupuesto) {
        BigDecimal total = totalPlan(plan, dias);
        for (int i = plan.size() - 1; i >= 0 && total.compareTo(presupuesto) > 0; i--) {
            Product p = plan.get(i).producto();
            String cat = p.getCategoriaNombre() == null ? "" : p.getCategoriaNombre().toLowerCase(Locale.ROOT);
            boolean esencial = cat.contains("silla") || cat.contains("mesa") || cat.contains("mantel");
            if (!esencial) {
                plan.remove(i);
                total = totalPlan(plan, dias);
            }
        }
        if (total.compareTo(presupuesto) > 0 && !plan.isEmpty()) {
            double factor = presupuesto.doubleValue() / total.doubleValue();
            for (int j = 0; j < plan.size(); j++) {
                Recomendacion r = plan.get(j);
                int nueva = Math.max(1, (int) Math.floor(r.cantidad() * factor));
                plan.set(j, new Recomendacion(r.producto(), nueva));
            }
            total = totalPlan(plan, dias);
        }
        return total;
    }

    // ───────────────────────── Formulario y seguimiento (panel lateral) ─────────────────────────

    private ToolResult pedirDatosEvento() {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("ok", true);
        payload.put("nota", "Se mostró el formulario del evento en el panel lateral. Espera el mensaje "
                + "\"Datos de mi evento: ...\" y luego recomienda con \"recomendar_evento\".");

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "form");
        data.put("titulo", "Cuéntame de tu evento");
        data.put("descripcion", "Con estos datos te recomiendo el mobiliario ideal.");
        data.put("submitLabel", "Recomendar mobiliario");
        ArrayNode fields = data.putArray("fields");
        fields.add(selectField("tipoEvento", "Tipo de evento", true,
                "boda", "Boda", "cumpleanos", "Cumpleaños", "corporativo", "Evento corporativo",
                "grado", "Grado", "baby_shower", "Baby shower", "otro", "Otro"));
        fields.add(numberField("invitados", "Número de personas", true, "120"));
        fields.add(selectField("estilo", "Estilo", false,
                "elegante", "Elegante", "moderno", "Moderno", "rustico", "Rústico", "minimalista", "Minimalista"));
        fields.add(numberField("presupuesto", "Presupuesto aproximado (COP)", false, "3000000"));
        fields.add(dateField("fechaInicio", "Desde", false));
        fields.add(dateField("fechaFin", "Hasta", false));
        fields.add(timeField("horaEvento", "Hora del evento", true));
        fields.add(textareaField("nota", "Nota (opcional)", false, "Ej: colores, temática, requerimientos especiales"));
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ToolResult consultarAlquiler(JsonNode args, ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        if (!context.authenticated()) {
            payload.put("error", "El usuario debe iniciar sesión para consultar sus alquileres.");
            return ToolResult.of(payload);
        }
        String referencia = text(args, "referencia");
        if (!referencia.isBlank()) {
            Optional<Reservation> reservaOpt = reservationService.getById(referencia);
            if (reservaOpt.isEmpty()) {
                reservaOpt = reservationRepository.findByCodigoPagoEfectivo(referencia);
            }
            if (reservaOpt.isEmpty() || !context.userId().equals(reservaOpt.get().getUsuarioId())) {
                payload.put("error", "No encontré un alquiler tuyo con esa referencia.");
                return ToolResult.of(payload);
            }
            ObjectNode detalle = reservaDetalle(reservaOpt.get());
            payload.set("reserva", detalle.deepCopy());
            ObjectNode data = mapper.createObjectNode();
            data.put("vista", "alquiler");
            data.set("reserva", detalle.deepCopy());
            return ToolResult.of(payload, List.of(new UiEvent(UiEvent.RESERVATION, data)));
        }

        List<Reservation> reservas = reservationService.getByUsuarioId(context.userId());
        ArrayNode array = payload.putArray("reservas");
        reservas.stream().limit(10).forEach(r -> array.add(reservaResumen(r)));
        if (array.isEmpty()) {
            payload.put("nota", "El usuario no tiene alquileres registrados.");
            return ToolResult.of(payload);
        }
        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "alquiler");
        data.set("reservas", array.deepCopy());
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.RESERVATION, data)));
    }

    private ObjectNode reservaDetalle(Reservation r) {
        ObjectNode node = reservaResumen(r);
        node.put("estadoPago", r.getEstadoPago() == null ? "SIN_PAGO" : r.getEstadoPago());
        node.put("montoAbonado", r.getMontoAbonado() == null ? BigDecimal.ZERO : r.getMontoAbonado());
        node.put("saldoPendiente", r.getSaldoPendiente());
        node.put("porcentajePagado", r.getPorcentajePagado());
        if (r.getMetodoPago() != null) {
            node.put("metodoPago", r.getMetodoPago());
        }
        if (r.getTipoEvento() != null) {
            node.put("tipoEvento", r.getTipoEvento());
        }
        if (r.getDireccionEvento() != null) {
            node.put("direccionEvento", r.getDireccionEvento());
        }
        if (r.getCodigoPagoEfectivo() != null) {
            node.put("codigoPagoEfectivo", r.getCodigoPagoEfectivo());
        }
        node.put("creada", r.getFechaCreacion() == null ? null : r.getFechaCreacion().toString());

        ArrayNode pagos = node.putArray("pagos");
        if (r.getId() != null) {
            for (Payment p : paymentRepository.findByReservaId(r.getId())) {
                ObjectNode pn = pagos.addObject();
                pn.put("monto", p.getMonto());
                pn.put("metodo", p.getMetodoPago());
                pn.put("estado", p.getEstado());
                if (p.getTipoPago() != null) {
                    pn.put("tipo", p.getTipoPago());
                }
                if (p.getFechaPago() != null) {
                    pn.put("fecha", p.getFechaPago().toString());
                }
            }
        }

        ArrayNode timeline = node.putArray("timeline");
        List<String> pasos = List.of("PENDIENTE", "CONFIRMADA", "ENTREGADA", "COMPLETADA");
        String estado = r.getEstado() == null ? "PENDIENTE" : r.getEstado();
        boolean cancelada = "CANCELADA".equals(estado);
        int idx = pasos.indexOf(estado);
        for (int i = 0; i < pasos.size(); i++) {
            ObjectNode paso = timeline.addObject();
            paso.put("estado", pasos.get(i));
            paso.put("completado", !cancelada && idx >= 0 && i <= idx);
            paso.put("actual", !cancelada && i == idx);
        }
        return node;
    }

    private ObjectNode baseField(String name, String label, String type, boolean required) {
        ObjectNode field = mapper.createObjectNode();
        field.put("name", name);
        field.put("label", label);
        field.put("type", type);
        field.put("required", required);
        return field;
    }

    private ObjectNode selectField(String name, String label, boolean required, String... options) {
        ObjectNode field = baseField(name, label, "select", required);
        ArrayNode list = field.putArray("options");
        for (int i = 0; i + 1 < options.length; i += 2) {
            ObjectNode option = list.addObject();
            option.put("value", options[i]);
            option.put("label", options[i + 1]);
        }
        return field;
    }

    private ObjectNode numberField(String name, String label, boolean required, String placeholder) {
        ObjectNode field = baseField(name, label, "number", required);
        if (placeholder != null) {
            field.put("placeholder", placeholder);
        }
        return field;
    }

    private ObjectNode dateField(String name, String label, boolean required) {
        return baseField(name, label, "date", required);
    }

    private ObjectNode timeField(String name, String label, boolean required) {
        return baseField(name, label, "time", required);
    }

    private ObjectNode textareaField(String name, String label, boolean required, String placeholder) {
        ObjectNode field = baseField(name, label, "textarea", required);
        if (placeholder != null) {
            field.put("placeholder", placeholder);
        }
        return field;
    }

    private LocalDate parseFechaOpcional(String valor) {
        if (valor == null || valor.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(valor.trim());
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    // ───────────────────────── Escalado ─────────────────────────

    private ToolResult escalarAHumano(JsonNode args, ToolContext context) {
        String motivo = text(args, "motivo");
        String resumen = text(args, "resumen");
        StringBuilder mensaje = new StringBuilder("Hola Furent, vengo del asistente virtual.");
        if (!motivo.isBlank()) {
            mensaje.append(" Motivo: ").append(motivo).append('.');
        }
        if (!resumen.isBlank()) {
            mensaje.append(" Resumen: ").append(resumen);
        }
        // Escalado con contexto: el asesor recibe lo que el usuario ya expresó.
        if (context != null && context.memoria() != null && !context.memoria().isBlank()) {
            mensaje.append(" Contexto: ").append(context.memoria().replace('\n', ' '));
        }
        if (context != null && context.bag() != null && !context.bag().isEmpty()) {
            List<String> items = new ArrayList<>();
            for (BagItem bagItem : context.bag()) {
                if (items.size() >= 6) {
                    break;
                }
                items.add(bagItem.nombre() + " x" + bagItem.cantidad());
            }
            mensaje.append(" Bolsa: ").append(String.join(", ", items)).append('.');
        }
        String url = "https://wa.me/" + properties.getWhatsappNumber()
                + "?text=" + URLEncoder.encode(mensaje.toString(), StandardCharsets.UTF_8);

        ObjectNode payload = mapper.createObjectNode();
        payload.put("whatsappUrl", url);
        payload.put("mensaje", "Puedes continuar por WhatsApp con un asesor.");
        payload.put("contextoPreparado", mensaje.toString());
        metrics.escalation();

        ObjectNode data = mapper.createObjectNode();
        data.put("whatsappUrl", url);
        data.put("motivo", motivo);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.ESCALATION, data)));
    }

    // ───────────────────────── Cálculo de disponibilidad ─────────────────────────

    private int calcularDisponible(Product product, LocalDate inicio, LocalDate fin, List<Reservation> activas) {
        if (!product.isDisponible() || "EN_REPARACION".equals(product.getEstadoMantenimiento())) {
            return 0;
        }
        LocalDate finBuffer = fin.plusDays(1);
        int maxReservado = 0;
        LocalDate dia = inicio;
        while (!dia.isAfter(finBuffer)) {
            final LocalDate actual = dia;
            int reservado = activas.stream()
                    .filter(r -> r.getFechaInicio() != null && r.getFechaFin() != null)
                    .filter(r -> !actual.isBefore(r.getFechaInicio()) && !actual.isAfter(r.getFechaFin().plusDays(1)))
                    .flatMap(r -> r.getItems().stream())
                    .filter(i -> product.getId().equals(i.getProductoId()))
                    .mapToInt(Reservation.ItemReserva::getCantidad)
                    .sum();
            if (reservado > maxReservado) {
                maxReservado = reservado;
            }
            dia = dia.plusDays(1);
        }
        return Math.max(0, product.getStock() - maxReservado);
    }

    // ───────────────────────── Helpers de validación ─────────────────────────

    private void validarRango(LocalDate inicio, LocalDate fin, List<String> errores) {
        if (inicio == null || fin == null) {
            return;
        }
        if (inicio.isBefore(LocalDate.now())) {
            errores.add("La fecha de inicio ya pasó. Elige una fecha desde hoy.");
        }
        if (fin.isBefore(inicio)) {
            errores.add("La fecha de entrega no puede ser antes de la fecha de recogida. "
                    + "¿Quieres corregir el rango?");
            return;
        }
        long dias = ChronoUnit.DAYS.between(inicio, fin) + 1;
        if (dias > MAX_DIAS_ALQUILER) {
            errores.add("El alquiler puede ser de máximo " + MAX_DIAS_ALQUILER
                    + " días seguidos. ¿Ajustamos las fechas?");
        }
    }

    private LocalDate fecha(JsonNode args, String campo, List<String> errores) {
        String value = text(args, campo);
        if (value.isBlank()) {
            errores.add("Me falta la fecha " + campo + " para revisar la disponibilidad "
                    + "(formato AAAA-MM-DD).");
            return null;
        }
        try {
            return LocalDate.parse(value);
        } catch (DateTimeParseException e) {
            errores.add("La fecha " + campo + " debe tener el formato AAAA-MM-DD.");
            return null;
        }
    }

    // ───────────────────────── Helpers de JSON ─────────────────────────

    private ObjectNode productoResumen(Product p) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", p.getId());
        node.put("nombre", p.getNombre());
        node.put("categoria", p.getCategoriaNombre());
        node.put("precioDia", p.getPrecioPorDia());
        node.put("stock", p.getStock());
        node.put("disponible", p.isDisponible());
        return node;
    }

    private ObjectNode productoCard(Product p) {
        ObjectNode node = mapper.createObjectNode();
        node.put("tipo", "producto");
        node.put("id", p.getId());
        node.put("nombre", p.getNombre());
        node.put("imagen", p.getImagenUrl());
        node.put("precioDia", p.getPrecioPorDia());
        node.put("stock", p.getStock());
        node.put("categoria", p.getCategoriaNombre());
        node.put("disponible", p.isDisponible());
        return node;
    }

    private ObjectNode comboCard(Combo combo) {
        ObjectNode node = mapper.createObjectNode();
        node.put("tipo", "combo");
        node.put("id", combo.getId());
        node.put("nombre", combo.getNombre());
        node.put("imagen", combo.getImagenUrl());
        node.put("precioDia", combo.getPrecioCombo());
        node.put("descuento", combo.getPorcentajeDescuento());
        return node;
    }

    private ObjectNode reservaResumen(Reservation r) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", r.getId());
        node.put("estado", r.getEstado());
        node.put("fechaInicio", r.getFechaInicio() == null ? null : r.getFechaInicio().toString());
        node.put("fechaFin", r.getFechaFin() == null ? null : r.getFechaFin().toString());
        node.put("total", r.getTotal());
        node.put("dias", r.getDiasAlquiler());
        if (r.getItems() != null) {
            ArrayNode items = node.putArray("items");
            for (Reservation.ItemReserva item : r.getItems()) {
                ObjectNode n = items.addObject();
                n.put("nombre", item.getProductoNombre());
                n.put("cantidad", item.getCantidad());
            }
        }
        return node;
    }

    private void addAll(Map<String, Product> destino, List<Product> productos) {
        if (productos == null) {
            return;
        }
        for (Product p : productos) {
            if (p != null && p.getId() != null) {
                destino.putIfAbsent(p.getId(), p);
            }
        }
    }

    private String text(JsonNode args, String field) {
        JsonNode node = args.path(field);
        return node.isMissingNode() || node.isNull() ? "" : node.asText("").trim();
    }

    private BigDecimal decimal(JsonNode args, String field) {
        JsonNode node = args.path(field);
        if (node.isMissingNode() || node.isNull() || !node.isNumber()) {
            return null;
        }
        return node.decimalValue();
    }

    private record ItemCotizacion(Product producto, int cantidad) {
    }

    private record Recomendacion(Product producto, int cantidad) {
    }
}
