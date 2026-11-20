package com.alquiler.furent.assistant;

/**
 * Error controlado del asistente. El {@link Code} se traduce en el código del evento SSE
 * {@code error}.
 */
public class AssistantException extends RuntimeException {

    public enum Code {
        INVALID_INPUT,
        RATE_LIMITED,
        QUOTA_EXCEEDED,
        UNAVAILABLE,
        BLOCKED,
        INTERNAL
    }

    private final Code code;

    public AssistantException(Code code, String message) {
        super(message);
        this.code = code;
    }

    public AssistantException(Code code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public Code getCode() {
        return code;
    }

    public static AssistantException unavailable(String message, Throwable cause) {
        return new AssistantException(Code.UNAVAILABLE, message, cause);
    }

    public static AssistantException internal(String message, Throwable cause) {
        return new AssistantException(Code.INTERNAL, message, cause);
    }
}
