package com.alquiler.furent.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Comprueba la validación del parámetro {@code redirect} del login.
 */
class SecurityConfigRedirectTest {

    @Test
    void rutasInternasValidas() {
        assertTrue(SecurityConfig.isSafeRedirect("/cotizacion"));
        assertTrue(SecurityConfig.isSafeRedirect("/panel?tab=cotizaciones"));
        assertTrue(SecurityConfig.isSafeRedirect("/admin/reservas"));
        assertTrue(SecurityConfig.isSafeRedirect("  /cotizacion  "));
    }

    @Test
    void entradasVaciasONulasSeRechazan() {
        assertFalse(SecurityConfig.isSafeRedirect(null));
        assertFalse(SecurityConfig.isSafeRedirect(""));
        assertFalse(SecurityConfig.isSafeRedirect("   "));
    }

    @Test
    void urlsExternasSeRechazan() {
        assertFalse(SecurityConfig.isSafeRedirect("https://evil.com"));
        assertFalse(SecurityConfig.isSafeRedirect("//evil.com"));
        assertFalse(SecurityConfig.isSafeRedirect("http://evil.com"));
    }

    @Test
    void backslashYSaltosDeLineaSeRechazan() {
        assertFalse(SecurityConfig.isSafeRedirect("/\\evil.com"));
        assertFalse(SecurityConfig.isSafeRedirect("/path\r\nLocation: https://evil.com"));
        assertFalse(SecurityConfig.isSafeRedirect("/path\nAttack"));
        assertFalse(SecurityConfig.isSafeRedirect("/path\ttab"));
    }

    @Test
    void rutaDemasiadoLargaSeRechaza() {
        assertFalse(SecurityConfig.isSafeRedirect("/" + "a".repeat(600)));
    }
}
