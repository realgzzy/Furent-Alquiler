package com.alquiler.furent.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ThreadPoolExecutor;

/**
 * Pool acotado para el trabajo del asistente.
 *
 * El chat corre en un hilo separado del request para poder emitir por SSE. El pool es
 * pequeño a propósito: si se satura, el executor rechaza la tarea y el controlador
 * responde 429 en lugar de encolar indefinidamente.
 */
@Configuration
public class AssistantExecutorConfig {

    public static final String BEAN_NAME = "assistantExecutor";

    @Bean(name = BEAN_NAME)
    public ThreadPoolTaskExecutor assistantExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(32);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("asistente-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(false);
        executor.initialize();
        return executor;
    }
}
