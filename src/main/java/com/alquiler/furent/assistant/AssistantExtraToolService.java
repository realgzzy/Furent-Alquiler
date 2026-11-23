package com.alquiler.furent.assistant;

import com.alquiler.furent.config.TenantContext;
import com.alquiler.furent.model.ContactMessage;
import com.alquiler.furent.model.InspirationImage;
import com.alquiler.furent.model.Notification;
import com.alquiler.furent.model.Product;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.model.Review;
import com.alquiler.furent.model.User;
import com.alquiler.furent.model.UserAddress;
import com.alquiler.furent.repository.ReservationRepository;
import com.alquiler.furent.service.ContactService;
import com.alquiler.furent.service.InspirationService;
import com.alquiler.furent.service.NotificationService;
import com.alquiler.furent.service.ProductService;
import com.alquiler.furent.service.ReviewService;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Herramientas de descubrimiento, cuenta y captación del asistente.
 *
 * Se mantienen aparte de {@link AssistantToolService} para no seguir engordando el servicio
 * principal; todas son de solo lectura salvo {@code guardar_contacto}, que registra un mensaje
 * de contacto para el equipo comercial.
 */
@Service
public class AssistantExtraToolService {

    private static final int MAX_COMPARAR = 4;
    private static final int MAX_RESEÑAS = 10;
    private static final int MAX_INSPIRACION = 8;

    private final ProductService productService;
    private final ReservationRepository reservationRepository;
    private final ReviewService reviewService;
    private final InspirationService inspirationService;
    private final UserService userService;
    private final NotificationService notificationService;
    private final ContactService contactService;
    private final AssistantSemanticSearch semanticSearch;
    private final ObjectMapper mapper;

    public AssistantExtraToolService(ProductService productService,
                                     ReservationRepository reservationRepository,
                                     ReviewService reviewService,
                                     InspirationService inspirationService,
                                     UserService userService,
                                     NotificationService notificationService,
                                     ContactService contactService,
                                     AssistantSemanticSearch semanticSearch,
                                     ObjectMapper mapper) {
        this.productService = productService;
        this.reservationRepository = reservationRepository;
        this.reviewService = reviewService;
        this.inspirationService = inspirationService;
        this.userService = userService;
        this.notificationService = notificationService;
        this.contactService = contactService;
        this.semanticSearch = semanticSearch;
        this.mapper = mapper;
    }

    /** ¿El nombre corresponde a una herramienta de este servicio? */
    public boolean supports(String name) {
        return switch (name) {
            case "comparar_productos", "ver_resenas", "productos_similares", "ver_inspiracion",
                    "productos_populares", "mis_direcciones", "mis_notificaciones",
                    "pedir_datos_contacto", "guardar_contacto", "sugerir_pagina" -> true;
            default -> false;
        };
    }

    public ToolResult execute(String name, JsonNode rawArgs, ToolContext context) {
        JsonNode args = rawArgs == null || rawArgs.isNull() ? mapper.createObjectNode() : rawArgs;
        return switch (name) {
            case "comparar_productos" -> compararProductos(args);
            case "ver_resenas" -> verResenas(args);
            case "productos_similares" -> productosSimilares(args);
            case "ver_inspiracion" -> verInspiracion(args);
            case "productos_populares" -> productosPopulares(args);
            case "mis_direcciones" -> misDirecciones(context);
            case "mis_notificaciones" -> misNotificaciones(context);
            case "pedir_datos_contacto" -> pedirDatosContacto();
            case "guardar_contacto" -> guardarContacto(args, context);
            case "sugerir_pagina" -> sugerirPagina(args);
            default -> throw new AssistantException(AssistantException.Code.INVALID_INPUT,
                    "Herramienta desconocida: " + name);
        };
    }

    // ───────────────────────── Descubrimiento ─────────────────────────

    private ToolResult compararProductos(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        List<String> ids = ids(args, "productoIds", "ids");
        if (ids.size() < 2) {
            payload.put("error", "Necesito al menos dos productos para compararlos.");
            return ToolResult.of(payload);
        }

        List<Product> productos = new ArrayList<>();
        for (String id : ids) {
            productService.getProductById(id).ifPresent(productos::add);
        }
        if (productos.size() < 2) {
            payload.put("error", "No encontré dos productos válidos para comparar.");
            return ToolResult.of(payload);
        }

        String mejorPrecio = productos.stream()
                .filter(p -> p.getPrecioPorDia() != null)
                .min(Comparator.comparing(Product::getPrecioPorDia))
                .map(Product::getId).orElse(null);
        String mejorCalificacion = productos.stream()
                .max(Comparator.comparingDouble(Product::getCalificacion))
                .map(Product::getId).orElse(null);

        ArrayNode array = payload.putArray("productos");
        ArrayNode panelProductos = mapper.createArrayNode();
        for (Product p : productos) {
            ObjectNode node = compararNode(p, mejorPrecio, mejorCalificacion);
            array.add(node.deepCopy());
            panelProductos.add(node.deepCopy());
        }
        payload.put("mejorPrecio", mejorPrecio);
        payload.put("mejorCalificacion", mejorCalificacion);

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "comparar");
        data.put("titulo", "Comparar mobiliario");
        data.set("productos", panelProductos);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ObjectNode compararNode(Product p, String mejorPrecio, String mejorCalificacion) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", p.getId());
        node.put("nombre", p.getNombre());
        node.put("categoria", p.getCategoriaNombre());
        node.put("imagen", p.getImagenUrl());
        node.put("precioDia", p.getPrecioPorDia());
        node.put("stock", p.getStock());
        node.put("calificacion", p.getCalificacion());
        node.put("cantidadResenas", p.getCantidadResenas());
        node.put("material", p.getMaterial());
        node.put("dimensiones", p.getDimensiones());
        node.put("color", p.getColor());
        node.put("disponible", p.isDisponible());
        node.put("mejorPrecio", p.getId() != null && p.getId().equals(mejorPrecio));
        node.put("mejorCalificacion", p.getId() != null && p.getId().equals(mejorCalificacion));
        return node;
    }

    private ToolResult verResenas(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        String productoId = text(args, "productoId");
        Optional<Product> productoOpt = productService.getProductById(productoId);
        if (productoOpt.isEmpty()) {
            payload.put("error", "No encontré ese producto en el catálogo.");
            return ToolResult.of(payload);
        }
        Product producto = productoOpt.get();
        int limite = clamp(args.path("limite").asInt(6), 1, MAX_RESEÑAS);
        List<Review> resenas = reviewService.getReviewsByProduct(producto.getId());

        ObjectNode productoNode = payload.putObject("producto");
        productoNode.put("id", producto.getId());
        productoNode.put("nombre", producto.getNombre());
        productoNode.put("imagen", producto.getImagenUrl());
        productoNode.put("calificacion", producto.getCalificacion());
        productoNode.put("cantidadResenas", producto.getCantidadResenas());
        productoNode.put("categoria", producto.getCategoriaNombre());
        productoNode.put("precioDia", producto.getPrecioPorDia());

        ArrayNode array = payload.putArray("resenas");
        ArrayNode panelResenas = mapper.createArrayNode();
        for (Review review : resenas.stream().limit(limite).toList()) {
            ObjectNode node = mapper.createObjectNode();
            node.put("usuario", review.getUserName() == null ? "Cliente Furent" : review.getUserName());
            node.put("rating", review.getRating());
            node.put("comentario", review.getComment());
            node.put("fecha", review.getCreatedAt() == null ? null : review.getCreatedAt().toLocalDate().toString());
            if (review.getAdminResponse() != null && !review.getAdminResponse().isBlank()) {
                node.put("respuesta", review.getAdminResponse());
            }
            array.add(node.deepCopy());
            panelResenas.add(node.deepCopy());
        }
        payload.put("total", resenas.size());
        if (resenas.isEmpty()) {
            payload.put("nota", "Este producto todavía no tiene reseñas.");
        }

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "resenas");
        data.put("titulo", "Reseñas de " + producto.getNombre());
        data.set("producto", productoNode.deepCopy());
        data.set("resenas", panelResenas);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ToolResult productosSimilares(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        String productoId = text(args, "productoId");
        Optional<Product> baseOpt = productService.getProductById(productoId);
        if (baseOpt.isEmpty()) {
            payload.put("error", "No encontré ese producto en el catálogo.");
            return ToolResult.of(payload);
        }
        Product base = baseOpt.get();
        int limite = clamp(args.path("limite").asInt(4), 1, 6);

        Map<String, Product> candidatos = new LinkedHashMap<>();
        String categoria = base.getCategoriaNombre() == null ? "" : base.getCategoriaNombre();
        if (!categoria.isBlank()) {
            for (Product p : productService.getRelatedProducts(base.getId(), categoria)) {
                candidatos.putIfAbsent(p.getId(), p);
            }
        }
        if (candidatos.size() < limite) {
            String consulta = (categoria + " " + (base.getMaterial() == null ? "" : base.getMaterial())).trim();
            for (Product p : semanticSearch.search(consulta.isBlank() ? base.getNombre() : consulta, limite * 2)) {
                candidatos.putIfAbsent(p.getId(), p);
            }
        }

        List<Product> seleccion = candidatos.values().stream()
                .filter(p -> p.getId() != null && !p.getId().equals(base.getId()))
                .filter(Product::isDisponible)
                .limit(limite)
                .toList();

        ArrayNode array = payload.putArray("productos");
        List<UiEvent> events = new ArrayList<>();
        for (Product p : seleccion) {
            array.add(resumen(p));
            events.add(new UiEvent(UiEvent.CARD, card(p)));
        }
        payload.put("base", base.getNombre());
        if (seleccion.isEmpty()) {
            payload.put("nota", "No encontré alternativas disponibles; ofrece buscar con otros criterios.");
        }
        return ToolResult.of(payload, events);
    }

    private ToolResult verInspiracion(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        String categoria = text(args, "categoria");
        String tipoEvento = text(args, "tipoEvento");
        int limite = clamp(args.path("limite").asInt(6), 1, MAX_INSPIRACION);
        String tenant = TenantContext.getCurrentTenant() == null ? "default" : TenantContext.getCurrentTenant();

        List<InspirationImage> imagenes = inspirationService.getActiveImages(tenant).stream()
                .filter(img -> categoria.isBlank() || contiene(img.getCategory(), categoria))
                .filter(img -> tipoEvento.isBlank() || contiene(img.getEventType(), tipoEvento))
                .limit(limite)
                .toList();

        ArrayNode array = payload.putArray("imagenes");
        ArrayNode panelImagenes = mapper.createArrayNode();
        for (InspirationImage img : imagenes) {
            ObjectNode node = mapper.createObjectNode();
            node.put("id", img.getId());
            node.put("titulo", img.getTitle());
            node.put("imagen", img.getImageUrl());
            node.put("tipoEvento", img.getEventType());
            node.put("ubicacion", img.getLocation());
            if (img.getGuestCount() != null) {
                node.put("invitados", img.getGuestCount());
            }
            node.put("categoria", img.getCategory());
            ArrayNode pins = node.putArray("pins");
            for (InspirationImage.InspirationPin pin : img.getPins()) {
                ObjectNode p = pins.addObject();
                p.put("productoId", pin.getProductId());
                p.put("nombre", pin.getProductName());
                p.put("imagen", pin.getProductImageUrl());
                p.put("precioDia", pin.getProductPrice());
                p.put("x", pin.getPositionX());
                p.put("y", pin.getPositionY());
            }
            array.add(node.deepCopy());
            panelImagenes.add(node.deepCopy());
        }
        if (imagenes.isEmpty()) {
            payload.put("nota", "No hay imágenes de inspiración con esos filtros.");
        }

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "inspiracion");
        data.put("titulo", "Inspiración para tu evento");
        data.set("imagenes", panelImagenes);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ToolResult productosPopulares(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        int limite = clamp(args.path("limite").asInt(6), 1, 6);

        Map<String, Integer> alquileres = new HashMap<>();
        for (Reservation reserva : reservationRepository.findAll()) {
            if (reserva.getItems() == null) {
                continue;
            }
            for (Reservation.ItemReserva item : reserva.getItems()) {
                if (item.getProductoId() != null) {
                    alquileres.merge(item.getProductoId(), Math.max(1, item.getCantidad()), Integer::sum);
                }
            }
        }

        List<Product> productos = productService.getAllProducts().stream()
                .filter(Product::isDisponible)
                .sorted(Comparator
                        .comparingInt((Product p) -> alquileres.getOrDefault(p.getId(), 0)).reversed()
                        .thenComparing(Comparator.comparingDouble(Product::getCalificacion).reversed()))
                .limit(limite)
                .toList();

        ArrayNode array = payload.putArray("productos");
        List<UiEvent> events = new ArrayList<>();
        for (Product p : productos) {
            ObjectNode node = resumen(p);
            node.put("alquileres", alquileres.getOrDefault(p.getId(), 0));
            array.add(node);
            events.add(new UiEvent(UiEvent.CARD, card(p)));
        }
        if (productos.isEmpty()) {
            payload.put("nota", "No hay productos disponibles para recomendar.");
        }
        return ToolResult.of(payload, events);
    }

    // ───────────────────────── Cuenta del usuario ─────────────────────────

    private ToolResult misDirecciones(ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        if (!context.authenticated()) {
            payload.put("error", "El usuario debe iniciar sesión para ver sus direcciones.");
            return ToolResult.of(payload);
        }
        Optional<User> userOpt = userService.findById(context.userId());
        List<UserAddress> direcciones = userOpt.map(User::getDirecciones).orElse(List.of());
        if (direcciones == null) {
            direcciones = List.of();
        }

        ArrayNode array = payload.putArray("direcciones");
        ArrayNode panelDirecciones = mapper.createArrayNode();
        for (UserAddress d : direcciones) {
            ObjectNode node = mapper.createObjectNode();
            node.put("id", d.getId());
            node.put("alias", d.getAlias());
            node.put("direccion", d.getDireccion());
            node.put("ciudad", d.getCiudad());
            node.put("departamento", d.getEstadoProvincia());
            node.put("pais", d.getPais());
            node.put("codigoPostal", d.getCodigoPostal());
            node.put("predeterminada", d.isPredeterminada());
            array.add(node.deepCopy());
            panelDirecciones.add(node.deepCopy());
        }
        if (direcciones.isEmpty()) {
            payload.put("nota", "El usuario no tiene direcciones guardadas.");
        }

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "direcciones");
        data.put("titulo", "Mis direcciones");
        data.set("direcciones", panelDirecciones);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ToolResult misNotificaciones(ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        if (!context.authenticated()) {
            payload.put("error", "El usuario debe iniciar sesión para ver sus notificaciones.");
            return ToolResult.of(payload);
        }
        List<Notification> notificaciones = notificationService.getRecentNotifications(context.userId());
        long noLeidas = notificationService.countUnread(context.userId());

        ArrayNode array = payload.putArray("notificaciones");
        ArrayNode panelLista = mapper.createArrayNode();
        for (Notification n : notificaciones.stream().limit(10).toList()) {
            ObjectNode node = mapper.createObjectNode();
            node.put("id", n.getId());
            node.put("titulo", n.getTitulo());
            node.put("mensaje", n.getMensaje());
            node.put("tipo", n.getTipo());
            node.put("link", n.getLink());
            node.put("leida", n.isLeida());
            node.put("fecha", n.getFecha() == null ? null : n.getFecha().toLocalDate().toString());
            array.add(node.deepCopy());
            panelLista.add(node.deepCopy());
        }
        payload.put("noLeidas", noLeidas);

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "notificaciones");
        data.put("titulo", "Notificaciones");
        data.put("noLeidas", noLeidas);
        data.set("notificaciones", panelLista);
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    // ───────────────────────── Captación y navegación ─────────────────────────

    private ToolResult pedirDatosContacto() {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("ok", true);
        payload.put("nota", "Se abrió el formulario de contacto en el panel lateral. Cuando el usuario "
                + "lo envíe, usa \"guardar_contacto\" con los datos y confirma que un asesor lo contactará.");

        ObjectNode data = mapper.createObjectNode();
        data.put("vista", "form");
        data.put("titulo", "Hablemos de tu evento");
        data.put("descripcion", "Déjame tus datos y un asesor de Furent te contacta.");
        data.put("submitLabel", "Enviar mis datos");
        data.put("submitPrefix", "Datos de contacto:");
        ArrayNode fields = data.putArray("fields");
        fields.add(textField("nombre", "Nombre completo", true, "Tu nombre"));
        fields.add(textField("telefono", "Teléfono o WhatsApp", true, "300 000 0000"));
        fields.add(textField("email", "Correo electrónico", false, "tucorreo@gmail.com"));
        fields.add(textField("ciudad", "Ciudad del evento", false, "Medellín"));
        fields.add(textareaField("motivo", "Cuéntame qué necesitas", false, "Tipo de evento, personas, fechas..."));
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.PANEL, data)));
    }

    private ToolResult guardarContacto(JsonNode args, ToolContext context) {
        ObjectNode payload = mapper.createObjectNode();
        String nombre = text(args, "nombre");
        String email = text(args, "email");
        String telefono = text(args, "telefono");
        String ciudad = text(args, "ciudad");
        String motivo = text(args, "motivo");
        if (motivo.isBlank()) {
            motivo = text(args, "mensaje");
        }
        if (nombre.isBlank()) {
            payload.put("error", "Falta el nombre del contacto.");
            return ToolResult.of(payload);
        }
        if (email.isBlank() && telefono.isBlank()) {
            payload.put("error", "Necesito al menos un correo o un teléfono de contacto.");
            return ToolResult.of(payload);
        }

        ContactMessage message = new ContactMessage();
        message.setNombre(nombre);
        message.setEmail(email);
        message.setTelefono(telefono);
        message.setAsunto("Contacto desde Furi" + (ciudad.isBlank() ? "" : " · " + ciudad));
        StringBuilder cuerpo = new StringBuilder();
        if (!motivo.isBlank()) {
            cuerpo.append(motivo);
        }
        if (!ciudad.isBlank()) {
            cuerpo.append(cuerpo.isEmpty() ? "" : "\n").append("Ciudad: ").append(ciudad);
        }
        if (context != null && !context.authenticated()) {
            cuerpo.append(cuerpo.isEmpty() ? "" : "\n").append("Origen: visitante invitado");
        }
        message.setMensaje(cuerpo.toString());
        message.setTenantId(TenantContext.getCurrentTenant() == null ? "default" : TenantContext.getCurrentTenant());
        contactService.save(message);

        payload.put("ok", true);
        payload.put("mensaje", "Datos guardados. Un asesor de Furent se pondrá en contacto contigo.");
        return ToolResult.of(payload);
    }

    private ToolResult sugerirPagina(JsonNode args) {
        ObjectNode payload = mapper.createObjectNode();
        String pagina = text(args, "pagina").toLowerCase(Locale.ROOT);
        String categoria = text(args, "categoria");
        String consulta = text(args, "consulta");
        String productoId = text(args, "productoId");

        String url;
        String label;
        switch (pagina) {
            case "producto" -> {
                url = productoId.isBlank() ? "/catalogo" : "/producto/" + enc(productoId);
                label = "Ver producto";
            }
            case "inspiracion" -> {
                url = "/inspiracion";
                label = "Ver inspiración";
            }
            case "cotizacion", "checkout" -> {
                url = "/cotizacion";
                label = "Ir al checkout";
            }
            case "panel", "cuenta", "reservas" -> {
                url = "/panel";
                label = "Ver mi panel";
            }
            case "faq" -> {
                url = "/faq";
                label = "Preguntas frecuentes";
            }
            case "contacto" -> {
                url = "/contacto";
                label = "Contacto";
            }
            case "nosotros" -> {
                url = "/nosotros";
                label = "Sobre Furent";
            }
            default -> {
                StringBuilder sb = new StringBuilder("/catalogo");
                List<String> params = new ArrayList<>();
                if (!categoria.isBlank()) {
                    params.add("categoria=" + enc(categoria));
                }
                if (!consulta.isBlank()) {
                    params.add("q=" + enc(consulta));
                }
                if (!params.isEmpty()) {
                    sb.append('?').append(String.join("&", params));
                }
                url = sb.toString();
                label = categoria.isBlank() ? "Ver catálogo" : "Ver " + categoria;
            }
        }

        ObjectNode link = payload.putObject("link");
        link.put("label", label);
        link.put("url", url);
        ObjectNode data = mapper.createObjectNode();
        data.putArray("links").add(link.deepCopy());
        return ToolResult.of(payload, List.of(new UiEvent(UiEvent.LINKS, data)));
    }

    // ───────────────────────── Helpers ─────────────────────────

    private ObjectNode resumen(Product p) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", p.getId());
        node.put("nombre", p.getNombre());
        node.put("categoria", p.getCategoriaNombre());
        node.put("precioDia", p.getPrecioPorDia());
        node.put("stock", p.getStock());
        node.put("calificacion", p.getCalificacion());
        return node;
    }

    private ObjectNode card(Product p) {
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

    private List<String> ids(JsonNode args, String... campos) {
        List<String> ids = new ArrayList<>();
        for (String campo : campos) {
            JsonNode node = args.path(campo);
            if (!node.isArray()) {
                continue;
            }
            for (JsonNode idNode : node) {
                String id = idNode.asText("").trim();
                if (!id.isEmpty() && !ids.contains(id)) {
                    ids.add(id);
                    if (ids.size() >= MAX_COMPARAR) {
                        return ids;
                    }
                }
            }
        }
        return ids;
    }

    private ObjectNode textField(String name, String label, boolean required, String placeholder) {
        ObjectNode field = baseField(name, label, "text", required);
        if (placeholder != null) {
            field.put("placeholder", placeholder);
        }
        return field;
    }

    private ObjectNode textareaField(String name, String label, boolean required, String placeholder) {
        ObjectNode field = baseField(name, label, "textarea", required);
        if (placeholder != null) {
            field.put("placeholder", placeholder);
        }
        return field;
    }

    private ObjectNode baseField(String name, String label, String type, boolean required) {
        ObjectNode field = mapper.createObjectNode();
        field.put("name", name);
        field.put("label", label);
        field.put("type", type);
        field.put("required", required);
        return field;
    }

    private boolean contiene(String valor, String busqueda) {
        return valor != null && valor.toLowerCase(Locale.ROOT).contains(busqueda.toLowerCase(Locale.ROOT));
    }

    private int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }

    private String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private String text(JsonNode args, String field) {
        JsonNode node = args.path(field);
        return node.isMissingNode() || node.isNull() ? "" : node.asText("").trim();
    }
}
