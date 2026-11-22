package com.alquiler.furent.controller.admin;

import com.alquiler.furent.service.FurentOptimizationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseBody;

import java.util.Map;

/**
 * Controlador administrativo del módulo de Investigación de Operaciones.
 *
 * Sirve la vista de optimización y expone los dos puntos de comunicación con el
 * modelo: el resumen de insumos (para pintar la página) y la ejecución del
 * modelo (que delega en el microservicio Python). La formulación matemática no
 * vive aquí: esta capa solo prepara y transporta datos.
 */
@Controller
@RequestMapping("/admin/optimizacion")
public class AdminOptimizacionController {

    private final FurentOptimizationService optimizationService;
    private final ObjectMapper objectMapper;

    public AdminOptimizacionController(FurentOptimizationService optimizationService,
                                       ObjectMapper objectMapper) {
        this.optimizationService = optimizationService;
        this.objectMapper = objectMapper;
    }

    /** Vista principal: trae los insumos disponibles para configurar el modelo. */
    @GetMapping("")
    public String optimizacionView(Model model) {
        Map<String, Object> resumen = optimizationService.getResumen();
        model.addAttribute("activeMenu", "optimizacion");
        model.addAttribute("resumen", resumen);
        model.addAttribute("resumenJson", toJson(resumen));
        return "admin/optimizacion";
    }

    /** Resumen de insumos (inventario, reservas y horizonte sugerido). */
    @GetMapping("/api/resumen")
    @ResponseBody
    public Map<String, Object> resumen() {
        return optimizationService.getResumen();
    }

    /** Ejecuta el modelo con los supuestos elegidos por el administrador. */
    @PostMapping("/optimizar")
    @ResponseBody
    public Map<String, Object> optimizar(@RequestBody Map<String, Object> opciones) {
        return optimizationService.optimizar(opciones);
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }
}
