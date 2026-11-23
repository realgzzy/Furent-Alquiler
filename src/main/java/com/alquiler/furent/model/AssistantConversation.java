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
 * {@code cierraEn} marca cuándo el chat pasa a solo lectura (inicio + sessionHours);
 * {@code expireAt} es la caducidad definitiva (temporal): Mongo elimina la conversación
 * automáticamente mediante un índice TTL cuando pasa esa fecha, ya con margen sobre el cierre
 * para que el aviso de "chat cerrado" siga siendo visible.
 */
@Document(collection = "asistente_conversaciones")
public class AssistantConversation {

    public static final String ESTADO_ACTIVA = "ACTIVA";
    public static final String ESTADO_ESCALADA = "ESCALADA";
    public static final String ESTADO_CERRADA = "CERRADA";

    /** El chat lo cerró un administrador desde el panel. */
    public static final String MOTIVO_CIERRE_ADMIN = "ADMIN";
    /** El chat se cerró solo al cumplir su vigencia (sessionHours). */
    public static final String MOTIVO_CIERRE_EXPIRADO = "EXPIRADO";
    /** El propio usuario cerró el chat. */
    public static final String MOTIVO_CIERRE_USUARIO = "USUARIO";

    @Id
    private String id;

    @Indexed
    private String sessionId;

    @Indexed
    private String userId;

    private String tenantId;
    private String pageContext;

    /** Título corto para el historial; se toma del primer mensaje del usuario. */
    private String titulo;

    @Indexed
    private String estado = ESTADO_ACTIVA;

    private String motivoEscalado;

    /** Motivo del cierre cuando {@code estado = CERRADA} (ADMIN, EXPIRADO o USUARIO). */
    private String motivoCierre;

    /**
     * Memoria corta y legible de lo ya mostrado (productos, cotizaciones, recomendaciones).
     * Se inyecta en el prompt para resolver referencias como "agrégalas"; nunca se muestra al usuario.
     */
    private String memoria;

    private boolean cotizo;
    private BigDecimal totalCotizado;

    @Indexed
    private Instant inicio;

    @Indexed
    private Instant ultimoMensaje;

    /**
     * Momento en que el chat deja de admitir escritura (inicio + {@code sessionHours}).
     * A partir de aquí queda solo de lectura: el usuario ve un aviso y ya no puede enviar.
     */
    @Indexed
    private Instant cierraEn;

    /**
     * Momento en que Mongo borra la conversación (índice TTL). Va por detrás de {@link #cierraEn}
     * para que el chat cerrado siga visible (y muestre el aviso) durante un tiempo de gracia.
     */
    @Indexed(expireAfter = "0s")
    private Instant expireAt;

    private int totalMensajes;
    private long tokensEntrada;
    private long tokensSalida;
    private String ipHash;

    /** Veces que el usuario marcó una respuesta como útil (👍). */
    private int feedbackPositivo;
    /** Veces que el usuario marcó una respuesta como poco útil (👎). */
    private int feedbackNegativo;

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

    public String getTitulo() {
        return titulo;
    }

    public void setTitulo(String titulo) {
        this.titulo = titulo;
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

    public String getMotivoCierre() {
        return motivoCierre;
    }

    public void setMotivoCierre(String motivoCierre) {
        this.motivoCierre = motivoCierre;
    }

    public String getMemoria() {
        return memoria;
    }

    public void setMemoria(String memoria) {
        this.memoria = memoria;
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

    public Instant getCierraEn() {
        return cierraEn;
    }

    public void setCierraEn(Instant cierraEn) {
        this.cierraEn = cierraEn;
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

    public int getFeedbackPositivo() {
        return feedbackPositivo;
    }

    public void setFeedbackPositivo(int feedbackPositivo) {
        this.feedbackPositivo = feedbackPositivo;
    }

    public int getFeedbackNegativo() {
        return feedbackNegativo;
    }

    public void setFeedbackNegativo(int feedbackNegativo) {
        this.feedbackNegativo = feedbackNegativo;
    }
}
