# Plan de implementación — Asistente LLM de Furent

> **Spec:** [`docs/specs/2026-11-20-asistente-llm-design.md`](../specs/2026-11-20-asistente-llm-design.md)
> **Fecha:** 20 de noviembre de 2026
> **Estrategia:** 7 fases, cada una compila y se commitea por separado
> **Rama de trabajo:** `main` (el repositorio ya tiene cambios locales de Tailwind; no se tocan)

---

## Principios

1. No duplicar lógica de negocio: las herramientas usan `ProductService`,
   `ReservationService`, `CouponService` y `UserService`.
2. No tocar el flujo de reservas ni de pagos existente.
3. El asistente nunca es la fuente de verdad de precios o stock.
4. Todo el código nuevo queda detrás de `furent.features.assistant-enabled`.
5. Las pruebas no llaman a Gemini real.
6. Cada fase deja `.\mvnw.cmd -q -DskipTests compile` en verde.

## Convenciones

- Lógica del asistente: `com.alquiler.furent.assistant.*`.
- Configuración: `com.alquiler.furent.config.*`.
- Modelos: `com.alquiler.furent.model.*`.
- Repositorios: `com.alquiler.furent.repository.*`.
- Controladores: `com.alquiler.furent.controller.*` y `.controller.admin.*`.
- Plantillas: `src/main/resources/templates/fragments/` y `templates/admin/`.
- JavaScript: `src/main/resources/static/js/assistant.js`.

## Verificación base

```powershell
.\mvnw.cmd -q -DskipTests compile
.\mvnw.cmd test
```

> Los tests preexistentes pueden fallar por motivos ajenos al asistente. Se documenta el
> estado antes de empezar y no se introducen fallos nuevos.
>
> **Resultado (20/11/2026):** `Tests run: 325, Failures: 2, Errors: 17, Skipped: 8`. Los 2
> fallos y 17 errores están en `EmailServiceTest`, `ReservationServiceTest`,
> `ReviewServiceTest` y `UserServiceTest` (ya fallaban antes de empezar). Ninguna prueba
> del asistente falla.

---

## Fase 1 — Configuración, modelos y repositorios

**Objetivo:** dejar la base de datos y la configuración listas sin exponer endpoints.

### Tareas

- [x] **1.1** Crear `config/AssistantProperties.java`.
  - `@Component` + `@ConfigurationProperties(prefix = "furent.assistant")`.
  - Campos: `apiKey`, `model`, `baseUrl`, `maxOutputTokens`, `thinkingBudget`,
    `temperature`, `maxToolIterations`, `historyWindow`, `guestMessagesPerHour`,
    `userMessagesPerHour`, `dailyRequestBudget`, `requestTimeoutSeconds`,
    `whatsappNumber`, `knowledgeFile`, `retentionDays`.
  - Getters y setters; valores por defecto iguales a la spec.
  - Método `isConfigured()` que devuelve `apiKey != null && !apiKey.isBlank()`.
- [x] **1.2** Añadir `assistantEnabled` a `config/FeatureFlags.java` con getter/setter.
- [x] **1.3** Crear `model/AssistantConversation.java`.
  - `@Document(collection = "asistente_conversaciones")`.
  - Campos de la spec, incluidos `cotizo`, `totalCotizado` y `expireAt`.
  - `@Indexed` en `sessionId`, `userId`, `inicio`, `ultimoMensaje`.
  - Índice TTL en `expireAt` con `@Indexed(expireAfterSeconds = 0)`.
- [x] **1.4** Crear `model/AssistantMessage.java`.
  - `@Document(collection = "asistente_mensajes")`.
  - Campos: `conversationId`, `rol`, `contenido`, `herramienta`, `argumentosResumen`,
    `tokens`, `modelo`, `createdAt`.
- [x] **1.5** Crear repositorios:
  - `AssistantConversationRepository`: `findBySessionIdOrderByUltimoMensajeDesc`,
    `findByUserIdOrderByUltimoMensajeDesc`, `findByEstado`, `findByUltimoMensajeBetween`.
  - `AssistantMessageRepository`: `findByConversationIdOrderByCreatedAtAsc`,
    `deleteByConversationId`, `countByConversationId`.
- [x] **1.6** Añadir propiedades a `application.properties` y `application-dev.properties`.
- [x] **1.7** Compilar y verificar que el contexto no falla por los nuevos beans.

### Archivos

```
src/main/java/com/alquiler/furent/config/AssistantProperties.java        (nuevo)
src/main/java/com/alquiler/furent/config/FeatureFlags.java               (editar)
src/main/java/com/alquiler/furent/model/AssistantConversation.java       (nuevo)
src/main/java/com/alquiler/furent/model/AssistantMessage.java            (nuevo)
src/main/java/com/alquiler/furent/repository/AssistantConversationRepository.java (nuevo)
src/main/java/com/alquiler/furent/repository/AssistantMessageRepository.java     (nuevo)
src/main/resources/application.properties                               (editar)
src/main/resources/application-dev.properties                           (editar)
```

### Verificación

```powershell
.\mvnw.cmd -q -DskipTests compile
```

### Commit

`feat(asistente): configuración, modelos y repositorios base`

---

## Fase 2 — Cliente Gemini y parser SSE

**Objetivo:** hablar con Gemini, incluyendo streaming y function calls, sin lógica de negocio.

### Tareas

- [x] **2.1** Crear `assistant/GeminiSseParser.java`.
  - Recibe líneas y emite eventos completos cuando encuentra una línea `data: {...}`.
  - Ignora comentarios, líneas vacías y `[DONE]`.
  - Tolera JSON partido entre lecturas.
  - Tests con fixtures de texto, function call, usage y error.
- [x] **2.2** Crear `assistant/GeminiClient.java`.
  - `RestClient` con `baseUrl`, `x-goog-api-key`, `Content-Type: application/json`.
  - Timeout de conexión/lectura desde `AssistantProperties`.
  - Método `Stream<GeminiChunk> stream(...)` o callback `Consumer<GeminiChunk>`.
  - DTOs internos: `GeminiRequest`, `GeminiContent`, `GeminiPart`, `GeminiChunk`.
  - Mapeo de 400/401/403/429/5xx a excepciones propias.
- [x] **2.3** Crear `assistant/AssistantException.java` con códigos:
  `INVALID_INPUT`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `UNAVAILABLE`, `BLOCKED`, `INTERNAL`.
- [x] **2.4** Crear `assistant/AssistantMetrics.java` con contadores/timers Micrometer.
- [x] **2.5** Tests unitarios del parser y del request builder.

### Archivos

```
src/main/java/com/alquiler/furent/assistant/GeminiClient.java        (nuevo)
src/main/java/com/alquiler/furent/assistant/GeminiSseParser.java     (nuevo)
src/main/java/com/alquiler/furent/assistant/GeminiChunk.java         (nuevo)
src/main/java/com/alquiler/furent/assistant/AssistantException.java  (nuevo)
src/main/java/com/alquiler/furent/assistant/AssistantMetrics.java    (nuevo)
src/test/java/com/alquiler/furent/assistant/GeminiSseParserTest.java (nuevo)
src/test/java/com/alquiler/furent/assistant/GeminiClientTest.java    (nuevo)
```

### Verificación

```powershell
.\mvnw.cmd -q -Dtest=GeminiSseParserTest,GeminiClientTest test
```

### Commit

`feat(asistente): cliente Gemini con streaming y parser SSE`

---

## Fase 3 — Prompt, conocimiento y herramientas

**Objetivo:** que el modelo pueda consultar datos reales y calcular cotizaciones.

### Tareas

- [x] **3.1** Crear `src/main/resources/assistant/knowledge.yml` con el contenido de la spec.
- [x] **3.2** Crear `assistant/AssistantKnowledgeService.java`.
  - Carga el YAML al inicio con `ResourceLoader` + Jackson YAML.
  - Valida estructura mínima; fallback con warning si falla.
  - Expone `renderForPrompt()` y `buscarOcasion(String)`.
  - Añadir dependencia `jackson-dataformat-yaml` si no está en el classpath.
- [x] **3.3** Crear `assistant/AssistantPromptBuilder.java`.
  - System instruction de la spec.
  - Inyecta conocimiento, fecha actual (America/Bogota), contexto de página y si el usuario
    está autenticado.
  - Recorta historial a `historyWindow` y ~6.000 tokens estimados.
- [x] **3.4** Crear `assistant/AssistantToolDefinitions.java` con los 10 esquemas JSON.
- [x] **3.5** Crear `assistant/AssistantToolService.java`.
  - `buscar_productos`, `ver_producto`, `listar_categorias`.
  - `consultar_disponibilidad` reutilizando reservas activas y stock.
  - `cotizar` con precios de BD, días inclusivos, cupón y `validateAvailability`.
  - `validar_cupon`, `informacion_negocio`.
  - `mis_reservas`, `estado_reserva` con verificación de dueño.
  - `escalar_a_humano` con resumen y URL de WhatsApp.
  - Devuelve `ToolResult { payload, uiEvents }`.
- [x] **3.6** Tests unitarios con mocks de servicios.
  - Cotización: 1 día, varios días, cupón, stock insuficiente, producto inexistente.
  - Disponibilidad: rango con reservas solapadas.
  - Autorización: usuario A no ve reservas de B.
  - `escalar_a_humano`: URL codificada correctamente.

### Archivos

```
src/main/resources/assistant/knowledge.yml                          (nuevo)
src/main/java/com/alquiler/furent/assistant/AssistantKnowledgeService.java (nuevo)
src/main/java/com/alquiler/furent/assistant/AssistantPromptBuilder.java    (nuevo)
src/main/java/com/alquiler/furent/assistant/AssistantToolDefinitions.java  (nuevo)
src/main/java/com/alquiler/furent/assistant/AssistantToolService.java      (nuevo)
src/main/java/com/alquiler/furent/assistant/ToolResult.java                (nuevo)
src/test/java/com/alquiler/furent/assistant/AssistantToolServiceTest.java  (nuevo)
src/test/java/com/alquiler/furent/assistant/AssistantPromptBuilderTest.java (nuevo)
pom.xml                                                                    (editar si falta YAML)
```

### Verificación

```powershell
.\mvnw.cmd -q -Dtest=AssistantToolServiceTest,AssistantPromptBuilderTest test
```

### Commit

`feat(asistente): prompt, conocimiento y herramientas de negocio`

---

## Fase 4 — Orquestador, API SSE y límites

**Objetivo:** exponer el chat completo y seguro.

### Tareas

- [x] **4.1** Crear DTOs de entrada/salida en `assistant/dto/`.
  - `AssistantChatRequest { conversationId, message, pageContext }` con validación.
  - `AssistantChatResponse` solo si se necesita una variante sin streaming.
- [x] **4.2** Crear `assistant/AssistantOrchestrator.java`.
  - Carga/crea conversación; valida propiedad.
  - Bucle de hasta `maxToolIterations`.
  - Emite `meta`, `token`, `card`, `quote`, `escalation`, `error`, `done`.
  - Guarda mensajes USER/ASSISTANT/TOOL y actualiza contadores.
  - Maneja desconexión y errores.
- [x] **4.3** Crear `controller/AssistantController.java`.
  - `POST /api/asistente/chat` con `SseEmitter`.
  - `GET /api/asistente/conversations/{id}`.
  - `POST /api/asistente/conversations/{id}/close`.
  - Comprueba flag + API key; si no, 503.
- [x] **4.4** Configurar `ThreadPoolTaskExecutor` acotado y timeout de 60 s.
- [x] **4.5** Añadir matchers públicos en `SecurityConfig`.
- [x] **4.6** Extender `RateLimitFilter` con la regla del chat y contadores por sesión/usuario.
- [x] **4.7** Tests de endpoint con `MockMvc` y el orquestador mockeado (sin WireMock):
  - flujo SSE con `meta`/`token`/`done`;
  - mensaje inválido → 400;
  - flag o API key ausente → 503;
  - conversación de otra sesión → 404.
  - Las tarjetas, la cotización, el 429 y la autorización de herramientas quedan cubiertos
    en `AssistantOrchestratorTest`, `AssistantToolServiceTest` y `GeminiClientTest` con mocks.

### Archivos

```
src/main/java/com/alquiler/furent/assistant/AssistantOrchestrator.java      (nuevo)
src/main/java/com/alquiler/furent/assistant/dto/AssistantChatRequest.java   (nuevo)
src/main/java/com/alquiler/furent/controller/AssistantController.java       (nuevo)
src/main/java/com/alquiler/furent/config/SecurityConfig.java               (editar)
src/main/java/com/alquiler/furent/config/RateLimitFilter.java              (editar)
src/main/java/com/alquiler/furent/config/AssistantExecutorConfig.java      (nuevo)
src/test/java/com/alquiler/furent/controller/AssistantControllerTest.java  (nuevo)
```

### Verificación

```powershell
.\mvnw.cmd -q -Dtest=AssistantControllerTest test
```

### Commit

`feat(asistente): orquestador, endpoint SSE y rate limiting`

---

## Fase 5 — Widget de UI y login con retorno

**Objetivo:** que el usuario pueda conversar y llegar al checkout.

### Tareas

- [x] **5.1** Crear `templates/fragments/assistant-widget.html`.
  - Botón flotante derecho, panel, cabecera, chips, mensajes, composer y aviso de IA.
  - Clases Tailwind consistentes con `layout.html`; sin CDN.
- [x] **5.2** Crear `static/js/assistant.js`.
  - Abrir/cerrar, foco atrapado, Esc.
  - `fetch` + `ReadableStream` para SSE.
  - Render seguro con `textContent`.
  - Tarjetas de producto, cotización y escalado.
  - `furent_bag` y navegación a checkout/login.
  - Persistencia de conversación y estado.
- [x] **5.3** Incluir el fragmento en `fragments/layout.html` con `th:if="${assistantEnabled}"`.
- [x] **5.4** Exponer `assistantEnabled` en `GlobalModelAdvice` (flag + API key).
- [x] **5.5** Añadir soporte seguro de `redirect` en login:
  - Campo oculto en `login.html` si el parámetro es una ruta interna.
  - `roleBasedSuccessHandler` redirige a `redirect` válido; si no, comportamiento actual.
- [ ] **5.6** Prueba manual en escritorio y móvil: *(pendiente: requiere `GEMINI_API_KEY`)*
  - invitado consulta y cotiza;
  - agregar a bolsa;
  - login y retorno a `/cotizacion`;
  - escalado a WhatsApp;
  - recarga y restauración.
  - Nota: verificado por API real (invitado consulta y cotiza, tarjetas + cotización +
    persistencia en MongoDB + panel admin). Queda pendiente la pasada manual en navegador
    (agregar a bolsa, login y retorno, botón de WhatsApp, recarga).

### Archivos

```
src/main/resources/templates/fragments/assistant-widget.html (nuevo)
src/main/resources/static/js/assistant.js                    (nuevo)
src/main/resources/templates/fragments/layout.html           (editar)
src/main/java/com/alquiler/furent/config/GlobalModelAdvice.java (editar)
src/main/resources/templates/login.html                      (editar)
src/main/java/com/alquiler/furent/config/SecurityConfig.java (editar)
```

### Verificación

- Abrir `http://localhost:8080`, probar los flujos y revisar la consola sin errores.
- Comprobar que sin `GEMINI_API_KEY` el widget no aparece.

### Commit

`feat(asistente): widget flotante y retorno seguro al checkout`

---

## Fase 6 — Panel de administración

**Objetivo:** revisar conversaciones y medir uso.

### Tareas

- [x] **6.1** Crear `controller/admin/AdminAssistantController.java`.
  - Listado con filtros y paginación.
  - Detalle con mensajes.
  - Cerrar conversación.
  - Export CSV.
- [x] **6.2** Crear `templates/admin/asistente.html`.
  - Tarjetas de métricas y tabla con filtros.
- [x] **6.3** Crear `templates/admin/asistente-detalle.html`.
  - Transcripción, herramientas y metadatos.
- [x] **6.4** Añadir enlace “Asistente IA” en `templates/fragments/admin-layout.html`.
- [x] **6.5** Test de controller (datos y filtros); el acceso queda cubierto por
  `SecurityConfig` (`/admin/**` requiere `ROLE_ADMIN`).

### Archivos

```
src/main/java/com/alquiler/furent/controller/admin/AdminAssistantController.java (nuevo)
src/main/resources/templates/admin/asistente.html                             (nuevo)
src/main/resources/templates/admin/asistente-detalle.html                     (nuevo)
src/main/resources/templates/fragments/admin-layout.html                      (editar)
src/test/java/com/alquiler/furent/controller/admin/AdminAssistantControllerTest.java (nuevo)
```

### Verificación

- `/admin/asistente` carga con datos y sin ellos.
- Filtros y export funcionan.
- Un usuario sin rol ADMIN recibe 403.

### Commit

`feat(asistente): panel admin de conversaciones y métricas`

---

## Fase 7 — Endurecimiento, pruebas y documentación

**Objetivo:** dejar el asistente listo para producción.

### Tareas

- [x] **7.1** Revisar métricas y logs con una conversación real. *(requiere `GEMINI_API_KEY`)*
  - Verificado con `gemini-3.5-flash-lite`: dos turnos reales (consulta + cotización) sin errores
    del asistente en el log; se emiten las métricas `furent.assistant.*` (`messages`, `tool.calls`,
    `tokens`, `quotes`, `latency`).
  - Corrección necesaria para Gemini 3.x: reenviar el `thoughtSignature` de cada `functionCall`
    (omitirlo devuelve `400 INVALID_ARGUMENT`).
- [ ] **7.2** Ajustar el prompt con 10 conversaciones de prueba (tono, longitud, precisión). *(pendiente: requiere `GEMINI_API_KEY`)*
- [x] **7.3** Verificar rate limit, cuota diaria y fallback a WhatsApp.
- [x] **7.4** Verificar retención (`expireAt`) y que no se guarden datos sensibles.
  - Verificado en código: `expireAt` se asigna a invitados (y se limpia al iniciar sesión);
    los mensajes TOOL guardan solo herramienta y resumen de argumentos.
- [x] **7.5** Actualizar `README.md` con:
  - configuración de `GEMINI_API_KEY`;
  - cómo activar/desactivar el asistente;
  - cómo cambiar de modelo;
  - enlace a la spec y al plan.
- [x] **7.6** Ejecutar `.\mvnw.cmd test` y documentar fallos preexistentes.
- [x] **7.7** Revisión final contra los criterios de aceptación de la spec.

### Archivos

```
README.md                                                      (editar)
docs/specs/2026-11-20-asistente-llm-design.md                  (ajustes si aplica)
docs/plans/2026-11-20-asistente-llm-implementation-plan.md     (marcar tareas)
```

### Verificación

- Los 12 criterios de aceptación de la spec se cumplen.
- `.\mvnw.cmd test` sin fallos nuevos.

### Commit

`docs(asistente): configuración, operación y cierre de la implementación`

---

## Orden de commits

| # | Commit | Fase |
|---|---|---|
| 1 | `feat(asistente): configuración, modelos y repositorios base` | 1 |
| 2 | `feat(asistente): cliente Gemini con streaming y parser SSE` | 2 |
| 3 | `feat(asistente): prompt, conocimiento y herramientas de negocio` | 3 |
| 4 | `feat(asistente): orquestador, endpoint SSE y rate limiting` | 4 |
| 5 | `feat(asistente): widget flotante y retorno seguro al checkout` | 5 |
| 6 | `feat(asistente): panel admin de conversaciones y métricas` | 6 |
| 7 | `docs(asistente): configuración, operación y cierre` | 7 |

---

## Rollback

- Desactivar `furent.features.assistant-enabled=false` oculta el widget y devuelve 503 en el
  endpoint, sin borrar datos.
- Revertir commits por fase en orden inverso.
- Los datos en `asistente_conversaciones` y `asistente_mensajes` se pueden conservar o
  borrar; no afectan reservas ni pagos.

---

## Definition of done

1. Widget visible solo con flag y API key.
2. Invitado y usuario pueden conversar en streaming.
3. Búsqueda, disponibilidad y cotización usan datos reales.
4. “Agregar y continuar” llena `furent_bag` y lleva al checkout o al login.
5. Reservas propias consultables solo por su dueño.
6. Escalado automático y manual a WhatsApp.
7. Conversaciones visibles en `/admin/asistente`.
8. Rate limit, cuota, timeout y fallback funcionando.
9. Tests nuevos en verde y sin llamadas reales a Gemini.
10. README y spec actualizados.
