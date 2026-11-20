package com.alquiler.furent.util;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/**
 * Formateo de {@link Instant} para las plantillas Thymeleaf.
 *
 * {@code #temporals} no formatea {@code Instant} con patrones, así que las vistas del
 * asistente usan estos helpers estáticos ({@code T(com.alquiler.furent.util.DateDisplay)}).
 */
public final class DateDisplay {

    private static final Locale LOCALE_ES_CO = new Locale("es", "CO");
    private static final DateTimeFormatter DATE_TIME =
            DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm", LOCALE_ES_CO);
    private static final DateTimeFormatter DATE =
            DateTimeFormatter.ofPattern("dd/MM/yyyy", LOCALE_ES_CO);

    private DateDisplay() {
    }

    public static String dateTime(Instant instant) {
        return instant == null ? "-" : DATE_TIME.withZone(ZoneId.systemDefault()).format(instant);
    }

    public static String date(Instant instant) {
        return instant == null ? "-" : DATE.withZone(ZoneId.systemDefault()).format(instant);
    }
}
