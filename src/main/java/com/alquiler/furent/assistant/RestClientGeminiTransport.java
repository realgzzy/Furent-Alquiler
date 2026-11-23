package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/**
 * Implementación real del transporte usando {@link RestClient}.
 *
 * La API key viaja en el header {@code x-goog-api-key}, nunca en la URL, para no
 * filtrarla en los logs de acceso.
 */
@Component
public class RestClientGeminiTransport implements GeminiTransport {

    private static final Logger log = LoggerFactory.getLogger(RestClientGeminiTransport.class);
    private static final int MAX_ERROR_BODY = 500;
    /**
     * Ventana máxima dentro de la que se permiten reintentos. Evita que una cadena de
     * timeouts supere el timeout del {@code SseEmitter} y el usuario se quede sin respuesta.
     */
    private static final long MAX_RETRY_WINDOW_MS = 20_000L;

    private final RestClient restClient;
    private final AssistantProperties properties;
    private final ObjectMapper mapper;

    public RestClientGeminiTransport(@Qualifier("geminiRestClient") RestClient restClient,
                                     AssistantProperties properties,
                                     ObjectMapper mapper) {
        this.restClient = restClient;
        this.properties = properties;
        this.mapper = mapper;
    }

    @Override
    public void stream(JsonNode body, Consumer<String> onRawChunk) {
        if (!properties.isConfigured()) {
            throw new AssistantException(AssistantException.Code.UNAVAILABLE,
                    "El asistente no tiene una API key configurada.");
        }

        int maxAttempts = Math.max(1, properties.getRetryMaxAttempts());
        long inicio = System.currentTimeMillis();
        for (int attempt = 1; ; attempt++) {
            // Solo se reintenta si Gemini todavía no emitió ningún fragmento: reintentar un
            // stream a medias duplicaría el texto ya mostrado al usuario.
            boolean[] emitted = {false};
            Consumer<String> relay = chunk -> {
                emitted[0] = true;
                onRawChunk.accept(chunk);
            };
            try {
                streamOnce(body, relay);
                return;
            } catch (AssistantException e) {
                boolean sinTiempo = System.currentTimeMillis() - inicio > MAX_RETRY_WINDOW_MS;
                if (!isRetryable(e.getCode()) || emitted[0] || attempt >= maxAttempts || sinTiempo) {
                    throw e;
                }
                long delay = backoffMillis(attempt, properties.getRetryBackoffMillis(), e.getCode());
                log.warn("Gemini no respondió bien ({}, intento {}/{}): {}. Reintentando en {} ms",
                        e.getCode(), attempt, maxAttempts, e.getMessage(), delay);
                sleep(delay);
            }
        }
    }

    /** Un intento de streaming contra Gemini. */
    private void streamOnce(JsonNode body, Consumer<String> onRawChunk) {
        String uri = properties.getBaseUrl() + "/models/" + properties.getModel()
                + ":streamGenerateContent?alt=sse";

        try {
            restClient.post()
                    .uri(uri)
                    .header("x-goog-api-key", properties.getApiKey())
                    .contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.TEXT_EVENT_STREAM)
                    .body(mapper.writeValueAsString(body))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status >= 400) {
                            throw mapError(status, readBody(response.getBody()));
                        }
                        try (BufferedReader reader = new BufferedReader(
                                new InputStreamReader(response.getBody(), StandardCharsets.UTF_8))) {
                            String line;
                            while ((line = reader.readLine()) != null) {
                                onRawChunk.accept(line + "\n");
                            }
                        }
                        return null;
                    });
        } catch (AssistantException e) {
            throw e;
        } catch (Exception e) {
            log.warn("Fallo al invocar Gemini: {}", e.getMessage());
            throw AssistantException.unavailable("No se pudo contactar al asistente.", e);
        }
    }

    private AssistantException mapError(int status, String body) {
        log.warn("Gemini respondió {}: {}", status, body);
        if (status == 429) {
            return new AssistantException(AssistantException.Code.QUOTA_EXCEEDED,
                    "El asistente está recibiendo muchas solicitudes ahora mismo. "
                            + "Espera unos segundos e inténtalo de nuevo.");
        }
        if (status == 400) {
            return new AssistantException(AssistantException.Code.INVALID_INPUT,
                    "La solicitud al asistente no es válida.");
        }
        if (status == 401 || status == 403) {
            return new AssistantException(AssistantException.Code.INTERNAL,
                    "La configuración del asistente no es válida.");
        }
        if (status == 404) {
            return new AssistantException(AssistantException.Code.INTERNAL,
                    "El modelo del asistente no existe en la configuración.");
        }
        if (status >= 500) {
            return new AssistantException(AssistantException.Code.UNAVAILABLE,
                    "El asistente está sobrecargado en este momento. Vuelve a intentarlo en unos segundos.");
        }
        return new AssistantException(AssistantException.Code.UNAVAILABLE,
                "El asistente no pudo procesar la solicitud.");
    }

    /** Los errores de cuota (429) y de disponibilidad (5xx / red) se pueden reintentar. */
    static boolean isRetryable(AssistantException.Code code) {
        return code == AssistantException.Code.QUOTA_EXCEEDED
                || code == AssistantException.Code.UNAVAILABLE;
    }

    /**
     * Espera antes del siguiente intento: base exponencial (base, 2·base, 4·base…) con un
     * extra para 429, porque la cuota del proveedor suele tardar más en liberarse. Tope de 5 s.
     */
    static long backoffMillis(int attempt, long baseMillis, AssistantException.Code code) {
        long base = Math.max(0, baseMillis);
        long delay = base * (1L << Math.max(0, attempt - 1));
        if (code == AssistantException.Code.QUOTA_EXCEEDED) {
            delay *= 2;
        }
        return Math.min(delay, 5_000L);
    }

    private void sleep(long millis) {
        if (millis <= 0) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssistantException(AssistantException.Code.INTERNAL,
                    "La solicitud al asistente fue interrumpida.", e);
        }
    }

    private String readBody(java.io.InputStream body) {
        if (body == null) {
            return "";
        }
        try (body) {
            byte[] bytes = body.readNBytes(MAX_ERROR_BODY);
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }
}
