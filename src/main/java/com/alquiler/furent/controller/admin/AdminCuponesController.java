package com.alquiler.furent.controller.admin;

import com.alquiler.furent.model.Coupon;
import com.alquiler.furent.model.Category;
import com.alquiler.furent.repository.CategoryRepository;
import com.alquiler.furent.service.CouponService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Controlador administrativo de cupones.
 *
 * Sirve la vista de gestión, serializa los cupones (y las categorías del
 * catálogo) como JSON para que la interfaz filtre, ordene y pagine sin
 * recargar, y expone las acciones de alta, activación y borrado.
 */
@Controller
@RequestMapping("/admin/cupones")
public class AdminCuponesController {

    private final CouponService couponService;
    private final CategoryRepository categoryRepository;
    private final ObjectMapper objectMapper;

    public AdminCuponesController(CouponService couponService,
            CategoryRepository categoryRepository,
            ObjectMapper objectMapper) {
        this.couponService = couponService;
        this.categoryRepository = categoryRepository;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public String listCoupons(Model model) {
        List<Coupon> cupones = couponService.getAll();
        List<String> categorias = categoryRepository.findAll().stream()
                .map(Category::getNombre)
                .filter(n -> n != null && !n.isBlank())
                .sorted()
                .toList();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("cupones", toViewModels(cupones));
        payload.put("categorias", categorias);

        model.addAttribute("cupones", cupones);
        model.addAttribute("categorias", categorias);
        model.addAttribute("cuponesJson", toJson(payload));
        return "admin/cupones";
    }

    @PostMapping("/guardar")
    public String saveCoupon(@RequestParam(required = false) String id,
            @RequestParam(required = false) String codigo,
            @RequestParam(required = false) String tipo,
            @RequestParam(required = false) String valor,
            @RequestParam(required = false) String validoDesde,
            @RequestParam(required = false) String validoHasta,
            @RequestParam(defaultValue = "0") String usosMaximos,
            @RequestParam(defaultValue = "0") String montoMinimo,
            @RequestParam(defaultValue = "true") boolean activo,
            @RequestParam(required = false) List<String> categoriasAplicables,
            RedirectAttributes redirectAttributes) {

        boolean esNuevo = id == null || id.isBlank();
        List<String> errores = new ArrayList<>();

        String cod = codigo == null ? "" : codigo.trim().toUpperCase();
        if (cod.isEmpty()) {
            errores.add("El código es obligatorio.");
        } else if (cod.length() < 3) {
            errores.add("El código debe tener al menos 3 caracteres.");
        }

        String tp = "MONTO_FIJO".equals(tipo) ? "MONTO_FIJO" : "PORCENTAJE";

        BigDecimal val = null;
        try {
            val = new BigDecimal(valor);
        } catch (Exception ignored) {
        }
        if (val == null || val.signum() <= 0) {
            errores.add("El valor del descuento debe ser mayor que cero.");
        } else if ("PORCENTAJE".equals(tp) && val.compareTo(BigDecimal.valueOf(100)) > 0) {
            errores.add("El porcentaje no puede superar el 100%.");
        }

        LocalDate d1 = null, d2 = null;
        try {
            d1 = LocalDate.parse(validoDesde);
        } catch (Exception ignored) {
        }
        try {
            d2 = LocalDate.parse(validoHasta);
        } catch (Exception ignored) {
        }
        if (d1 == null || d2 == null) {
            errores.add("Indica la fecha de inicio y la de fin de vigencia.");
        } else if (d2.isBefore(d1)) {
            errores.add("La fecha de fin no puede ser anterior a la de inicio.");
        }

        int usos;
        try {
            usos = Integer.parseInt(usosMaximos);
        } catch (Exception e) {
            usos = 0;
        }
        if (usos < 0) {
            errores.add("Los usos máximos no pueden ser negativos.");
        }

        BigDecimal min = BigDecimal.ZERO;
        try {
            min = new BigDecimal(montoMinimo);
        } catch (Exception ignored) {
        }
        if (min.signum() < 0) {
            errores.add("El monto mínimo no puede ser negativo.");
        }

        if (!cod.isEmpty()) {
            String codigoFinal = cod;
            couponService.getByCodigo(codigoFinal).ifPresent(existente -> {
                if (esNuevo || !existente.getId().equals(id)) {
                    errores.add("Ya existe un cupón con el código " + codigoFinal + ".");
                }
            });
        }

        if (!errores.isEmpty()) {
            redirectAttributes.addFlashAttribute("error", String.join(" ", errores));
            return "redirect:/admin/cupones";
        }

        Coupon coupon = esNuevo ? new Coupon() : couponService.getById(id).orElse(new Coupon());
        coupon.setCodigo(cod);
        coupon.setTipo(tp);
        coupon.setValor(val.setScale(2, RoundingMode.HALF_UP));
        coupon.setValidoDesde(d1);
        coupon.setValidoHasta(d2);
        coupon.setUsosMaximos(usos);
        coupon.setMontoMinimo(min.setScale(2, RoundingMode.HALF_UP));
        coupon.setActivo(activo);
        coupon.setCategoriasAplicables(categoriasAplicables == null ? List.of() : categoriasAplicables);
        couponService.save(coupon);

        redirectAttributes.addFlashAttribute("success",
                esNuevo ? "Cupón creado correctamente." : "Cupón actualizado correctamente.");
        return "redirect:/admin/cupones";
    }

    @PostMapping("/activar/{id}")
    @ResponseBody
    public Map<String, Object> toggleActivo(@PathVariable String id, @RequestParam boolean activo) {
        Map<String, Object> resp = new LinkedHashMap<>();
        Coupon coupon = couponService.getById(id).orElse(null);
        if (coupon == null) {
            resp.put("ok", false);
            resp.put("message", "Cupón no encontrado.");
            return resp;
        }
        coupon.setActivo(activo);
        couponService.save(coupon);
        resp.put("ok", true);
        resp.put("id", id);
        resp.put("activo", activo);
        return resp;
    }

    @PostMapping("/eliminar/{id}")
    public String deleteCoupon(@PathVariable String id, RedirectAttributes redirectAttributes) {
        couponService.delete(id);
        redirectAttributes.addFlashAttribute("success", "Cupón eliminado.");
        return "redirect:/admin/cupones";
    }

    private List<Map<String, Object>> toViewModels(List<Coupon> cupones) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Coupon c : cupones) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId());
            m.put("codigo", c.getCodigo());
            m.put("tipo", c.getTipo());
            m.put("valor", c.getValor());
            m.put("validoDesde", c.getValidoDesde() != null ? c.getValidoDesde().toString() : "");
            m.put("validoHasta", c.getValidoHasta() != null ? c.getValidoHasta().toString() : "");
            m.put("usosMaximos", c.getUsosMaximos());
            m.put("usosActuales", c.getUsosActuales());
            m.put("montoMinimo", c.getMontoMinimo());
            m.put("activo", c.isActivo());
            m.put("categoriasAplicables",
                    c.getCategoriasAplicables() != null ? c.getCategoriasAplicables() : List.of());
            out.add(m);
        }
        return out;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"cupones\":[],\"categorias\":[]}";
        }
    }
}
