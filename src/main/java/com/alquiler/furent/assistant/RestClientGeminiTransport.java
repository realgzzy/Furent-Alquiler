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
                    "El asistente alcanzó su límite de uso. Intenta más tarde.");
        }
        if (status == 400) {
            return new AssistantException(AssistantException.Code.INVALID_INPUT,
                    "La solicitud al asistente no es válida.");
        }
        if (status == 401 || status == 403) {
            return new AssistantException(AssistantException.Code.INTERNAL,
                    "La configuración del asistente no es válida.");
        }
        if (status >= 500) {
            return new AssistantException(AssistantException.Code.UNAVAILABLE,
                    "El asistente no está disponible en este momento.");
        }
        return new AssistantException(AssistantException.Code.UNAVAILABLE,
                "El asistente no pudo procesar la solicitud.");
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
