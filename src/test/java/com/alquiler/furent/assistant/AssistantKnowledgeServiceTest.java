package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.DefaultResourceLoader;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AssistantKnowledgeServiceTest {

    private AssistantKnowledgeService service(String ruta) {
        AssistantProperties properties = new AssistantProperties();
        properties.setKnowledgeFile(ruta);
        AssistantKnowledgeService service = new AssistantKnowledgeService(properties, new DefaultResourceLoader());
        service.load();
        return service;
    }

    @Test
    void cargaArchivoRealYRenderizaSinComentarios() {
        AssistantKnowledgeService knowledge = service("classpath:assistant/knowledge.yml");

        String prompt = knowledge.renderForPrompt();
        assertTrue(prompt.contains("Furent"));
        assertFalse(prompt.contains("# ═══"));
    }

    @Test
    void buscarOcasionDevuelvePalabrasClave() {
        AssistantKnowledgeService knowledge = service("classpath:assistant/knowledge.yml");

        List<String> boda = knowledge.buscarOcasion("Boda");
        assertTrue(boda.stream().anyMatch(p -> p.toLowerCase().contains("sillas")));
        assertTrue(knowledge.buscarOcasion("ocasion-inexistente").isEmpty());
    }

    @Test
    void buscarTemaEncuentraPoliticasYFaq() {
        AssistantKnowledgeService knowledge = service("classpath:assistant/knowledge.yml");

        assertTrue(knowledge.buscarTema("envios").toLowerCase().contains("domicilio"));
        assertTrue(knowledge.buscarTema("garantia").length() > 0);
        assertTrue(knowledge.buscarTema("tema-inexistente").isEmpty());
    }

    @Test
    void archivoInexistenteUsaFallback() {
        AssistantKnowledgeService knowledge = service("classpath:no-existe.yml");

        assertTrue(knowledge.renderForPrompt().contains("Furent"));
        assertTrue(knowledge.buscarTema("envios").isEmpty());
    }
}
