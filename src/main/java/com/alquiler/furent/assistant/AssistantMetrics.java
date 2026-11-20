package com.alquiler.furent.assistant;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * Métricas Micrometer del asistente (prefijo {@code furent.assistant}).
 */
@Component
public class AssistantMetrics {

    private final MeterRegistry registry;

    public AssistantMetrics(MeterRegistry registry) {
        this.registry = registry;
    }

    public void message(String audience) {
        registry.counter("furent.assistant.messages.total", "audience", audience).increment();
    }

    public void toolCall(String tool, String outcome) {
        registry.counter("furent.assistant.tool.calls", "tool", tool, "outcome", outcome).increment();
    }

    public void tokens(String type, long count) {
        if (count > 0) {
            registry.counter("furent.assistant.tokens", "type", type).increment(count);
        }
    }

    public void error(String code) {
        registry.counter("furent.assistant.errors.total", "code", code).increment();
    }

    public void escalation() {
        registry.counter("furent.assistant.escalations.total").increment();
    }

    public void quote() {
        registry.counter("furent.assistant.quotes.total").increment();
    }

    public void latency(String model, Duration duration) {
        Timer.builder("furent.assistant.latency")
                .tag("model", model)
                .register(registry)
                .record(duration);
    }
}
