package com.alquiler.furent.controller.admin;

import com.alquiler.furent.model.ContactMessage;
import com.alquiler.furent.model.Review;
import com.alquiler.furent.repository.ProductRepository;
import com.alquiler.furent.service.ContactService;
import com.alquiler.furent.service.ReviewService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Bandeja de entrada del administrador: mensajes de contacto y reseñas de productos.
 * Entrega una vista "JSON" (igual que Reservas) que alimenta la tabla interactiva,
 * los filtros, el inspector y los modales del lado del cliente.
 */
@Controller
@RequestMapping("/admin")
public class AdminMensajesController {

    private final ContactService contactService;
    private final ReviewService reviewService;
    private final ProductRepository productRepository;
    private final ObjectMapper objectMapper;

    public AdminMensajesController(ContactService contactService,
                                   ReviewService reviewService,
                                   ProductRepository productRepository,
                                   ObjectMapper objectMapper) {
        this.contactService = contactService;
        this.reviewService = reviewService;
        this.productRepository = productRepository;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/mensajes")
    public String listMessagesAndReviews(Model model) {
        List<ContactMessage> mensajes = contactService.getAll();
        List<Review> resenas = reviewService.getAllReviews();

        // Nombres de producto (para mostrar la reseña con contexto).
        Map<String, String> productNames = new HashMap<>();
        for (Review r : resenas) {
            if (r.getProductId() != null && !productNames.containsKey(r.getProductId())) {
                productRepository.findById(r.getProductId())
                        .ifPresent(p -> productNames.put(r.getProductId(), p.getNombre()));
            }
        }

        long noLeidos = mensajes.stream().filter(m -> !m.isLeido()).count();
        long pendientes = resenas.stream()
                .filter(r -> r.getAdminResponse() == null || r.getAdminResponse().isBlank())
                .count();
        double promedio = resenas.stream().mapToInt(Review::getRating).average().orElse(0.0);

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("mensajes", mensajes.size());
        stats.put("noLeidos", noLeidos);
        stats.put("resenas", resenas.size());
        stats.put("pendientes", pendientes);
        stats.put("ratingPromedio", Math.round(promedio * 10.0) / 10.0);

        // ── Vista de mensajes ──
        List<Map<String, Object>> vistaMensajes = new ArrayList<>();
        for (ContactMessage m : mensajes) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", m.getId());
            v.put("nombre", texto(m.getNombre(), "Remitente anónimo"));
            v.put("email", texto(m.getEmail(), ""));
            v.put("telefono", texto(m.getTelefono(), ""));
            v.put("asunto", texto(m.getAsunto(), "Sin asunto"));
            v.put("mensaje", texto(m.getMensaje(), ""));
            v.put("leido", m.isLeido());
            v.put("fecha", m.getFechaCreacion() != null ? m.getFechaCreacion().toString() : "");
            vistaMensajes.add(v);
        }

        // ── Vista de reseñas ──
        List<Map<String, Object>> vistaResenas = new ArrayList<>();
        for (Review r : resenas) {
            boolean respondido = r.getAdminResponse() != null && !r.getAdminResponse().isBlank();
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", r.getId());
            v.put("userName", texto(r.getUserName(), "Usuario"));
            v.put("productId", texto(r.getProductId(), ""));
            v.put("productName", producto(productNames, r.getProductId()));
            v.put("rating", r.getRating());
            v.put("comment", texto(r.getComment(), ""));
            v.put("adminResponse", texto(r.getAdminResponse(), ""));
            v.put("respondido", respondido);
            v.put("fecha", r.getCreatedAt() != null ? r.getCreatedAt().toString() : "");
            vistaResenas.add(v);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("stats", stats);
        payload.put("mensajes", vistaMensajes);
        payload.put("resenas", vistaResenas);
        model.addAttribute("mensajesJson", toJson(payload));

        // Compatibilidad con la plantilla anterior.
        model.addAttribute("mensajes", mensajes);
        model.addAttribute("resenas", resenas);
        model.addAttribute("noLeidos", noLeidos);
        model.addAttribute("productNames", productNames);

        return "admin/mensajes";
    }

    @PostMapping("/mensajes/leer/{id}")
    public String markMessageRead(@PathVariable String id, RedirectAttributes redirectAttributes) {
        contactService.markAsRead(id);
        return "redirect:/admin/mensajes";
    }

    @PostMapping("/mensajes/eliminar/{id}")
    public String deleteMessage(@PathVariable String id, RedirectAttributes redirectAttributes) {
        contactService.delete(id);
        redirectAttributes.addFlashAttribute("success", "Mensaje eliminado");
        return "redirect:/admin/mensajes";
    }

    @PostMapping("/resenas/eliminar/{id}")
    public String deleteReview(@PathVariable String id, RedirectAttributes redirectAttributes) {
        reviewService.deleteReview(id);
        redirectAttributes.addFlashAttribute("success", "Reseña eliminada");
        return "redirect:/admin/mensajes";
    }

    @PostMapping("/resenas/responder/{id}")
    public String respondToReview(@PathVariable String id, @RequestParam String respuesta,
                                  RedirectAttributes redirectAttributes) {
        reviewService.respondToReview(id, respuesta);
        redirectAttributes.addFlashAttribute("success", "Respuesta publicada");
        return "redirect:/admin/mensajes";
    }

    // ── Helpers ─────────────────────────────────────────────────

    private String texto(String v, String fallback) {
        return v != null && !v.isBlank() ? v.trim() : fallback;
    }

    private String producto(Map<String, String> names, String productId) {
        if (productId == null) {
            return "Mobiliario sin referencia";
        }
        String name = names.get(productId);
        return name != null && !name.isBlank() ? name : "Mobiliario #" + productId;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"stats\":{},\"mensajes\":[],\"resenas\":[]}";
        }
    }
}
