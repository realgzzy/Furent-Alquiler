package com.alquiler.furent.assistant;

import com.alquiler.furent.config.AssistantProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.List;

import static org.hamcrest.Matchers.containsString;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

class RestClientGeminiTransportTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final AssistantProperties properties = properties();
    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
    private final RestClientGeminiTransport transport =
            new RestClientGeminiTransport(builder.build(), properties, mapper);

    private static AssistantProperties properties() {
        AssistantProperties props = new AssistantProperties();
        props.setApiKey("test-key");
        props.setModel("gemini-3.5-flash-lite");
        props.setBaseUrl("https://generativelanguage.googleapis.com/v1beta");
        return props;
    }

    @Test
    void sendsApiKeyHeaderAndStreamsLines() {
        server.expect(requestTo(containsString(":streamGenerateContent")))
                .andExpect(header("x-goog-api-key", "test-key"))
                .andRespond(withSuccess(
                        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hola\"}]}}]}\n",
                        MediaType.TEXT_EVENT_STREAM));

        List<String> lines = new ArrayList<>();
        transport.stream(mapper.createObjectNode(), lines::add);

        server.verify();
        assertTrue(lines.stream().anyMatch(line -> line.contains("Hola")));
    }

    @Test
    void tooManyRequestsMapsToQuotaExceeded() {
        server.expect(requestTo(containsString(":streamGenerateContent")))
                .andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).body("quota"));

        AssistantException ex = assertThrows(AssistantException.class,
                () -> transport.stream(mapper.createObjectNode(), line -> {
                }));
        assertEquals(AssistantException.Code.QUOTA_EXCEEDED, ex.getCode());
    }

    @Test
    void badRequestMapsToInvalidInput() {
        server.expect(requestTo(containsString(":streamGenerateContent")))
                .andRespond(withStatus(HttpStatus.BAD_REQUEST).body("bad"));

        AssistantException ex = assertThrows(AssistantException.class,
                () -> transport.stream(mapper.createObjectNode(), line -> {
                }));
        assertEquals(AssistantException.Code.INVALID_INPUT, ex.getCode());
    }

    @Test
    void serverErrorMapsToUnavailable() {
        server.expect(requestTo(containsString(":streamGenerateContent")))
                .andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR).body("boom"));

        AssistantException ex = assertThrows(AssistantException.class,
                () -> transport.stream(mapper.createObjectNode(), line -> {
                }));
        assertEquals(AssistantException.Code.UNAVAILABLE, ex.getCode());
    }

    @Test
    void withoutApiKeyFailsFast() {
        AssistantProperties sinClave = properties();
        sinClave.setApiKey("");
        RestClientGeminiTransport sinTransport =
                new RestClientGeminiTransport(builder.build(), sinClave, mapper);

        AssistantException ex = assertThrows(AssistantException.class,
                () -> sinTransport.stream(mapper.createObjectNode(), line -> {
                }));
        assertEquals(AssistantException.Code.UNAVAILABLE, ex.getCode());
    }
}
