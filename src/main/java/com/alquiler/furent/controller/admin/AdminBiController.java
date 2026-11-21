package com.alquiler.furent.controller.admin;

import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

/**
 * Controlador administrativo para el componente de Business Intelligence y Visualización de Datos en Power BI.
 * Cumple con los requerimientos de integración web de la asignatura Visualización de Datos II.
 */
@Controller
@RequestMapping("/admin/bi")
public class AdminBiController {

    @GetMapping("")
    public String biDashboard(Model model) {
        model.addAttribute("title", "Dashboard Ejecutivo Power BI — Furent");
        model.addAttribute("activeMenu", "bi");
        return "admin/bi-dashboard";
    }
}
