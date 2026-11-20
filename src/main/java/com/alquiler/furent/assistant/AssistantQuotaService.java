package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Cuotas del asistente en memoria:
 * <ul>
 *   <li>mensajes por hora y por sesión (invitado) o por usuario autenticado;</li>
 *   <li>presupuesto diario global de solicitudes a Gemini.</li>
 * </ul>
 *
 * Con varias instancias habría que migrar los contadores a Redis; por ahora se documenta
 * esa limitación.
 */
@Component
public class AssistantQuotaService {

    private static final ZoneId BOGOTA = ZoneId.of("America/Bogota");
    private static final long HOUR_MS = 3_600_000L;

    private final AssistantProperties properties;
    private final ConcurrentHashMap<String, Window> hourly = new ConcurrentHashMap<>();
    private final AtomicInteger dailyCount = new AtomicInteger();
    private volatile LocalDate dailyDate = LocalDate.now(BOGOTA);

    public AssistantQuotaService(AssistantProperties properties) {
        this.properties = properties;
    }

    /**
     * Verifica las cuotas y consume un mensaje. Lanza {@link AssistantException} si se exceden.
     */
    public void checkAndConsume(ToolContext context) {
        LocalDate today = LocalDate.now(BOGOTA);
        if (!today.equals(dailyDate)) {
            synchronized (this) {
                if (!today.equals(dailyDate)) {
                    dailyDate = today;
                    dailyCount.set(0);
                }
            }
        }
        if (dailyCount.get() >= properties.getDailyRequestBudget()) {
            throw new AssistantException(AssistantException.Code.QUOTA_EXCEEDED,
                    "El asistente alcanzó su límite diario. Intenta mañana o escríbenos por WhatsApp.");
        }

        boolean authenticated = context.authenticated();
        int limit = authenticated ? properties.getUserMessagesPerHour() : properties.getGuestMessagesPerHour();
        String key = (authenticated ? "user:" + context.userId() : "session:" + context.sessionId());

        long now = System.currentTimeMillis();
        Window window = hourly.compute(key, (k, existing) -> {
            if (existing == null || now - existing.start > HOUR_MS) {
                return new Window(now);
            }
            return existing;
        });

        if (window.counter.incrementAndGet() > limit) {
            throw new AssistantException(AssistantException.Code.RATE_LIMITED,
                    "Enviaste demasiados mensajes seguidos. Espera un momento antes de continuar.");
        }
        dailyCount.incrementAndGet();

        if (Math.random() < 0.01) {
            hourly.entrySet().removeIf(e -> now - e.getValue().start > HOUR_MS * 2);
        }
    }

    private static final class Window {
        final long start;
        final AtomicInteger counter = new AtomicInteger();

        Window(long start) {
            this.start = start;
        }
    }
}
