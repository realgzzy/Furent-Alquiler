package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

class AssistantQuotaServiceTest {

    private AssistantProperties properties;
    private AssistantQuotaService quota;

    private static final ToolContext GUEST = new ToolContext(null, "session-guest");
    private static final ToolContext USER = new ToolContext("user-1", "session-user");

    @BeforeEach
    void setUp() {
        properties = new AssistantProperties();
        properties.setGuestMessagesPerHour(2);
        properties.setUserMessagesPerHour(3);
        properties.setDailyRequestBudget(4);
        quota = new AssistantQuotaService(properties);
    }

    @Test
    void guestLimitIsEnforced() {
        assertDoesNotThrow(() -> quota.checkAndConsume(GUEST));
        assertDoesNotThrow(() -> quota.checkAndConsume(GUEST));

        AssistantException ex = assertThrows(AssistantException.class,
                () -> quota.checkAndConsume(GUEST));
        assertEquals(AssistantException.Code.RATE_LIMITED, ex.getCode());
    }

    @Test
    void authenticatedAndGuestHaveSeparateWindows() {
        assertDoesNotThrow(() -> quota.checkAndConsume(GUEST));
        assertDoesNotThrow(() -> quota.checkAndConsume(GUEST));
        // El invitado ya llegó a su tope, el usuario sigue con su propio cupo.
        assertDoesNotThrow(() -> quota.checkAndConsume(USER));
    }

    @Test
    void dailyBudgetIsGlobal() {
        assertDoesNotThrow(() -> quota.checkAndConsume(GUEST));
        assertDoesNotThrow(() -> quota.checkAndConsume(USER));
        // Tercer y cuarto mensaje dentro del presupuesto diario de 4.
        assertDoesNotThrow(() -> quota.checkAndConsume(GUEST));
        assertDoesNotThrow(() -> quota.checkAndConsume(USER));

        AssistantException ex = assertThrows(AssistantException.class,
                () -> quota.checkAndConsume(GUEST));
        assertEquals(AssistantException.Code.QUOTA_EXCEEDED, ex.getCode());
    }
}
