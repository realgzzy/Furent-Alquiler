package com.alquiler.furent.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
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

    /**
     * Spring Boot 4 auto-configura Jackson 3 y no expone el bean de Jackson 2
     * ({@code com.fasterxml.jackson.databind.ObjectMapper}) que usan el asistente y
     * otras partes del proyecto. Se define aquí uno compartido.
     */
    @Bean
    public ObjectMapper objectMapper() {
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    @Bean
    public RestClient geminiRestClient(AssistantProperties properties) {
        Duration timeout = Duration.ofSeconds(properties.getRequestTimeoutSeconds());
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(timeout);
        factory.setReadTimeout(timeout);
        return RestClient.builder().requestFactory(factory).build();
    }
}
