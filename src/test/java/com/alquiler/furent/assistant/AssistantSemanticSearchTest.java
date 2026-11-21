package com.alquiler.furent.assistant;

import com.alquiler.furent.model.Product;
import com.alquiler.furent.service.ProductService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.lenient;

@ExtendWith(MockitoExtension.class)
class AssistantSemanticSearchTest {

    @Mock
    private ProductService productService;

    private AssistantSemanticSearch search;

    @BeforeEach
    void setUp() {
        search = new AssistantSemanticSearch(productService);
        lenient().when(productService.getAllProducts()).thenReturn(List.of(
                product("s1", "Silla Tiffany", "Sillas", "Silla elegante de madera y resina"),
                product("m1", "Mesa Imperial", "Mesas", "Mesa redonda para banquetes"),
                product("c1", "Carpa Pagoda", "Carpas", "Estructura para cubrir eventos")));
    }

    @Test
    void interpretaConceptosYOrdenaPorAfinidad() {
        List<Product> sillas = search.search("algo para sentarse", 3);
        assertTrue(sillas.size() >= 1);
        assertEquals("s1", sillas.get(0).getId());
    }

    @Test
    void entiendeIntencionDeComer() {
        List<Product> mesas = search.search("algo para colocar comida", 3);
        assertTrue(mesas.size() >= 1);
        assertEquals("m1", mesas.get(0).getId());
    }

    @Test
    void consultaVaciaNoDevuelveNada() {
        assertTrue(search.search("   ", 3).isEmpty());
    }

    private Product product(String id, String nombre, String categoria, String descripcion) {
        Product p = new Product();
        p.setId(id);
        p.setNombre(nombre);
        p.setCategoriaNombre(categoria);
        p.setDescripcion(descripcion);
        p.setDisponible(true);
        return p;
    }
}
