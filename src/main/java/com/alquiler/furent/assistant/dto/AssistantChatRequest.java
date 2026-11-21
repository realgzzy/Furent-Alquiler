package com.alquiler.furent.assistant.dto;

import java.util.List;

/**
 * Petición del widget al asistente.
 */
public class AssistantChatRequest {

    private String conversationId;
    private String message;
    private String pageContext;
    /** Bolsa actual del usuario ({@code furent_bag}) para que el asistente pueda verla. */
    private List<BagLine> bag;

    public String getConversationId() {
        return conversationId;
    }

    public void setConversationId(String conversationId) {
        this.conversationId = conversationId;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public String getPageContext() {
        return pageContext;
    }

    public void setPageContext(String pageContext) {
        this.pageContext = pageContext;
    }

    public List<BagLine> getBag() {
        return bag;
    }

    public void setBag(List<BagLine> bag) {
        this.bag = bag;
    }

    /** Una línea de la bolsa enviada por el navegador. */
    public static class BagLine {
        private String id;
        private String nombre;
        private Integer cantidad;
        private java.math.BigDecimal precioDia;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getNombre() {
            return nombre;
        }

        public void setNombre(String nombre) {
            this.nombre = nombre;
        }

        public Integer getCantidad() {
            return cantidad;
        }

        public void setCantidad(Integer cantidad) {
            this.cantidad = cantidad;
        }

        public java.math.BigDecimal getPrecioDia() {
            return precioDia;
        }

        public void setPrecioDia(java.math.BigDecimal precioDia) {
            this.precioDia = precioDia;
        }
    }
}
