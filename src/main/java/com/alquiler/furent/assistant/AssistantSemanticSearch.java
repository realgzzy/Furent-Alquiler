package com.alquiler.furent.assistant;

import com.alquiler.furent.model.Product;
import com.alquiler.furent.service.ProductService;
import org.springframework.stereotype.Component;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Búsqueda semántica (híbrida) del catálogo para el asistente.
 *
 * El usuario no siempre usa el nombre del producto: pide "algo para sentarse", "algo para
 * colocar comida" o "muebles para una fiesta elegante". Esta clase normaliza el texto, expande
 * la intención con un mapa de conceptos y puntúa los productos por coincidencias ponderadas en
 * nombre, categoría y atributos. Se combina con la búsqueda exacta de {@link ProductService}
 * para no perder coincidencias literales.
 *
 * No usa embeddings externos: funciona con el catálogo en memoria (ya cacheado por ProductService)
 * y es determinista, sin costo por token.
 */
@Component
public class AssistantSemanticSearch {

    /** Concepto (prefijo normalizado) → términos que representan esa intención en el catálogo. */
    private static final Map<String, List<String>> CONCEPTOS = new LinkedHashMap<>();

    static {
        concepto("sent", "silla", "sillas", "sofa", "sofas", "banco", "bancos",
                "taburete", "taburetes", "puff", "sillon", "sillones", "butaca", "banqueta");
        concepto("asient", "silla", "sillas", "banco", "bancos", "taburete", "butaca");
        concepto("silla", "silla", "sillas", "tiffany", "chiavari", "ghost", "banqueta");
        concepto("comid", "mesa", "mesas", "buffet", "buffete", "comedor", "barra", "mostrador");
        concepto("comer", "mesa", "mesas", "buffet", "mantel", "manteleria");
        concepto("servir", "mesa", "mesas", "buffet", "barra", "mostrador");
        concepto("banquet", "mesa", "mesas", "manteleria", "buffet");
        concepto("elegant", "tiffany", "imperial", "ghost", "cristal", "cristales",
                "mantel", "manteleria", "carpa", "arco", "centro", "candelabro", "lujo");
        concepto("formal", "tiffany", "imperial", "manteleria", "arco", "candelabro");
        concepto("lujo", "imperial", "tiffany", "cristal");
        concepto("modern", "ghost", "cristal", "cristales", "minimalista", "metal");
        concepto("contempor", "ghost", "cristal", "minimalista");
        concepto("rustic", "madera", "tronco", "rustico", "campestre");
        concepto("madera", "madera", "tronco");
        concepto("minimal", "minimalista", "blanco", "ghost", "linnea");
        concepto("fiest", "silla", "sillas", "mesa", "mesas", "carpa", "globos",
                "decoracion", "sonido", "iluminacion");
        concepto("celebracion", "silla", "mesa", "carpa", "decoracion", "globos");
        concepto("decor", "decoracion", "centro", "centros", "globos", "flores",
                "arco", "guirnalda", "candelabro");
        concepto("ilumin", "luces", "led", "guirnalda", "iluminacion", "lampara");
        concepto("lumin", "luces", "led", "guirnalda", "iluminacion");
        concepto("musica", "sonido", "parlante", "bafle", "equipo", "altavoz");
        concepto("sonido", "sonido", "parlante", "bafle", "altavoz");
        concepto("descans", "sofa", "sillon", "puff", "colchon", "camastro");
        concepto("boda", "tiffany", "imperial", "manteleria", "arco", "carpa",
                "centro", "pasarela");
        concepto("matrimon", "tiffany", "imperial", "manteleria", "arco", "carpa");
        concepto("cumplean", "globos", "decoracion", "mesa", "silla", "inflable");
        concepto("corporat", "mesa", "silla", "tarima", "sonido", "pantalla", "stand");
        concepto("empres", "mesa", "silla", "tarima", "sonido", "pantalla", "stand");
        concepto("grado", "silla", "tarima", "arco", "manteleria", "pasarela");
        concepto("graduaci", "silla", "tarima", "arco", "pasarela");
        concepto("infantil", "globos", "inflable", "decoracion", "mesa");
        concepto("nino", "globos", "inflable", "decoracion");
    }

    private final ProductService productService;

    public AssistantSemanticSearch(ProductService productService) {
        this.productService = productService;
    }

    /**
     * Devuelve los productos más parecidos a la consulta libre, ordenados por afinidad.
     *
     * @param consulta texto del usuario ("algo para sentarse")
     * @param limite   máximo de resultados
     */
    public List<Product> search(String consulta, int limite) {
        String normalizada = normalize(consulta);
        if (normalizada.isBlank()) {
            return List.of();
        }
        Set<String> terminos = terminos(normalizada);
        List<Coincidencia> encontradas = new ArrayList<>();
        List<Product> catalogo = productService.getAllProducts();
        if (catalogo == null || catalogo.isEmpty()) {
            return List.of();
        }
        for (Product producto : catalogo) {
            double score = puntuar(producto, normalizada, terminos);
            if (score > 0) {
                encontradas.add(new Coincidencia(producto, score));
            }
        }
        encontradas.sort(Comparator.comparingDouble(Coincidencia::score).reversed());
        return encontradas.stream()
                .limit(Math.max(1, limite))
                .map(Coincidencia::producto)
                .toList();
    }

    private double puntuar(Product producto, String consulta, Set<String> terminos) {
        String nombre = normalize(producto.getNombre());
        String categoria = normalize(producto.getCategoriaNombre());
        String detalle = normalize(String.join(" ", valor(producto.getDescripcion()),
                valor(producto.getDescripcionCorta()), valor(producto.getMaterial()), valor(producto.getColor())));

        double score = 0;
        if (nombre.contains(consulta)) {
            score += 6;
        }
        if (categoria.contains(consulta)) {
            score += 4;
        }
        for (String termino : terminos) {
            if (termino.length() < 3) {
                continue;
            }
            if (nombre.contains(termino)) {
                score += 3;
            }
            if (categoria.contains(termino)) {
                score += 2.5;
            }
            if (detalle.contains(termino)) {
                score += 1;
            }
        }
        return score;
    }

    /** Términos efectivos: palabras de la consulta + expansión por conceptos. */
    private Set<String> terminos(String normalizada) {
        Set<String> terminos = new LinkedHashSet<>();
        for (String palabra : normalizada.split("[^a-z0-9]+")) {
            if (palabra.length() >= 3) {
                terminos.add(palabra);
                if (palabra.endsWith("es") && palabra.length() > 5) {
                    terminos.add(palabra.substring(0, palabra.length() - 2));
                } else if (palabra.endsWith("s") && palabra.length() > 4) {
                    terminos.add(palabra.substring(0, palabra.length() - 1));
                }
            }
        }
        for (Map.Entry<String, List<String>> entry : CONCEPTOS.entrySet()) {
            if (contienePrefijo(normalizada, entry.getKey())) {
                terminos.addAll(entry.getValue());
            }
        }
        return terminos;
    }

    /** ¿Alguna palabra de la consulta empieza por el prefijo/concepto? */
    private boolean contienePrefijo(String normalizada, String prefijo) {
        for (String palabra : normalizada.split("[^a-z0-9]+")) {
            if (palabra.length() >= 4 && palabra.startsWith(prefijo)) {
                return true;
            }
        }
        return false;
    }

    private static void concepto(String prefijo, String... palabras) {
        CONCEPTOS.put(prefijo, List.of(palabras));
    }

    private static String valor(String texto) {
        return texto == null ? "" : texto;
    }

    private static String normalize(String valor) {
        if (valor == null) {
            return "";
        }
        String minuscula = valor.toLowerCase(Locale.ROOT);
        return Normalizer.normalize(minuscula, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
    }

    private record Coincidencia(Product producto, double score) {
    }
}
