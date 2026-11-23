package com.alquiler.furent.controller.admin;

import com.alquiler.furent.dto.UserAdminDetailsDTO;
import com.alquiler.furent.model.Reservation;
import com.alquiler.furent.model.User;
import com.alquiler.furent.model.UserAddress;
import com.alquiler.furent.service.AuditLogService;
import com.alquiler.furent.service.ReservationService;
import com.alquiler.furent.service.UserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Directorio de Usuarios — gestión de la comunidad y sus credenciales.
 *
 * <p>Expone un view-model JSON ({@code usuariosJson}) que alimenta el directorio
 * interactivo: KPIs, roster, filtros y fichas. Cada usuario incluye su perfil,
 * su estado de acceso y sus métricas de actividad (reservas e inversión).
 * Las acciones de rol, acceso, notas y baja se resuelven por endpoints JSON.</p>
 */
@Controller
@RequestMapping("/admin/usuarios")
public class AdminUsuariosController {

    /** Roles asignables desde el panel. */
    private static final Set<String> ROLES_ASIGNABLES = Set.of("USER", "ADMIN");

    private final UserService userService;
    private final ReservationService reservationService;
    private final AuditLogService auditLogService;
    private final ObjectMapper objectMapper;

    public AdminUsuariosController(UserService userService, ReservationService reservationService,
            AuditLogService auditLogService, ObjectMapper objectMapper) {
        this.userService = userService;
        this.reservationService = reservationService;
        this.auditLogService = auditLogService;
        this.objectMapper = objectMapper;
    }

    // ═══════════════════════════════════════════════════════════
    // Vista principal
    // ═══════════════════════════════════════════════════════════

    @GetMapping
    public String listUsers(Model model) {
        List<User> usuarios = userService.getAllUsers();
        List<Reservation> reservas = reservationService.getAllReservations();
        model.addAttribute("usuariosJson", toJson(buildPayload(usuarios, reservas)));
        model.addAttribute("totalUsuarios", usuarios.size());
        return "admin/usuarios";
    }

    // ═══════════════════════════════════════════════════════════
    // Acciones
    // ═══════════════════════════════════════════════════════════

    @PostMapping("/rol/{id}")
    @ResponseBody
    public Map<String, Object> updateRole(@PathVariable String id, @RequestParam String role,
            Authentication authentication) {
        Map<String, Object> res = new LinkedHashMap<>();
        User user = userService.findById(id).orElse(null);
        if (user == null) {
            res.put("ok", false);
            res.put("message", "Usuario no encontrado");
            return res;
        }
        String nuevo = role == null ? "" : role.trim().toUpperCase();
        if (!ROLES_ASIGNABLES.contains(nuevo)) {
            res.put("ok", false);
            res.put("message", "Rol no válido");
            return res;
        }
        String antes = user.getRole();
        user.setRole(nuevo);
        userService.save(user);

        String accion = "CAMBIAR_ROL";
        auditLogService.log(nombreActor(authentication), accion, "USUARIO", id,
                "Rol: " + antes + " -> " + nuevo);

        res.put("ok", true);
        res.put("role", nuevo);
        res.put("roleLabel", rolLabel(nuevo));
        res.put("nombreCompleto", user.getNombreCompleto());
        res.put("message", "Rol actualizado a " + rolLabel(nuevo));
        return res;
    }

    @PostMapping("/estado/{id}")
    @ResponseBody
    public Map<String, Object> updateEstado(@PathVariable String id, @RequestParam boolean activo,
            @RequestParam(required = false) String razon,
            @RequestParam(required = false) String fechaInicio,
            @RequestParam(required = false) String fechaFin,
            @RequestParam(defaultValue = "false") boolean permanente,
            Authentication authentication) {

        Map<String, Object> res = new LinkedHashMap<>();
        User user = userService.findById(id).orElse(null);
        if (user == null) {
            res.put("ok", false);
            res.put("message", "Usuario no encontrado");
            return res;
        }

        user.setActivo(activo);

        if (!activo) {
            user.setRazonSuspension(razon != null && !razon.isBlank() ? razon.trim() : "Violación de términos del sistema");
            user.setSuspensionPermanente(permanente);

            if (fechaInicio != null && !fechaInicio.isBlank()) {
                user.setFechaInicioSuspension(LocalDateTime.parse(fechaInicio + "T00:00:00"));
            } else {
                user.setFechaInicioSuspension(LocalDateTime.now());
            }

            if (!permanente && fechaFin != null && !fechaFin.isBlank()) {
                user.setFechaFinSuspension(LocalDateTime.parse(fechaFin + "T23:59:59"));
            } else if (!permanente) {
                user.setFechaFinSuspension(user.getFechaInicioSuspension().plusDays(7));
            } else {
                user.setFechaFinSuspension(null);
            }
        } else {
            user.setRazonSuspension(null);
            user.setFechaInicioSuspension(null);
            user.setFechaFinSuspension(null);
            user.setSuspensionPermanente(false);
        }

        userService.save(user);

        String accion = activo ? "ACTIVAR_USUARIO" : "SUSPENDER_USUARIO";
        String detail = activo ? "Usuario activado: " + user.getEmail()
                : "Usuario suspendido: " + user.getEmail() + " | Razón: " + user.getRazonSuspension();
        auditLogService.log(nombreActor(authentication), accion, "USUARIO", id, detail);

        res.put("ok", true);
        res.put("activo", activo);
        res.put("razon", activo ? null : user.getRazonSuspension());
        res.put("permanente", activo ? false : user.isSuspensionPermanente());
        res.put("fechaFin", (user.getFechaFinSuspension() != null) ? user.getFechaFinSuspension().toString() : null);
        res.put("message", activo ? "Acceso restaurado" : "Cuenta suspendida");
        return res;
    }

    @PostMapping("/notas/{id}")
    @ResponseBody
    public Map<String, Object> updateNotas(@PathVariable String id,
            @RequestParam(required = false) String notas, Authentication authentication) {
        Map<String, Object> res = new LinkedHashMap<>();
        User user = userService.findById(id).orElse(null);
        if (user == null) {
            res.put("ok", false);
            res.put("message", "Usuario no encontrado");
            return res;
        }
        String limpio = (notas == null || notas.isBlank()) ? null : notas.trim();
        user.setNotasAdmin(limpio);
        userService.save(user);

        auditLogService.log(nombreActor(authentication), "NOTAS_USUARIO", "USUARIO", id,
                "Notas administrativas actualizadas");

        res.put("ok", true);
        res.put("notas", limpio);
        res.put("message", "Notas guardadas");
        return res;
    }

    @PostMapping("/eliminar/{id}")
    @ResponseBody
    public Map<String, Object> eliminar(@PathVariable String id, Authentication authentication) {
        Map<String, Object> res = new LinkedHashMap<>();
        User user = userService.findById(id).orElse(null);
        if (user == null) {
            res.put("ok", false);
            res.put("message", "Usuario no encontrado");
            return res;
        }
        if (!"USER".equalsIgnoreCase(user.getRole())) {
            res.put("ok", false);
            res.put("message", "No se puede eliminar a un miembro del equipo.");
            return res;
        }
        if (authentication != null && user.getEmail() != null
                && user.getEmail().equalsIgnoreCase(authentication.getName())) {
            res.put("ok", false);
            res.put("message", "No puedes eliminar tu propia cuenta.");
            return res;
        }
        List<Reservation> reservas = reservationService.getByUsuarioId(id);
        boolean conActividad = reservas.stream().anyMatch(r -> r.getEstado() != null
                && (r.getEstado().equals("PENDIENTE") || r.getEstado().equals("CONFIRMADA")
                        || r.getEstado().equals("ENTREGADA")));
        if (conActividad) {
            res.put("ok", false);
            res.put("message", "El usuario tiene reservas activas. Cancélalas o suspende la cuenta.");
            return res;
        }

        String nombre = user.getNombreCompleto();
        userService.deleteUser(id);
        auditLogService.log(nombreActor(authentication), "ELIMINAR_USUARIO", "USUARIO", id,
                "Cuenta eliminada: " + user.getEmail());

        res.put("ok", true);
        res.put("nombre", nombre);
        res.put("message", "Cuenta eliminada");
        return res;
    }

    /** Detalle extendido — se mantiene por compatibilidad con integraciones. */
    @GetMapping("/detalles/{id}")
    @ResponseBody
    public UserAdminDetailsDTO getDetalles(@PathVariable String id) {
        User user = userService.findById(id).orElseThrow();
        List<Reservation> userReservas = reservationService.getByUsuarioId(id);

        long totalReservas = userReservas.size();
        BigDecimal totalInvertido = userReservas.stream()
                .filter(r -> "COMPLETADA".equals(r.getEstado()) || "CONFIRMADA".equals(r.getEstado())
                        || "ENTREGADA".equals(r.getEstado()))
                .map(Reservation::getTotal)
                .filter(Objects::nonNull)
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        long favoritosCount = user.getFavoritos() != null ? user.getFavoritos().size() : 0;

        return new UserAdminDetailsDTO(user, totalReservas, totalInvertido, favoritosCount);
    }

    /** Exportación CSV del directorio completo. */
    @GetMapping("/export")
    public void exportCsv(Authentication authentication, HttpServletResponse response) throws IOException {
        List<User> usuarios = userService.getAllUsers();
        List<Reservation> reservas = reservationService.getAllReservations();

        Map<String, List<Reservation>> porUsuario = agruparPorUsuario(reservas);

        StringBuilder sb = new StringBuilder();
        sb.append("Nombre,Apellido,Email,Telefono,Rol,Estado,Ciudad,Pais,Registro,Ultima sesion,Reservas,Invertido,Verificacion 2FA\n");
        for (User u : usuarios) {
            if (u == null) continue;
            List<Reservation> rs = porUsuario.getOrDefault(u.getId(), List.of());
            BigDecimal invertido = invertidoDe(rs);
            String estado = estaSuspendido(u) ? "Suspendido" : "Activo";
            sb.append(csv(u.getNombre())).append(',')
                    .append(csv(u.getApellido())).append(',')
                    .append(csv(u.getEmail())).append(',')
                    .append(csv(u.getTelefono())).append(',')
                    .append(csv(rolLabel(u.getRole()))).append(',')
                    .append(csv(estado)).append(',')
                    .append(csv(u.getCiudad())).append(',')
                    .append(csv(u.getPais())).append(',')
                    .append(csv(u.getFechaCreacion() != null ? u.getFechaCreacion().toLocalDate().toString() : "")).append(',')
                    .append(csv(u.getUltimaSesion() != null ? u.getUltimaSesion().toString() : "")).append(',')
                    .append(rs.size()).append(',')
                    .append(invertido.setScale(0, java.math.RoundingMode.HALF_UP)).append(',')
                    .append(u.isTotpEnabled() ? "Si" : "No").append('\n');
        }

        response.setContentType("text/csv; charset=UTF-8");
        response.setHeader(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"usuarios_furent.csv\"");
        response.getWriter().write('\uFEFF' + sb.toString());

        auditLogService.log(nombreActor(authentication), "EXPORTAR_USUARIOS", "USUARIO", "-",
                "Directorio exportado (" + usuarios.size() + " usuarios)");
    }

    // ═══════════════════════════════════════════════════════════
    // Vista JSON para el directorio interactivo
    // ═══════════════════════════════════════════════════════════

    private Map<String, Object> buildPayload(List<User> usuarios, List<Reservation> reservas) {
        Map<String, List<Reservation>> porUsuario = agruparPorUsuario(reservas);
        LocalDateTime hace30 = LocalDateTime.now().minusDays(30);

        long activos = 0, suspendidos = 0, equipo = 0, nuevos = 0, conReservas = 0, oauth = 0;
        BigDecimal inversionTotal = BigDecimal.ZERO;

        List<Map<String, Object>> lista = new ArrayList<>();
        for (User u : usuarios) {
            if (u == null) continue;

            boolean suspendido = estaSuspendido(u);
            boolean activo = !suspendido;
            boolean esEquipo = esEquipo(u.getRole());
            boolean esNuevo = u.getFechaCreacion() != null && u.getFechaCreacion().isAfter(hace30);

            List<Reservation> rs = porUsuario.getOrDefault(u.getId(), List.of());
            long totalReservas = rs.size();
            long reservasActivas = rs.stream().filter(r -> "CONFIRMADA".equals(r.getEstado())
                    || "ENTREGADA".equals(r.getEstado()) || "PENDIENTE".equals(r.getEstado())).count();
            BigDecimal invertido = invertidoDe(rs);
            long favoritos = u.getFavoritos() != null ? u.getFavoritos().size() : 0;

            if (activo) activos++; else suspendidos++;
            if (esEquipo) equipo++;
            if (esNuevo) nuevos++;
            if (totalReservas > 0) conReservas++;
            if (u.getProvider() != null && !u.getProvider().isBlank() && !"local".equalsIgnoreCase(u.getProvider())) oauth++;
            inversionTotal = inversionTotal.add(invertido);

            lista.add(usuarioView(u, suspendido, esEquipo, esNuevo, totalReservas, reservasActivas, invertido, favoritos));
        }

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("total", usuarios.size());
        stats.put("activos", activos);
        stats.put("suspendidos", suspendidos);
        stats.put("equipo", equipo);
        stats.put("nuevos", nuevos);
        stats.put("conReservas", conReservas);
        stats.put("oauth", oauth);
        stats.put("inversionTotal", inversionTotal);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("stats", stats);
        payload.put("usuarios", lista);
        return payload;
    }

    private Map<String, Object> usuarioView(User u, boolean suspendido, boolean esEquipo, boolean esNuevo,
            long totalReservas, long reservasActivas, BigDecimal invertido, long favoritos) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("id", u.getId());
        v.put("nombre", texto(u.getNombre(), "Sin nombre"));
        v.put("apellido", texto(u.getApellido(), ""));
        v.put("nombreCompleto", u.getNombreCompleto() != null ? u.getNombreCompleto().trim() : "Usuario");
        v.put("iniciales", iniciales(u.getNombre(), u.getApellido()));
        v.put("email", texto(u.getEmail(), ""));
        v.put("telefono", texto(u.getTelefono(), ""));
        v.put("role", texto(u.getRole(), "USER"));
        v.put("roleLabel", rolLabel(u.getRole()));
        v.put("equipo", esEquipo);
        v.put("activo", !suspendido);
        v.put("suspendido", suspendido);
        v.put("nuevo", esNuevo);
        v.put("creado", u.getFechaCreacion() != null ? u.getFechaCreacion().toLocalDate().toString() : null);
        v.put("ultimaSesion", u.getUltimaSesion() != null ? u.getUltimaSesion().toString() : null);

        // Perfil
        v.put("tipoDocumento", texto(u.getTipoDocumento(), ""));
        v.put("documentoIdentidad", texto(u.getDocumentoIdentidad(), ""));
        v.put("fechaNacimiento", u.getFechaNacimiento() != null ? u.getFechaNacimiento().toString() : null);
        v.put("genero", texto(u.getGenero(), ""));
        v.put("estadoCivil", texto(u.getEstadoCivil(), ""));
        v.put("empresa", texto(u.getEmpresa(), ""));
        v.put("cargo", texto(u.getCargo(), ""));

        // Ubicación
        v.put("ciudad", texto(u.getCiudad(), ""));
        v.put("pais", texto(u.getPais(), ""));
        v.put("estadoProvincia", texto(u.getEstadoProvincia(), ""));
        v.put("codigoPostal", texto(u.getCodigoPostal(), ""));
        v.put("direccion", texto(u.getDireccion(), ""));
        v.put("direccionesCount", u.getDirecciones() != null ? u.getDirecciones().size() : 0);
        v.put("direccionPrincipal", direccionPrincipal(u));

        // Administración
        v.put("notasAdmin", texto(u.getNotasAdmin(), ""));
        v.put("razonSuspension", texto(u.getRazonSuspension(), ""));
        v.put("fechaInicioSuspension", u.getFechaInicioSuspension() != null ? u.getFechaInicioSuspension().toString() : null);
        v.put("fechaFinSuspension", u.getFechaFinSuspension() != null ? u.getFechaFinSuspension().toString() : null);
        v.put("suspensionPermanente", u.isSuspensionPermanente());
        v.put("provider", texto(u.getProvider(), "local"));
        v.put("totpEnabled", u.isTotpEnabled());
        v.put("notificacionesEmail", u.isNotificacionesEmail());
        v.put("idioma", texto(u.getIdioma(), "es"));
        v.put("moneda", texto(u.getMoneda(), "COP"));
        v.put("apariencia", texto(u.getApariencia(), "light"));

        // Actividad
        v.put("totalReservas", totalReservas);
        v.put("reservasActivas", reservasActivas);
        v.put("totalInvertido", invertido);
        v.put("favoritosCount", favoritos);
        return v;
    }

    private Map<String, Object> direccionPrincipal(User u) {
        if (u.getDirecciones() == null || u.getDirecciones().isEmpty()) return null;
        UserAddress sel = null;
        for (UserAddress d : u.getDirecciones()) {
            if (d != null && d.isPredeterminada()) { sel = d; break; }
        }
        if (sel == null) sel = u.getDirecciones().get(0);
        if (sel == null) return null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("alias", texto(sel.getAlias(), ""));
        m.put("direccion", texto(sel.getDireccion(), ""));
        m.put("ciudad", texto(sel.getCiudad(), ""));
        m.put("estadoProvincia", texto(sel.getEstadoProvincia(), ""));
        m.put("pais", texto(sel.getPais(), ""));
        m.put("codigoPostal", texto(sel.getCodigoPostal(), ""));
        m.put("predeterminada", sel.isPredeterminada());
        return m;
    }

    // ═══════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════

    private Map<String, List<Reservation>> agruparPorUsuario(List<Reservation> reservas) {
        Map<String, List<Reservation>> map = new HashMap<>();
        if (reservas == null) return map;
        for (Reservation r : reservas) {
            if (r != null && r.getUsuarioId() != null) {
                map.computeIfAbsent(r.getUsuarioId(), k -> new ArrayList<>()).add(r);
            }
        }
        return map;
    }

    private BigDecimal invertidoDe(List<Reservation> rs) {
        return rs.stream()
                .filter(r -> r.getEstado() != null && !"CANCELADA".equals(r.getEstado()))
                .map(Reservation::getTotal)
                .filter(Objects::nonNull)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private boolean estaSuspendido(User u) {
        if (!u.isActivo()) return true;
        LocalDateTime ahora = LocalDateTime.now();
        if (u.getFechaInicioSuspension() != null && ahora.isAfter(u.getFechaInicioSuspension())) {
            if (u.isSuspensionPermanente()) return true;
            if (u.getFechaFinSuspension() != null && ahora.isBefore(u.getFechaFinSuspension())) return true;
        }
        return false;
    }

    private boolean esEquipo(String role) {
        return role != null && !"USER".equalsIgnoreCase(role);
    }

    private String rolLabel(String role) {
        if (role == null) return "Cliente";
        switch (role.toUpperCase()) {
            case "ADMIN": return "Administrador";
            case "SUPER_ADMIN": return "Super Admin";
            case "MANAGER": return "Gerente";
            default: return "Cliente";
        }
    }

    private String iniciales(String nombre, String apellido) {
        String a = (nombre != null && !nombre.isBlank()) ? nombre.trim().substring(0, 1) : "U";
        String b = (apellido != null && !apellido.isBlank()) ? apellido.trim().substring(0, 1) : "";
        return (a + b).toUpperCase();
    }

    private String nombreActor(Authentication authentication) {
        return (authentication != null && authentication.getName() != null) ? authentication.getName() : "Sistema";
    }

    private String csv(String v) {
        if (v == null) return "";
        String s = v.replace("\"", "\"\"");
        return "\"" + s + "\"";
    }

    private String texto(String v, String fallback) {
        return v != null && !v.isBlank() ? v.trim() : fallback;
    }

    private String toJson(Object value) {
        try {
            // Escapamos "<" para que el JSON nunca pueda cerrar el <script>.
            return objectMapper.writeValueAsString(value).replace("<", "\\u003c");
        } catch (Exception e) {
            return "{\"stats\":{},\"usuarios\":[]}";
        }
    }
}
