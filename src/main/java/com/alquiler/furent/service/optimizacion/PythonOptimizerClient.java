package com.alquiler.furent.service.optimizacion;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.util.Map;

/**
 * Cliente HTTP del microservicio Python que resuelve el modelo de Investigación
 * de Operaciones. Aísla la comunicación para que el resto de la aplicación no
 * dependa del transporte ni del formato.
 */
@Component
public class PythonOptimizerClient {

    private static final ParameterizedTypeReference<Map<String, Object>> JSON_MAP =
            new ParameterizedTypeReference<>() {
            };

    private final RestClient client;

    public PythonOptimizerClient(
            @Value("${furent.optimizer.base-url:http://127.0.0.1:8090}") String baseUrl,
            @Value("${furent.optimizer.connect-timeout-ms:3000}") int connectTimeoutMs,
            @Value("${furent.optimizer.read-timeout-ms:40000}") int readTimeoutMs) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofMillis(connectTimeoutMs));
        factory.setReadTimeout(Duration.ofMillis(readTimeoutMs));
        this.client = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(factory)
                .build();
    }

    /** ¿Está disponible el microservicio? (usado para el estado de la interfaz). */
    public boolean isAvailable() {
        try {
            Map<String, Object> body = client.get()
                    .uri("/health")
                    .retrieve()
                    .body(JSON_MAP);
            return body != null && "ok".equals(body.get("status"));
        } catch (Exception e) {
            return false;
        }
    }

    /** Envía el payload del modelo y devuelve la respuesta tal cual (JSON → Map). */
    public Map<String, Object> optimize(Map<String, Object> payload) {
        try {
            return client.post()
                    .uri("/optimize")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .body(JSON_MAP);
        } catch (Exception e) {
            throw new OptimizerUnavailableException(
                    "No se pudo contactar el optimizador (" + e.getMessage() + ")", e);
        }
    }

    /** Error de comunicación con el microservicio del modelo. */
    public static class OptimizerUnavailableException extends RuntimeException {
        public OptimizerUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
