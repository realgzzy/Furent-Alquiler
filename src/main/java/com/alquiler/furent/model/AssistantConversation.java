package com.alquiler.furent.model;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Conversación del asistente virtual.
 *
 * El {@code sessionId} se genera en el servidor y se liga a la HttpSession.
 * {@code expireAt} solo se asigna a conversaciones de invitados; Mongo las elimina
 * automáticamente mediante un índice TTL.
 */
@Document(collection = "asistente_conversaciones")
public class AssistantConversation {

    public static final String ESTADO_ACTIVA = "ACTIVA";
    public static final String ESTADO_ESCALADA = "ESCALADA";
    public static final String ESTADO_CERRADA = "CERRADA";

    @Id
    private String id;

    @Indexed
    private String sessionId;

    @Indexed
    private String userId;

    private String tenantId;
    private String pageContext;

    @Indexed
    private String estado = ESTADO_ACTIVA;

    private String motivoEscalado;

    private boolean cotizo;
    private BigDecimal totalCotizado;

    @Indexed
    private Instant inicio;

    @Indexed
    private Instant ultimoMensaje;

    @Indexed(expireAfterSeconds = 0)
    private Instant expireAt;

    private int totalMensajes;
    private long tokensEntrada;
    private long tokensSalida;
    private String ipHash;

    public AssistantConversation() {
        Instant now = Instant.now();
        this.inicio = now;
        this.ultimoMensaje = now;
        this.estado = ESTADO_ACTIVA;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getSessionId() {
        return sessionId;
    }

    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public String getTenantId() {
        return tenantId;
    }

    public void setTenantId(String tenantId) {
        this.tenantId = tenantId;
    }

    public String getPageContext() {
        return pageContext;
    }

    public void setPageContext(String pageContext) {
        this.pageContext = pageContext;
    }

    public String getEstado() {
        return estado;
    }

    public void setEstado(String estado) {
        this.estado = estado;
    }

    public String getMotivoEscalado() {
        return motivoEscalado;
    }

    public void setMotivoEscalado(String motivoEscalado) {
        this.motivoEscalado = motivoEscalado;
    }

    public boolean isCotizo() {
        return cotizo;
    }

    public void setCotizo(boolean cotizo) {
        this.cotizo = cotizo;
    }

    public BigDecimal getTotalCotizado() {
        return totalCotizado;
    }

    public void setTotalCotizado(BigDecimal totalCotizado) {
        this.totalCotizado = totalCotizado;
    }

    public Instant getInicio() {
        return inicio;
    }

    public void setInicio(Instant inicio) {
        this.inicio = inicio;
    }

    public Instant getUltimoMensaje() {
        return ultimoMensaje;
    }

    public void setUltimoMensaje(Instant ultimoMensaje) {
        this.ultimoMensaje = ultimoMensaje;
    }

    public Instant getExpireAt() {
        return expireAt;
    }

    public void setExpireAt(Instant expireAt) {
        this.expireAt = expireAt;
    }

    public int getTotalMensajes() {
        return totalMensajes;
    }

    public void setTotalMensajes(int totalMensajes) {
        this.totalMensajes = totalMensajes;
    }

    public long getTokensEntrada() {
        return tokensEntrada;
    }

    public void setTokensEntrada(long tokensEntrada) {
        this.tokensEntrada = tokensEntrada;
    }

    public long getTokensSalida() {
        return tokensSalida;
    }

    public void setTokensSalida(long tokensSalida) {
        this.tokensSalida = tokensSalida;
    }

    public String getIpHash() {
        return ipHash;
    }

    public void setIpHash(String ipHash) {
        this.ipHash = ipHash;
    }
}
