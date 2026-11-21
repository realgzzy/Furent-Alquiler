package com.alquiler.furent.assistant;

import com.alquiler.furent.assistant.dto.AssistantChatRequest;
import com.alquiler.furent.config.AssistantProperties;
import com.alquiler.furent.model.AssistantConversation;
import com.alquiler.furent.model.AssistantMessage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Orquesta una conversación: cuotas, historial, prompt, bucle de herramientas y eventos.
 */
@Component
public class AssistantOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(AssistantOrchestrator.class);
    private static final Set<String> PAGINAS_PERMITIDAS = Set.of(
            "/", "/catalogo", "/cotizacion", "/faq", "/contacto", "/nosotros",
            "/inspiracion", "/panel", "/configuracion", "/inicio-rapido", "/combo");

    private final AssistantProperties properties;
    private final AssistantConversationService conversations;
    private final AssistantQuotaService quota;
    private final AssistantPromptBuilder promptBuilder;
    private final GeminiClient geminiClient;
    private final AssistantToolService toolService;
    private final AssistantMetrics metrics;
    private final ObjectMapper mapper;

    public AssistantOrchestrator(AssistantProperties properties,
                                 AssistantConversationService conversations,
                                 AssistantQuotaService quota,
                                 AssistantPromptBuilder promptBuilder,
                                 GeminiClient geminiClient,
                                 AssistantToolService toolService,
                                 AssistantMetrics metrics,
                                 ObjectMapper mapper) {
        this.properties = properties;
        this.conversations = conversations;
        this.quota = quota;
        this.promptBuilder = promptBuilder;
        this.geminiClient = geminiClient;
        this.toolService = toolService;
        this.metrics = metrics;
        this.mapper = mapper;
    }

    public void handle(AssistantChatRequest request, ToolContext context, AssistantStream stream) {
        Instant start = Instant.now();
        AssistantConversation conversation = null;
        try {
            quota.checkAndConsume(context);
            metrics.message(context.authenticated() ? "user" : "guest");

            String pageContext = sanitizePageContext(request.getPageContext());
            conversation = conversations.resolve(request.getConversationId(), context, pageContext);
            List<AssistantMessage> history = conversations.history(conversation.getId());
            conversations.saveUserMessage(conversation, request.getMessage());

            ObjectNode meta = mapper.createObjectNode();
            meta.put("conversationId", conversation.getId());
            meta.put("model", properties.getModel());
            meta.put("whatsapp", properties.getWhatsappNumber());
            stream.event("meta", meta);
            if (!stream.isOpen()) {
                return;
            }

            List<JsonNode> contents = promptBuilder.initialContents(history, request.getMessage());
            StringBuilder answer = new StringBuilder();
            boolean[] blocked = {false};
            int maxRondas = Math.max(1, properties.getMaxToolIterations());

            for (int ronda = 0; ronda <= maxRondas; ronda++) {
                if (!stream.isOpen()) {
                    break;
                }
                ToolContext chatContext = context.withMemory(conversation.getMemoria());
                ObjectNode body = promptBuilder.buildBody(contents, chatContext, pageContext);
                List<GeminiChunk> calls = new ArrayList<>();
                int[] tokens = {0, 0};

                geminiClient.stream(body, chunk -> {
                    switch (chunk.kind()) {
                        case TEXT -> {
                            answer.append(chunk.text());
                            stream.token(chunk.text());
                        }
                        case FUNCTION_CALL -> calls.add(chunk);
                        case USAGE -> {
                            tokens[0] += chunk.usage().promptTokens();
                            tokens[1] += chunk.usage().outputTokens();
                        }
                        case BLOCKED -> blocked[0] = true;
                    }
                });

                if (tokens[0] + tokens[1] > 0) {
                    conversations.addTokens(conversation, tokens[0], tokens[1]);
                }
                if (blocked[0]) {
                    break;
                }
                if (calls.isEmpty()) {
                    break;
                }
                if (ronda == maxRondas) {
                    stream.token("\n\nSi necesitas más detalles, pregúntame de nuevo o escríbenos por WhatsApp.");
                    break;
                }
                ejecutarHerramientas(conversation, calls, chatContext, stream, contents);
            }

            if (blocked[0]) {
                emitError(stream, AssistantException.Code.BLOCKED,
                        "No puedo ayudar con esa solicitud. Si necesitas atención personal, escríbenos por WhatsApp.");
            }

            String finalText = answer.toString().trim();
            if (!finalText.isEmpty()) {
                conversations.saveAssistantMessage(conversation, finalText, properties.getModel());
            }

            ObjectNode done = mapper.createObjectNode();
            done.put("conversationId", conversation.getId());
            done.put("tokens", conversation.getTokensEntrada() + conversation.getTokensSalida());
            stream.event("done", done);
            metrics.latency(properties.getModel(), Duration.between(start, Instant.now()));
        } catch (AssistantException e) {
            emitError(stream, e.getCode(), e.getMessage());
            metrics.error(e.getCode().name());
        } catch (RuntimeException e) {
            log.error("Error inesperado en el asistente: {}", e.getMessage(), e);
            emitError(stream, AssistantException.Code.INTERNAL,
                    "Ocurrió un error inesperado. Intenta de nuevo o escríbenos por WhatsApp.");
            metrics.error(AssistantException.Code.INTERNAL.name());
        } finally {
            stream.complete();
        }
    }

    private void ejecutarHerramientas(AssistantConversation conversation, List<GeminiChunk> calls,
                                      ToolContext context, AssistantStream stream, List<JsonNode> contents) {
        List<GeminiContents.Call> callParts = new ArrayList<>();
        List<GeminiContents.Response> responseParts = new ArrayList<>();

        for (GeminiChunk call : calls) {
            String name = call.functionName();
            callParts.add(new GeminiContents.Call(name, call.functionArgs(), call.thoughtSignature()));
            emitStatus(stream, estadoDe(name));

            ToolResult result;
            try {
                result = toolService.execute(name, call.functionArgs(), context);
            } catch (AssistantException e) {
                ObjectNode error = mapper.createObjectNode();
                error.put("error", e.getMessage());
                result = ToolResult.of(error);
                metrics.error(e.getCode().name());
            }

            responseParts.add(new GeminiContents.Response(name, result.payload()));
            conversations.saveToolMessage(conversation, name, resumen(name, call.functionArgs()));
            String memoria = memoriaDe(name, result.payload());
            if (memoria != null) {
                conversations.appendMemory(conversation, memoria);
            }

            for (UiEvent event : result.uiEvents()) {
                stream.event(event.type(), event.data());
                if (UiEvent.ESCALATION.equals(event.type())) {
                    conversations.markEscalated(conversation, event.data().path("motivo").asText(""));
                } else if (UiEvent.QUOTE.equals(event.type())) {
                    conversations.registerQuote(conversation, event.data().path("total").decimalValue());
                    metrics.quote();
                }
            }
        }

        contents.add(GeminiContents.modelFunctionCalls(mapper, callParts));
        contents.add(GeminiContents.userFunctionResponses(mapper, responseParts));
    }

    private void emitError(AssistantStream stream, AssistantException.Code code, String message) {
        ObjectNode error = mapper.createObjectNode();
        error.put("codigo", code.name());
        error.put("mensaje", message == null ? "El asistente no está disponible." : message);
        stream.event("error", error);
    }

    /**
     * No se guardan argumentos de escalado (pueden contener datos del usuario) y el resto se
     * trunca.
     */
    private String resumen(String toolName, JsonNode args) {
        if ("escalar_a_humano".equals(toolName) || args == null || args.isNull()) {
            return "";
        }
        String texto = args.toString();
        return texto.length() > 200 ? texto.substring(0, 200) : texto;
    }

    /** Emite el texto dinámico de "Typing Intelligence" mientras se ejecuta una herramienta. */
    private void emitStatus(AssistantStream stream, String texto) {
        ObjectNode node = mapper.createObjectNode();
        node.put("texto", texto);
        stream.event(UiEvent.STATUS, node);
    }

    private String estadoDe(String herramienta) {
        return switch (herramienta) {
            case "buscar_productos", "listar_categorias", "ver_producto" -> "Buscando muebles…";
            case "consultar_disponibilidad" -> "Verificando disponibilidad…";
            case "cotizar" -> "Calculando precios…";
            case "recomendar_evento" -> "Armando tu propuesta…";
            case "mi_bolsa", "editar_bolsa" -> "Actualizando tu bolsa…";
            case "mis_reservas", "estado_reserva", "consultar_alquiler" -> "Consultando tus alquileres…";
            case "validar_cupon" -> "Validando el cupón…";
            case "informacion_negocio" -> "Buscando la información…";
            case "escalar_a_humano" -> "Preparando tu caso…";
            default -> "Trabajando en eso…";
        };
    }

    /**
     * Resume en una línea lo que la herramienta mostró, para la memoria de la conversación.
     * Devuelve {@code null} si no aporta contexto útil.
     */
    private String memoriaDe(String herramienta, JsonNode payload) {
        if (payload == null || payload.isNull()) {
            return null;
        }
        switch (herramienta) {
            case "buscar_productos" -> {
                JsonNode array = payload.path("productos");
                if (!array.isArray() || array.isEmpty()) {
                    return "Búsqueda sin resultados; conviene ofrecer alternativas o pedir menos filtros.";
                }
                List<String> nombres = new ArrayList<>();
                for (JsonNode node : array) {
                    if (nombres.size() >= 5) {
                        break;
                    }
                    String nombre = node.path("nombre").asText("");
                    if (!nombre.isBlank()) {
                        nombres.add(nombre);
                    }
                }
                return nombres.isEmpty() ? null : "Productos mostrados: " + String.join(", ", nombres) + ".";
            }
            case "ver_producto" -> {
                JsonNode producto = payload.path("producto");
                return producto.isObject() && !producto.path("nombre").asText("").isBlank()
                        ? "Producto visto: " + producto.path("nombre").asText("") + "."
                        : null;
            }
            case "consultar_disponibilidad" -> {
                JsonNode array = payload.path("productos");
                if (!array.isArray() || array.isEmpty()) {
                    return null;
                }
                List<String> partes = new ArrayList<>();
                for (JsonNode node : array) {
                    if (partes.size() >= 5) {
                        break;
                    }
                    partes.add(node.path("nombre").asText("") + " (" + node.path("disponibleEnFechas").asInt() + " disp.)");
                }
                return "Disponibilidad " + payload.path("fechaInicio").asText("") + " a "
                        + payload.path("fechaFin").asText("") + ": " + String.join(", ", partes) + ".";
            }
            case "cotizar" -> {
                JsonNode items = payload.path("items");
                if (!items.isArray() || items.isEmpty()) {
                    return null;
                }
                List<String> partes = new ArrayList<>();
                for (JsonNode node : items) {
                    if (partes.size() >= 6) {
                        break;
                    }
                    partes.add(node.path("nombre").asText("") + " x" + node.path("cantidad").asInt());
                }
                String aviso = payload.path("puedeContinuar").asBoolean(true) ? "" : " (sin stock suficiente)";
                return "Cotización " + payload.path("fechaInicio").asText("") + " a " + payload.path("fechaFin").asText("")
                        + " (" + payload.path("dias").asInt() + " días, total " + payload.path("total").asText("")
                        + aviso + "): " + String.join(", ", partes) + ".";
            }
            case "recomendar_evento" -> {
                JsonNode items = payload.path("items");
                if (!items.isArray() || items.isEmpty()) {
                    return null;
                }
                List<String> partes = new ArrayList<>();
                for (JsonNode node : items) {
                    if (partes.size() >= 6) {
                        break;
                    }
                    partes.add(node.path("nombre").asText("") + " x" + node.path("cantidad").asInt());
                }
                return "Recomendación para " + payload.path("invitados").asInt() + " personas: "
                        + String.join(", ", partes) + ".";
            }
            case "editar_bolsa" -> {
                String operacion = payload.path("operacion").asText("");
                return operacion.isBlank() ? null : "Bolsa: " + operacion + ".";
            }
            case "escalar_a_humano" -> {
                return "Escalado a un asesor.";
            }
            default -> {
                return null;
            }
        }
    }

    private String sanitizePageContext(String pageContext) {
        if (pageContext == null || pageContext.isBlank()) {
            return null;
        }
        String path = pageContext.trim();
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        if (PAGINAS_PERMITIDAS.contains(path) || path.startsWith("/producto/")) {
            return path;
        }
        return null;
    }
}
