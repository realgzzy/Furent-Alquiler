package com.alquiler.furent.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Configuración del asistente conversacional (Gemini).
 *
 * La habilitación global vive en {@link FeatureFlags#isAssistantEnabled()}.
 * Este componente solo se considera operativo si además existe una API key.
 *
 * Configuración en application.properties:
 *   furent.assistant.api-key=${GEMINI_API_KEY:}
 *   furent.assistant.model=gemini-3.5-flash-lite
 */
@Component
@ConfigurationProperties(prefix = "furent.assistant")
public class AssistantProperties {

    private String apiKey = "";
    private String model = "gemini-3.5-flash-lite";
    private String baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    private int maxOutputTokens = 800;
    private int thinkingBudget = 0;
    /** Nivel de razonamiento para Gemini 3.x (MINIMAL, LOW, MEDIUM, HIGH). */
    private String thinkingLevel = "MINIMAL";
    private double temperature = 0.4;
    private int maxToolIterations = 5;
    private int historyWindow = 12;
    private int guestMessagesPerHour = 15;
    private int userMessagesPerHour = 40;
    private int dailyRequestBudget = 800;
    private int requestTimeoutSeconds = 30;
    private String whatsappNumber = "573105782442";
    private String knowledgeFile = "classpath:assistant/knowledge.yml";
    /** Horas que se conservan las conversaciones y sus mensajes (chat temporal). */
    private int sessionHours = 24;
    private long emitterTimeoutMillis = 60_000L;

    /**
     * Indica si hay una API key configurada. Sin clave el asistente no debe operar.
     */
    public boolean isConfigured() {
        return apiKey != null && !apiKey.isBlank();
    }

    public String getApiKey() {
        return apiKey;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public int getMaxOutputTokens() {
        return maxOutputTokens;
    }

    public void setMaxOutputTokens(int maxOutputTokens) {
        this.maxOutputTokens = maxOutputTokens;
    }

    public int getThinkingBudget() {
        return thinkingBudget;
    }

    public void setThinkingBudget(int thinkingBudget) {
        this.thinkingBudget = thinkingBudget;
    }

    public String getThinkingLevel() {
        return thinkingLevel;
    }

    public void setThinkingLevel(String thinkingLevel) {
        this.thinkingLevel = thinkingLevel;
    }

    public double getTemperature() {
        return temperature;
    }

    public void setTemperature(double temperature) {
        this.temperature = temperature;
    }

    public int getMaxToolIterations() {
        return maxToolIterations;
    }

    public void setMaxToolIterations(int maxToolIterations) {
        this.maxToolIterations = maxToolIterations;
    }

    public int getHistoryWindow() {
        return historyWindow;
    }

    public void setHistoryWindow(int historyWindow) {
        this.historyWindow = historyWindow;
    }

    public int getGuestMessagesPerHour() {
        return guestMessagesPerHour;
    }

    public void setGuestMessagesPerHour(int guestMessagesPerHour) {
        this.guestMessagesPerHour = guestMessagesPerHour;
    }

    public int getUserMessagesPerHour() {
        return userMessagesPerHour;
    }

    public void setUserMessagesPerHour(int userMessagesPerHour) {
        this.userMessagesPerHour = userMessagesPerHour;
    }

    public int getDailyRequestBudget() {
        return dailyRequestBudget;
    }

    public void setDailyRequestBudget(int dailyRequestBudget) {
        this.dailyRequestBudget = dailyRequestBudget;
    }

    public int getRequestTimeoutSeconds() {
        return requestTimeoutSeconds;
    }

    public void setRequestTimeoutSeconds(int requestTimeoutSeconds) {
        this.requestTimeoutSeconds = requestTimeoutSeconds;
    }

    public String getWhatsappNumber() {
        return whatsappNumber;
    }

    public void setWhatsappNumber(String whatsappNumber) {
        this.whatsappNumber = whatsappNumber;
    }

    public String getKnowledgeFile() {
        return knowledgeFile;
    }

    public void setKnowledgeFile(String knowledgeFile) {
        this.knowledgeFile = knowledgeFile;
    }

    public int getSessionHours() {
        return sessionHours;
    }

    public void setSessionHours(int sessionHours) {
        this.sessionHours = sessionHours;
    }

    public long getEmitterTimeoutMillis() {
        return emitterTimeoutMillis;
    }

    public void setEmitterTimeoutMillis(long emitterTimeoutMillis) {
        this.emitterTimeoutMillis = emitterTimeoutMillis;
    }
}
