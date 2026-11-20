package com.alquiler.furent.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.io.InputStream;

/**
 * Carga las declaraciones de herramientas desde {@code classpath:assistant/tools.json}.
 *
 * Se cargan una sola vez al inicio; si el archivo falta o es inválido, el asistente no
 * arranca (fail fast) para evitar un modelo sin herramientas.
 */
@Component
public class AssistantToolDefinitions {

    private static final Logger log = LoggerFactory.getLogger(AssistantToolDefinitions.class);
    private static final String RESOURCE = "classpath:assistant/tools.json";

    private final ResourceLoader resourceLoader;
    private final ObjectMapper mapper;
    private ArrayNode declarations;

    public AssistantToolDefinitions(ResourceLoader resourceLoader, ObjectMapper mapper) {
        this.resourceLoader = resourceLoader;
        this.mapper = mapper;
    }

    @PostConstruct
    void load() {
        Resource resource = resourceLoader.getResource(RESOURCE);
        if (!resource.exists()) {
            throw new IllegalStateException("No se encontró la definición de herramientas: " + RESOURCE);
        }
        try (InputStream in = resource.getInputStream()) {
            JsonNode root = mapper.readTree(in);
            if (!root.isArray() || root.isEmpty()) {
                throw new IllegalStateException("La definición de herramientas está vacía: " + RESOURCE);
            }
            this.declarations = (ArrayNode) root;
            log.info("Asistente: {} herramientas cargadas", declarations.size());
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("No se pudo leer la definición de herramientas: " + RESOURCE, e);
        }
    }

    public ArrayNode declarations() {
        if (declarations == null) {
            throw new IllegalStateException("Las herramientas aún no se han cargado");
        }
        return declarations;
    }

    public boolean exists(String name) {
        for (JsonNode declaration : declarations()) {
            if (name.equals(declaration.path("name").asText())) {
                return true;
            }
        }
        return false;
    }
}
