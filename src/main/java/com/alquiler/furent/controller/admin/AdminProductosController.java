package com.alquiler.furent.controller.admin;

import com.alquiler.furent.model.Category;
import com.alquiler.furent.model.Combo;
import com.alquiler.furent.model.Product;
import com.alquiler.furent.service.AuditLogService;
import com.alquiler.furent.service.ProductService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Controller
@RequestMapping("/admin")
public class AdminProductosController {

    private static final Logger log = LoggerFactory.getLogger(AdminProductosController.class);

    private final ProductService productService;
    private final AuditLogService auditLogService;
    private final ObjectMapper objectMapper;

    public AdminProductosController(ProductService productService, AuditLogService auditLogService,
                                    ObjectMapper objectMapper) {
        this.productService = productService;
        this.auditLogService = auditLogService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/mobiliarios")
    public String listProducts(Model model) {
        List<Product> productos = productService.getAllProducts();
        List<Category> categorias = productService.getAllCategories();
        List<Combo> combos = productService.getAllCombos();

        model.addAttribute("mobiliariosJson", toJson(buildPayload(productos, categorias, combos)));

        // Compatibilidad con la plantilla anterior.
        model.addAttribute("productos", productos);
        model.addAttribute("categorias", categorias);
        model.addAttribute("combos", combos);
        return "admin/mobiliarios";
    }

    @PostMapping("/mobiliarios/guardar")
    public String saveProduct(@RequestParam String nombre, @RequestParam String descripcion,
            @RequestParam String descripcionCorta, @RequestParam BigDecimal precioPorDia,
            @RequestParam(required = false) List<MultipartFile> galeriaArchivos,
            @RequestParam String categoriaNombre,
            @RequestParam String material, @RequestParam String dimensiones,
            @RequestParam String color, @RequestParam int cantidadMinima,
            @RequestParam int cantidadMaxima, @RequestParam int stock,
            @RequestParam(defaultValue = "10") int stockMinimo,
            @RequestParam(defaultValue = "OPERATIVO") String estadoMantenimiento,
            @RequestParam(required = false) String notasMantenimiento,
            @RequestParam(required = false) String id,
            Authentication authentication,
            RedirectAttributes redirectAttributes) {
        Product product;
        boolean isNew = (id == null || id.isEmpty());
        if (!isNew) {
            product = productService.getProductById(id).orElse(new Product());
        } else {
            product = new Product();
        }

        if (isNew && (galeriaArchivos == null || galeriaArchivos.isEmpty() || galeriaArchivos.get(0).isEmpty())) {
            redirectAttributes.addFlashAttribute("error", "Es obligatorio subir imágenes para un nuevo mobiliario.");
            return "redirect:/admin/mobiliarios";
        }

        long countValidFiles = (galeriaArchivos == null) ? 0 : galeriaArchivos.stream().filter(f -> !f.isEmpty()).count();
        if (countValidFiles > 5) {
            redirectAttributes.addFlashAttribute("error", "Solo se permiten un máximo de 5 imágenes.");
            return "redirect:/admin/mobiliarios";
        }

        product.setNombre(nombre);
        product.setDescripcion(descripcion);
        product.setDescripcionCorta(descripcionCorta);
        product.setPrecioPorDia(precioPorDia);

        try {
            Path uploadDir = Paths.get("uploads");
            if (!Files.exists(uploadDir)) {
                Files.createDirectories(uploadDir);
            }

            if (galeriaArchivos != null && countValidFiles > 0) {
                List<String> urls = new ArrayList<>();
                for (MultipartFile file : galeriaArchivos) {
                    if (!file.isEmpty()) {
                        if (file.getSize() > 104857600) { // 100MB
                            redirectAttributes.addFlashAttribute("error", "El archivo " + file.getOriginalFilename() + " excede los 100MB.");
                            return "redirect:/admin/mobiliarios";
                        }
                        String fileName = StringUtils.cleanPath(file.getOriginalFilename());
                        String uniqueFileName = UUID.randomUUID().toString() + "_" + fileName;
                        Path filePath = uploadDir.resolve(uniqueFileName);
                        Files.copy(file.getInputStream(), filePath, StandardCopyOption.REPLACE_EXISTING);
                        urls.add("/uploads/" + uniqueFileName);
                    }
                }
                if (!urls.isEmpty()) {
                    product.setImagenUrl(urls.get(0));
                    product.setGalleryImages(urls);
                }
            }
        } catch (Exception e) {
            log.error("Error al guardar archivos de imagen: {}", e.getMessage());
            redirectAttributes.addFlashAttribute("error", "Error al subir imágenes: " + e.getMessage());
            return "redirect:/admin/mobiliarios";
        }

        product.setCategoriaNombre(categoriaNombre);
        product.setMaterial(material);
        product.setDimensiones(dimensiones);
        product.setColor(color);
        product.setCantidadMinima(cantidadMinima);
        product.setCantidadMaxima(cantidadMaxima);
        product.setStock(stock);
        product.setStockMinimo(stockMinimo);
        product.setEstadoMantenimiento(normalizaEstado(estadoMantenimiento));
        product.setNotasMantenimiento(notasMantenimiento);

        boolean available = stock > 0
                && !"EN_MANTENIMIENTO".equals(estadoMantenimiento)
                && !"FUERA_DE_SERVICIO".equals(estadoMantenimiento)
                && !"EN_REPARACION".equals(estadoMantenimiento);
        product.setDisponible(available);

        productService.saveProduct(product);

        String action = (id != null && !id.isEmpty()) ? "ACTUALIZAR" : "CREAR";
        String detail = String.format("Mobiliario: %s | Stock: %d | Estado: %s | Disp: %b",
                nombre, stock, estadoMantenimiento, available);
        auditLogService.log(authentication.getName(), action, "PRODUCTO", product.getId(), detail);

        redirectAttributes.addFlashAttribute("success", "Mobiliario guardado exitosamente");
        return "redirect:/admin/mobiliarios";
    }

    @PostMapping("/mobiliarios/eliminar/{id}")
    public String deleteProduct(@PathVariable String id, RedirectAttributes redirectAttributes) {
        productService.deleteProduct(id);
        redirectAttributes.addFlashAttribute("success", "Mobiliario eliminado");
        return "redirect:/admin/mobiliarios";
    }

    // === CATEGORÍAS ===
    @GetMapping("/categorias")
    public String listCategories(Model model) {
        List<Category> categorias = productService.getAllCategories();
        List<Product> productos = productService.getAllProducts();

        model.addAttribute("categoriasJson", toJson(buildCategoriasPayload(categorias, productos)));

        // Compatibilidad con la plantilla anterior.
        model.addAttribute("categorias", categorias);
        return "admin/categorias";
    }

    @PostMapping("/categorias/guardar")
    public String saveCategory(@RequestParam String nombre, @RequestParam(required = false) String descripcion,
            @RequestParam(required = false) String icono, @RequestParam(required = false) String slug,
            @RequestParam(required = false) String id,
            RedirectAttributes redirectAttributes) {
        String nombreLimpio = nombre == null ? "" : nombre.trim();
        if (nombreLimpio.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", "El nombre de la colección es obligatorio.");
            return "redirect:/admin/categorias";
        }

        Category category;
        if (id != null && !id.isEmpty()) {
            category = productService.getCategoryById(id).orElse(new Category());
        } else {
            category = new Category();
        }
        category.setNombre(nombreLimpio);
        category.setDescripcion(descripcion == null ? "" : descripcion.trim());
        category.setIcono(texto(icono, "tag"));
        category.setSlug(slugify(slug != null && !slug.isBlank() ? slug : nombreLimpio));
        productService.saveCategory(category);
        redirectAttributes.addFlashAttribute("success", "Colección guardada exitosamente");
        return "redirect:/admin/categorias";
    }

    @PostMapping("/categorias/eliminar/{id}")
    public String deleteCategory(@PathVariable String id, RedirectAttributes redirectAttributes) {
        try {
            productService.deleteCategory(id);
            redirectAttributes.addFlashAttribute("success", "Colección eliminada");
        } catch (Exception e) {
            redirectAttributes.addFlashAttribute("error",
                    e.getMessage() != null ? e.getMessage() : "No se pudo eliminar la colección.");
        }
        return "redirect:/admin/categorias";
    }

    // === COMBOS ===
    @PostMapping("/combos/guardar")
    public String saveCombo(@RequestParam String comboNombre,
            @RequestParam String comboDescripcion,
            @RequestParam BigDecimal comboPrice,
            @RequestParam(required = false) List<String> comboProductoIds,
            @RequestParam(required = false) List<Integer> comboCantidades,
            @RequestParam(defaultValue = "true") boolean comboActivo,
            @RequestParam(required = false) MultipartFile comboImagen,
            @RequestParam(required = false) String comboId,
            Authentication authentication,
            RedirectAttributes redirectAttributes) {

        if (comboProductoIds == null || comboProductoIds.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", "Debes agregar al menos un producto al combo.");
            return "redirect:/admin/mobiliarios";
        }

        Combo combo;
        boolean isNew = (comboId == null || comboId.isEmpty());
        if (!isNew) {
            combo = productService.getComboById(comboId).orElse(new Combo());
        } else {
            combo = new Combo();
        }

        combo.setNombre(comboNombre);
        combo.setDescripcion(comboDescripcion);
        combo.setPrecioCombo(comboPrice);
        combo.setActivo(comboActivo);

        // Handle image upload
        try {
            if (comboImagen != null && !comboImagen.isEmpty()) {
                java.nio.file.Path uploadDir = java.nio.file.Paths.get("uploads");
                if (!java.nio.file.Files.exists(uploadDir)) {
                    java.nio.file.Files.createDirectories(uploadDir);
                }
                String fileName = java.util.UUID.randomUUID().toString() + "_" +
                        org.springframework.util.StringUtils.cleanPath(comboImagen.getOriginalFilename());
                java.nio.file.Path filePath = uploadDir.resolve(fileName);
                java.nio.file.Files.copy(comboImagen.getInputStream(), filePath,
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                combo.setImagenUrl("/uploads/" + fileName);
            }
        } catch (Exception e) {
            log.error("Error al subir imagen del combo: {}", e.getMessage());
        }

        // Build combo items from selected products
        java.util.List<Combo.ComboItem> items = new java.util.ArrayList<>();
        BigDecimal precioOriginal = BigDecimal.ZERO;

        for (int i = 0; i < comboProductoIds.size(); i++) {
            String prodId = comboProductoIds.get(i);
            int qty = (comboCantidades != null && i < comboCantidades.size()) ? comboCantidades.get(i) : 1;
            var productOpt = productService.getProductById(prodId);
            if (productOpt.isPresent()) {
                Product p = productOpt.get();
                Combo.ComboItem item = new Combo.ComboItem(
                        p.getId(), p.getNombre(), p.getImagenUrl(), p.getPrecioPorDia(), qty);
                items.add(item);
                precioOriginal = precioOriginal.add(p.getPrecioPorDia().multiply(BigDecimal.valueOf(qty)));
            }
        }

        combo.setItems(items);
        combo.setPrecioOriginal(precioOriginal);

        // Calculate discount percentage
        if (precioOriginal.compareTo(BigDecimal.ZERO) > 0) {
            double discount = (1 - comboPrice.doubleValue() / precioOriginal.doubleValue()) * 100;
            combo.setPorcentajeDescuento(Math.max(0, Math.round(discount * 10.0) / 10.0));
        }

        productService.saveCombo(combo);

        String action = isNew ? "CREAR" : "ACTUALIZAR";
        auditLogService.log(authentication.getName(), action, "COMBO", combo.getId(),
                "Combo: " + comboNombre + " | Items: " + items.size());

        redirectAttributes.addFlashAttribute("success", "Combo guardado exitosamente");
        return "redirect:/admin/mobiliarios";
    }

    @PostMapping("/combos/eliminar/{id}")
    public String deleteCombo(@PathVariable String id, RedirectAttributes redirectAttributes) {
        productService.deleteCombo(id);
        redirectAttributes.addFlashAttribute("success", "Combo eliminado");
        return "redirect:/admin/mobiliarios";
    }

    // ═══════════════════════════════════════════════════════════
    // Helpers · vista JSON para la bandeja interactiva
    // ═══════════════════════════════════════════════════════════

    private Map<String, Object> buildPayload(List<Product> productos, List<Category> categorias, List<Combo> combos) {
        Map<String, Object> payload = new LinkedHashMap<>();

        BigDecimal valorInventario = BigDecimal.ZERO;
        BigDecimal sumaPrecios = BigDecimal.ZERO;
        int conPrecio = 0;
        for (Product p : productos) {
            if (p.getPrecioPorDia() != null) {
                valorInventario = valorInventario.add(p.getPrecioPorDia().multiply(BigDecimal.valueOf(Math.max(0, p.getStock()))));
                sumaPrecios = sumaPrecios.add(p.getPrecioPorDia());
                conPrecio++;
            }
        }

        long disponibles = productos.stream().filter(Product::isDisponible).count();
        long bajoStock = productos.stream().filter(Product::isBajoStock).count();
        long mantenimiento = productos.stream().filter(p -> "EN_MANTENIMIENTO".equals(estado(p))).count();
        long fueraServicio = productos.stream().filter(p -> "FUERA_DE_SERVICIO".equals(estado(p))).count();

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("total", productos.size());
        stats.put("disponibles", disponibles);
        stats.put("bajoStock", bajoStock);
        stats.put("mantenimiento", mantenimiento);
        stats.put("fueraServicio", fueraServicio);
        stats.put("combos", combos.size());
        stats.put("categorias", categorias.size());
        stats.put("valorInventario", valorInventario.setScale(0, RoundingMode.HALF_UP));
        stats.put("precioPromedio", conPrecio > 0
                ? sumaPrecios.divide(BigDecimal.valueOf(conPrecio), 0, RoundingMode.HALF_UP)
                : BigDecimal.ZERO);
        payload.put("stats", stats);

        List<Map<String, Object>> vistaProductos = new ArrayList<>();
        for (Product p : productos) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", p.getId());
            v.put("nombre", texto(p.getNombre(), "Mobiliario sin nombre"));
            v.put("descripcion", texto(p.getDescripcion(), ""));
            v.put("descripcionCorta", texto(p.getDescripcionCorta(), ""));
            v.put("precio", p.getPrecioPorDia() != null ? p.getPrecioPorDia() : BigDecimal.ZERO);
            v.put("categoria", texto(p.getCategoriaNombre(), "Sin categoría"));
            v.put("material", texto(p.getMaterial(), "—"));
            v.put("dimensiones", texto(p.getDimensiones(), "—"));
            v.put("color", texto(p.getColor(), ""));
            v.put("cantidadMinima", p.getCantidadMinima());
            v.put("cantidadMaxima", p.getCantidadMaxima());
            v.put("stock", p.getStock());
            v.put("stockMinimo", p.getStockMinimo());
            v.put("estado", estado(p));
            v.put("notas", texto(p.getNotasMantenimiento(), ""));
            v.put("imagen", texto(p.getImagenUrl(), ""));
            v.put("galeria", p.getGalleryImages() != null ? p.getGalleryImages() : List.of());
            v.put("disponible", p.isDisponible());
            v.put("bajoStock", p.isBajoStock());
            v.put("calificacion", Math.round(p.getCalificacion() * 10.0) / 10.0);
            v.put("resenas", p.getCantidadResenas());
            vistaProductos.add(v);
        }
        payload.put("productos", vistaProductos);

        List<Map<String, Object>> vistaCategorias = new ArrayList<>();
        for (Category c : categorias) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", c.getId());
            v.put("nombre", texto(c.getNombre(), "Categoría"));
            v.put("cantidad", productos.stream()
                    .filter(p -> c.getNombre() != null && c.getNombre().equalsIgnoreCase(p.getCategoriaNombre()))
                    .count());
            vistaCategorias.add(v);
        }
        payload.put("categorias", vistaCategorias);

        List<Map<String, Object>> vistaCombos = new ArrayList<>();
        for (Combo combo : combos) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", combo.getId());
            v.put("nombre", texto(combo.getNombre(), "Combo"));
            v.put("descripcion", texto(combo.getDescripcion(), ""));
            v.put("imagen", texto(combo.getImagenUrl(), ""));
            v.put("activo", combo.isActivo());
            v.put("precioCombo", combo.getPrecioCombo() != null ? combo.getPrecioCombo() : BigDecimal.ZERO);
            v.put("precioOriginal", combo.getPrecioOriginal() != null ? combo.getPrecioOriginal() : BigDecimal.ZERO);
            v.put("descuento", combo.getPorcentajeDescuento());
            List<Map<String, Object>> items = new ArrayList<>();
            if (combo.getItems() != null) {
                for (Combo.ComboItem it : combo.getItems()) {
                    Map<String, Object> iv = new LinkedHashMap<>();
                    iv.put("productoId", texto(it.getProductoId(), ""));
                    iv.put("nombre", texto(it.getProductoNombre(), "Producto"));
                    iv.put("imagen", texto(it.getProductoImagen(), ""));
                    iv.put("precio", it.getPrecioPorDia() != null ? it.getPrecioPorDia() : BigDecimal.ZERO);
                    iv.put("cantidad", it.getCantidad());
                    items.add(iv);
                }
            }
            v.put("items", items);
            vistaCombos.add(v);
        }
        payload.put("combos", vistaCombos);

        return payload;
    }

    // ═══════════════════════════════════════════════════════════
    // Helpers · vista JSON para la mesa de colecciones
    // ═══════════════════════════════════════════════════════════

    private Map<String, Object> buildCategoriasPayload(List<Category> categorias, List<Product> productos) {
        Map<String, Object> payload = new LinkedHashMap<>();

        Set<String> nombres = new HashSet<>();
        for (Category c : categorias) {
            if (c.getNombre() != null) nombres.add(c.getNombre().trim().toLowerCase());
        }

        List<Map<String, Object>> sinCategoria = new ArrayList<>();
        Map<String, List<Map<String, Object>>> porCategoria = new LinkedHashMap<>();

        for (Product p : productos) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", p.getId());
            v.put("nombre", texto(p.getNombre(), "Mobiliario sin nombre"));
            v.put("imagen", texto(p.getImagenUrl(), ""));

            String cat = p.getCategoriaNombre();
            if (cat == null || cat.isBlank() || !nombres.contains(cat.trim().toLowerCase())) {
                sinCategoria.add(v);
            } else {
                porCategoria.computeIfAbsent(cat.trim().toLowerCase(), k -> new ArrayList<>()).add(v);
            }
        }

        List<Map<String, Object>> vistaCategorias = new ArrayList<>();
        int clasificados = 0;
        int enUso = 0;
        for (Category c : categorias) {
            List<Map<String, Object>> prods = (c.getNombre() == null)
                    ? List.of()
                    : porCategoria.getOrDefault(c.getNombre().trim().toLowerCase(), List.of());
            if (!prods.isEmpty()) enUso++;
            clasificados += prods.size();

            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", c.getId());
            v.put("nombre", texto(c.getNombre(), "Colección sin nombre"));
            v.put("descripcion", texto(c.getDescripcion(), ""));
            v.put("icono", texto(c.getIcono(), "tag"));
            v.put("slug", texto(c.getSlug(), ""));
            v.put("cantidad", prods.size());
            v.put("productos", prods);
            vistaCategorias.add(v);
        }

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("total", categorias.size());
        stats.put("enUso", enUso);
        stats.put("vacias", Math.max(0, categorias.size() - enUso));
        stats.put("clasificados", clasificados);
        stats.put("sinCategoria", sinCategoria.size());
        payload.put("stats", stats);
        payload.put("categorias", vistaCategorias);
        payload.put("sinCategoria", sinCategoria);

        return payload;
    }

    private String slugify(String valor) {
        if (valor == null) return "";
        String base = java.text.Normalizer.normalize(valor, java.text.Normalizer.Form.NFD)
                .replaceAll("\\p{InCombiningDiacriticalMarks}+", "");
        return base.toLowerCase().trim()
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-+|-+$)", "");
    }

    private String estado(Product p) {
        String e = p.getEstadoMantenimiento();
        if ("EN_MANTENIMIENTO".equals(e) || "FUERA_DE_SERVICIO".equals(e)) {
            return e;
        }
        return "OPERATIVO";
    }

    private String normalizaEstado(String estado) {
        if ("EN_MANTENIMIENTO".equals(estado) || "FUERA_DE_SERVICIO".equals(estado)) {
            return estado;
        }
        return "OPERATIVO";
    }

    private String texto(String v, String fallback) {
        return v != null && !v.isBlank() ? v.trim() : fallback;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"stats\":{},\"productos\":[],\"categorias\":[],\"combos\":[]}";
        }
    }
}
