package com.alquiler.furent.model;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Mensaje individual de una conversación del asistente.
 *
 * Los mensajes con rol TOOL guardan solo el nombre de la herramienta y un resumen de
 * los argumentos; nunca datos sensibles en claro.
 */
@Document(collection = "asistente_mensajes")
@CompoundIndex(name = "idx_conversacion_fecha", def = "{'conversationId': 1, 'createdAt': 1}")
public class AssistantMessage {

    public static final String ROL_USER = "USER";
    public static final String ROL_ASSISTANT = "ASSISTANT";
    public static final String ROL_TOOL = "TOOL";

    @Id
    private String id;

    private String conversationId;
    private String rol;
    private String contenido;
    private String herramienta;
    private String argumentosResumen;
    private int tokens;
    private String modelo;
    private Instant createdAt;

    /** Momento en que Mongo borra el mensaje (índice TTL); hereda la caducidad del chat. */
    @Indexed(expireAfterSeconds = 0)
    private Instant expireAt;

    public AssistantMessage() {
        this.createdAt = Instant.now();
    }

    public AssistantMessage(String conversationId, String rol, String contenido) {
        this();
        this.conversationId = conversationId;
        this.rol = rol;
        this.contenido = contenido;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getConversationId() {
        return conversationId;
    }

    public void setConversationId(String conversationId) {
        this.conversationId = conversationId;
    }

    public String getRol() {
        return rol;
    }

    public void setRol(String rol) {
        this.rol = rol;
    }

    public String getContenido() {
        return contenido;
    }

    public void setContenido(String contenido) {
        this.contenido = contenido;
    }

    public String getHerramienta() {
        return herramienta;
    }

    public void setHerramienta(String herramienta) {
        this.herramienta = herramienta;
    }

    public String getArgumentosResumen() {
        return argumentosResumen;
    }

    public void setArgumentosResumen(String argumentosResumen) {
        this.argumentosResumen = argumentosResumen;
    }

    public int getTokens() {
        return tokens;
    }

    public void setTokens(int tokens) {
        this.tokens = tokens;
    }

    public String getModelo() {
        return modelo;
    }

    public void setModelo(String modelo) {
        this.modelo = modelo;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }

    public Instant getExpireAt() {
        return expireAt;
    }

    public void setExpireAt(Instant expireAt) {
        this.expireAt = expireAt;
    }
}
