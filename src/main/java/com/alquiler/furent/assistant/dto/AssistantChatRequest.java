package com.alquiler.furent.assistant.dto;

/**
 * Petición del widget al asistente.
 */
public class AssistantChatRequest {

    private String conversationId;
    private String message;
    private String pageContext;

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
}
