package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Base de conocimiento del asistente (políticas, FAQ y mapa de ocasiones).
 *
 * Se carga una vez desde {@code furent.assistant.knowledge-file}. Si falla, el asistente
 * sigue operativo con un texto mínimo y las herramientas siguen siendo la fuente de verdad.
 */
@Component
public class AssistantKnowledgeService {

    private static final Logger log = LoggerFactory.getLogger(AssistantKnowledgeService.class);
    private static final String FALLBACK =
            "negocio:\n  nombre: Furent\n  descripcion: Alquiler de mobiliario para eventos en Colombia.\n";

    private final AssistantProperties properties;
    private final ResourceLoader resourceLoader;
    private final Yaml yaml = new Yaml();

    private Map<String, Object> data = Collections.emptyMap();
    private String promptText = FALLBACK;

    public AssistantKnowledgeService(AssistantProperties properties, ResourceLoader resourceLoader) {
        this.properties = properties;
        this.resourceLoader = resourceLoader;
    }

    @PostConstruct
    void load() {
        Resource resource = resourceLoader.getResource(properties.getKnowledgeFile());
        if (!resource.exists()) {
            log.warn("No se encontró la base de conocimiento {}, se usa el fallback", properties.getKnowledgeFile());
            return;
        }
        try (InputStream in = resource.getInputStream()) {
            String raw = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            Object parsed = yaml.load(raw);
            if (parsed instanceof Map<?, ?> map) {
                this.data = castMap(map);
                this.promptText = stripComments(raw);
                log.info("Asistente: base de conocimiento cargada ({} secciones)", data.size());
            } else {
                log.warn("La base de conocimiento no tiene el formato esperado, se usa el fallback");
            }
        } catch (Exception e) {
            log.warn("No se pudo cargar la base de conocimiento ({}), se usa el fallback",
                    e.getMessage());
        }
    }

    /**
     * Texto de conocimiento para inyectar en el prompt del sistema.
     */
    public String renderForPrompt() {
        return promptText;
    }

    /**
     * Devuelve palabras clave asociadas a una ocasión (boda, corporativo, etc.).
     */
    public List<String> buscarOcasion(String ocasion) {
        if (ocasion == null || ocasion.isBlank()) {
            return List.of();
        }
        Object ocasiones = data.get("ocasiones");
        if (!(ocasiones instanceof Map<?, ?> map)) {
            return List.of();
        }
        String buscada = normalize(ocasion);
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            String clave = normalize(String.valueOf(entry.getKey()));
            if (clave.equals(buscada) || clave.contains(buscada) || buscada.contains(clave)) {
                Object value = entry.getValue();
                if (value instanceof List<?> list) {
                    return list.stream().map(String::valueOf).toList();
                }
            }
        }
        return List.of();
    }

    /**
     * Busca información de negocio por tema. Devuelve texto listo para el modelo o cadena vacía.
     */
    public String buscarTema(String tema) {
        if (tema == null || tema.isBlank()) {
            return "";
        }
        String buscado = normalize(tema);
        StringBuilder result = new StringBuilder();

        for (Map.Entry<String, Object> entry : data.entrySet()) {
            if ("ocasiones".equals(entry.getKey())) {
                continue;
            }
            String clave = normalize(entry.getKey());
            if (clave.contains(buscado) || buscado.contains(clave)) {
                result.append(entry.getKey()).append(":\n");
                result.append(yaml.dump(entry.getValue()).trim()).append("\n");
            }
        }

        Object faq = data.get("faq");
        if (faq instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> itemMap) {
                    String pregunta = normalize(String.valueOf(itemMap.get("pregunta")));
                    String respuesta = normalize(String.valueOf(itemMap.get("respuesta")));
                    if (pregunta.contains(buscado) || respuesta.contains(buscado)) {
                        result.append("P: ").append(itemMap.get("pregunta")).append("\n");
                        result.append("R: ").append(itemMap.get("respuesta")).append("\n");
                    }
                }
            }
        }
        return result.toString().trim();
    }

    private Map<String, Object> castMap(Map<?, ?> map) {
        Map<String, Object> result = new java.util.LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }

    private String stripComments(String raw) {
        StringBuilder sb = new StringBuilder();
        for (String line : raw.split("\r?\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("#") || trimmed.isEmpty()) {
                continue;
            }
            sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private String normalize(String value) {
        if (value == null) {
            return "";
        }
        String lower = value.toLowerCase(Locale.ROOT);
        return Normalizer.normalize(lower, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
    }
}
