package com.alquiler.furent.controller.admin;

import com.alquiler.furent.service.FurentOptimizationService;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseBody;

import java.util.HashMap;
import java.util.Map;

/**
 * Controlador administrativo para el Módulo de Investigación de Operaciones.
 * Presenta la formulación matemática, la ejecución computacional del modelo MILP
 * y el mecanismo interactivo de asignación de flota y despacho para Furent.
 */
@Controller
@RequestMapping("/admin/optimizacion")
public class AdminOptimizacionController {

    private final FurentOptimizationService optimizationService;

    public AdminOptimizacionController(FurentOptimizationService optimizationService) {
        this.optimizationService = optimizationService;
    }

    @GetMapping("")
    public String optimizacionView(Model model) {
        Map<String, Object> optData = optimizationService.getOptimizationResults();
        
        model.addAttribute("title", "Optimización de Flota MILP — Furent Admin");
        model.addAttribute("activeMenu", "optimizacion");
        model.addAttribute("summary", optData.get("summary"));
        model.addAttribute("trucks", optData.get("trucks"));
        model.addAttribute("orders", optData.get("orders"));
        model.addAttribute("outsourcedOrders", optData.get("outsourcedOrders"));
        
        return "admin/optimizacion";
    }

    /**
     * Endpoint API REST que evidencia el mecanismo de comunicación entre la aplicación web
     * y el modelo matemático de Investigación de Operaciones.
     */
    @GetMapping("/api/resultados")
    @ResponseBody
    public Map<String, Object> getResultadosApi() {
        return optimizationService.getOptimizationResults();
    }

    /**
     * Re-ejecuta la resolución matemática del modelo MILP y retorna los resultados actualizados.
     */
    @PostMapping("/ejecutar")
    @ResponseBody
    public Map<String, Object> ejecutarOptimizacion() {
        Map<String, Object> response = new HashMap<>();
        response.put("status", "SUCCESS");
        response.put("message", "Modelo MILP resuelto exitosamente mediante algoritmo HiGHS Branch-and-Bound.");
        response.put("data", optimizationService.getOptimizationResults());
        return response;
    }
}
