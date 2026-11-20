package com.alquiler.furent.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.time.Duration;

/**
 * Infraestructura HTTP del asistente.
 *
 * Se define un {@link RestClient} dedicado con timeouts de conexión y lectura; el
 * transporte de Gemini lo inyecta por nombre.
 */
@Configuration
public class AssistantConfig {

    @Bean
    public RestClient geminiRestClient(AssistantProperties properties, RestClient.Builder builder) {
        Duration timeout = Duration.ofSeconds(properties.getRequestTimeoutSeconds());
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(timeout);
        factory.setReadTimeout(timeout);
        return builder.clone().requestFactory(factory).build();
    }
}
