# Asistente Furent — Incremento de conversión

Fecha: 2026-11-20
Estado: aprobado (incremento 1)

## Problema

- El texto del modelo se muestra con Markdown literal (`**...**`, listas), porque hoy se pinta con `textContent`.
- La cotización puede llegar como texto en vez de la tarjeta estructurada (`quote`), y el desglose se lee ambiguo (¿precio unitario o total de línea?).
- Al pasar de la cotización al checkout se pierden las fechas: `/cotizacion` las precarga desde `furent_selected_dates`, pero el asistente no las guarda.
- El invitado no tiene una ruta de conversión clara (WhatsApp con la cotización ya armada).

## Objetivo

Aumentar la conversión de la conversación a reserva/pago, con dos rutas:

- **Autenticado** → checkout de la web.
- **Invitado** → WhatsApp con la cotización prellenada, o crear cuenta y reservar.

## Alcance (incremento 1)

1. Render seguro de un Markdown mínimo (negrita, itálica, listas, enlaces).
2. `QuoteCard` determinística: fechas, días, unitario, subtotal, descuento y total.
3. CTAs según autenticación y disponibilidad de stock.
4. Prellenado de `furent_selected_dates` y `furent_bag` desde la cotización.
5. Ajuste del prompt para usar `cotizar` y no duplicar el desglose en el texto.
6. Eventos de medición de conversión.

Fuera de alcance: embudo guiado paso a paso, calendario inline, PDF de la cotización, búsqueda por imagen y voz.

## Flujos

### Invitado

1. El asistente cotiza y emite el evento `quote`.
2. La tarjeta muestra **Continuar por WhatsApp** (primario) y **Crear cuenta y reservar** (secundario).
3. WhatsApp abre con un mensaje prellenado: ítems, cantidades, fechas y total.
4. "Crear cuenta" guarda bolsa + fechas y navega a `/login?redirect=/cotizacion`.

### Autenticado

1. La tarjeta muestra **Reservar ahora** (primario).
2. Guarda `furent_selected_dates`, agrega los ítems a `furent_bag` y navega a `/cotizacion`.
3. Secundario: **Enviar por WhatsApp**.

### Sin stock

- Si `puedeContinuar` es `false`, no se ofrece checkout: se muestra **Ajustar cantidades** y la opción de hablar con un asesor.

## Contrato de datos

El evento `quote` ya incluye:

- `items[]` con `id`, `nombre`, `imagen`, `precioDia`, `cantidad`, `subtotal`.
- `dias`, `fechaInicio`, `fechaFin`, `subtotal`, `descuento`, `total`.
- `checkoutUrl` y `puedeContinuar`.

El evento `meta` ya incluye `whatsapp`. No se requieren cambios de backend en el contrato.

## Componentes

- `renderMarkdown(container, text)`: construye nodos de texto; nunca usa `innerHTML`; enlaces limitados a `http(s)`, `mailto` y rutas relativas.
- `appendQuoteCard(data)`: tarjeta estructurada con fechas y acciones.
- `prepararReserva(data)`: guarda fechas y bolsa.
- `abrirWhatsApp(texto)`: abre `wa.me` con el número de `meta.whatsapp`.
- `cotizacionTexto(data)`: arma el mensaje determinístico para WhatsApp.
- `offerRetry()`: reintenta el último mensaje tras un error.
- `trackAssistantEvent(name)`: emite `furent:assistant-event` y `dataLayer` si existe.

## Prompt

- Si hay productos, fechas y cantidades: **usar la herramienta `cotizar`** y no escribir precios a mano.
- No repetir el desglose ni los totales en el texto: la tarjeta ya los muestra. Responder en 1–2 frases.
- Evitar tablas y Markdown complejo.

## Estados

- Vacío (bienvenida + sugerencias), streaming, error con reintento, rate limit y sin stock.

## Pruebas

- `node --check` del JS.
- Suite del asistente (`AssistantPromptBuilderTest` y relacionados).
- E2E: invitado, autenticado, cotización con descuento y cotización sin stock.

## Medición

- `assistant_quote_view`, `assistant_checkout_click`, `assistant_whatsapp_click`.
- Se emiten por `furent:assistant-event` y por `window.dataLayer` cuando exista.

---

## Incremento 2 — Calendario / disponibilidad inline

Estado: aprobado e implementado.

### Problema

- Escribir las fechas a mano en el chat añade fricción y produce formatos ambiguos.
- El invitado no ve qué días están ocupados y el asistente debe aclarar disponibilidad a mano.

### Alcance

1. Botón de calendario en el compositor del widget (siempre visible).
2. Calendario de **rango** con flatpickr (ya cargado en `layout.html`): bloquea fechas pasadas y limita a **máximo 7 días**.
3. **Días ocupados solo para usuarios autenticados**, reutilizando `GET /api/productos/availability?ids=...` con los productos mostrados en la conversación.
4. Píldora con el rango elegido (`25 – 27 nov 2026 · 3 días`) y acciones **Limpiar** / **Usar estas fechas**.
5. Al confirmar: guarda `furent_selected_dates` y **envía al asistente** un mensaje `Usa estas fechas para mi evento: AAAA-MM-DD al AAAA-MM-DD`, que continúa el flujo de disponibilidad + cotización.
6. Degradación a dos `<input type="date">` si flatpickr no está disponible.

Fuera de alcance: cambios de backend, exponer `/api/productos/availability` a invitados, y selección de fechas dentro del hilo por señalización del modelo.

### Flujo

1. El usuario abre el calendario, elige desde y hasta (máx. 7 días).
2. La píldora resume el rango; **Usar estas fechas** lo confirma.
3. Se guardan las fechas y se envía el mensaje al asistente, que consulta disponibilidad y cotiza.
4. La tarjeta de cotización ya precarga el checkout con esas fechas.

### Notas de implementación

- `assistant.js`: `initDatePicker`, `onDatesChange`, `updateDatesUI`, `useDates`, `clearDates`,
  `readSavedDates`, `rememberDates`, `loadReservedDays`, `applyReserved`, `markReserved`,
  `findReserved` y utilidades (`toIso`, `parseIso`, `addDaysIso`, `diasEntre`, `rangoCorto`).
- `rememberContextProduct(data)` registra los ids de los productos mostrados para pedir su disponibilidad.
- `assistant-widget.html`: estilos `.fa-dates*`, `.fa-calendar*` y variantes `.dark`, más el marcado del compositor.
- `AssistantPromptBuilder.java`: regla 14 reconoce el mensaje de fechas ISO y no vuelve a preguntarlas.
- Sin cambios de backend ni de `SecurityConfig`.

### Pruebas

- `node --check` del JS.
- E2E invitado (fechas → mensaje → cotización) y autenticado (días ocupados marcados).
