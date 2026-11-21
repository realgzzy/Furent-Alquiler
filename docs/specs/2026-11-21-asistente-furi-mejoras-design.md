# Asistente Furi — Mejoras de conversación, historial y panel lateral

Fecha: 2026-11-21
Estado: aprobado para implementación

## Contexto

El widget del asistente (`fragments/assistant-widget.html` + `static/js/assistant.js`)
tiene hoy un único hilo guardado en `localStorage`, header con estado "En línea", un
compositor con aviso temporal, y toda la interacción ocurre en burbujas dentro del chat.
El backend (`assistant/*`, `controller/AssistantController`) ya persiste conversaciones por
sesión/usuario en Mongo, con herramientas de catálogo, disponibilidad, cotización y reservas.

Este documento especifica un conjunto de mejoras pedidas por el cliente.

## Objetivo

1. Chat nuevo en cada recarga; historial de chats anterior (mínimo 2) accesible desde un
   botón flotante a la izquierda.
2. El scroll del chat no debe arrastrar la página; al abrir un chat, ir al último mensaje.
3. Calendario de fechas visible completo (sin barra de scroll interna).
4. Header "Asistente Furi" (sin "En línea"/"Responde al instante") y saludo inicial de Furi.
5. El aviso temporal ya no vive en el compositor: aparece como burbuja de nota al iniciar el chat.
6. Resaltar datos importantes en las respuestas.
7. Furi recomienda mobiliario por tipo de evento, personas, estilo y presupuesto; puede ver y
   editar la bolsa del usuario; responde consultas de alquiler/estado/pagos.
8. Las entradas estructuradas (formulario de evento, calendario de fechas, carrito, seguimiento)
   se despliegan en un **panel lateral a la izquierda del chat** para no saturar la conversación.
9. El panel admin puede cerrar y **eliminar** conversaciones.

## Decisiones aprobadas

- Historial en **servidor por sesión** (invitados por `sessionId`, autenticados por `userId`).
- Varios chats con **borrado desde el widget**; un chat sin mensajes no se crea en servidor.
- Tarjeta de evento con: tipo de evento, no de personas, estilo, presupuesto, rango de fechas y nota.
- Nuevas capacidades: alquiler conversacional, gestión de carrito desde el chat, consulta de
  alquileres con estado y pagos, y **panel lateral izquierdo** para campos/elegir/funciones densas.
- Estilo visual del chat inspirado en una referencia limpia (fondo blanco, avatar del asistente
  junto a la burbuja, burbujas suaves, compositor tipo pastilla con botón circular). Se conserva
  el acento terracota de Furent y **no** se reintroduce el estado "En línea".

## Arquitectura

### Backend

**Modelo `AssistantConversation`**
- Nuevo campo `titulo` (String). Se setea con el primer mensaje del usuario (recortado a ~60 car.).

**`AssistantConversationService`**
- `list(ToolContext, int limit)`: devuelve las conversaciones del usuario/sesión ordenadas por
  `ultimoMensaje` desc.
- `delete(AssistantConversation)`: borra la conversación y sus mensajes.
- El título se fija al guardar el primer mensaje de usuario (`saveUserMessage`).
- El mensaje del asistente guardado se sigue almacenando.

**`AssistantController`**
- `GET /api/asistente/conversations` → `{ conversations: [{conversationId, titulo, estado,
  creada, ultimoMensaje, totalMensajes, cotizo, totalCotizado}] }` (máx. 30).
- `DELETE /api/asistente/conversations/{id}` → borra si es propia.
- `ToolContext` incorpora la bolsa enviada por el cliente (constructor de 2 args se mantiene).

**`AssistantChatRequest`**
- Nuevo campo `bag`: lista de `{id, nombre, cantidad, precioDia}` (tope ~50). Se mapea a
  `ToolContext`.

**Nuevas herramientas** (`AssistantToolDefinitions` + `tools.json` + `AssistantToolService`)
- `mi_bolsa`: devuelve lo que el usuario tiene en la bolsa, re-consultando precio/stock reales;
  emite tarjetas y un evento `bag`.
- `editar_bolsa` (`operacion`: agregar | quitar | cambiar_cantidad | vaciar, `items`): emite un
  evento `bag` con la operación; el frontend aplica sobre `furent_bag`.
- `recomendar_evento` (`tipoEvento`, `invitados`, `estilo`, `presupuesto`, `fechaInicio?`,
  `fechaFin?`): propone mobiliario con cantidades (sillas ≈ invitados, mesas ≈ invitados/8,
  mantelería, decoración), filtra por estilo y presupuesto, emite tarjetas y devuelve el set
  sugerido.
- `pedir_datos_evento`: emite un evento `panel` con el formulario de evento.
- `consultar_alquiler` (extiende `estado_reserva`/`mis_reservas`): incluye pagos registrados y
  emite un evento `panel` de seguimiento (timeline).
- `mostrar_fechas`: emite un evento `panel` con el calendario de rango.

**Eventos SSE nuevos** (`UiEvent`)
- `form` → `{titulo, descripcion, submitLabel, fields:[{name,label,type,options?,placeholder?,required?}]}`
- `panel` → `{vista, data}` (`vista` ∈ `form | fechas | bolsa | alquiler`). El frontend abre el
  panel lateral con esa vista. `form` se conserva por compatibilidad pero el widget puede
  renderizarlo también como panel.
- `bag` → `{operacion, items}` para mutar la bolsa local.
- `reservation` → resumen de reserva + timeline + pagos (para el panel de seguimiento).

**Prompt** (`AssistantPromptBuilder`)
- Reglas nuevas: alquiler conversacional; recomendar por evento/personas/estilo/presupuesto;
  revisar `mi_bolsa`; usar `pedir_datos_evento` al inicio o al pedir recomendaciones; interpretar
  el mensaje consolidado "Datos de mi evento:…"; usar `consultar_alquiler` para estado y pagos;
  resaltar datos clave con `**…**` y `==…==`.
- Se aclara que los formularios/fechas/carrito se muestran en el panel lateral (no en el hilo).

### Frontend

**`fragments/assistant-widget.html`**
- Estilo del chat limpio (referencia): header blanco con título "Asistente Furi", burbujas
  suaves, avatar del asistente, compositor tipo pastilla con `+` y botón circular de envío.
- Botón flotante izquierdo "Mis chats" (arriba del botón de WhatsApp) + cajón de historial.
- Panel lateral izquierdo de ancho variable dentro del contenedor del asistente: `[panel | chat]`.
  En móvil el panel ocupa todo el ancho y se apila.
- Se quita el aviso del compositor; se agrega estilo de burbuja `.fa-note`.
- Se compacta el calendario y se elimina su scroll interno.
- `.fa-messages { overscroll-behavior: contain; }`.

**`static/js/assistant.js`**
- Ya no persiste mensajes en `localStorage`; el historial sale del servidor.
- Al cargar, siempre arranca un chat nuevo vacío (con nota temporal y CTA de evento).
- Funciones: `loadChatList`, `openChatList`, `openConversation(id)`, `deleteConversation(id)`,
  `newChat`, `renderNote`, `openSidePanel(vista, data)`, `closeSidePanel`, `appendFormCard`,
  `appendBagPanel`, `appendReservationPanel`, `applyBagEvent`.
- Al abrir/restaurar: `scrollDown()`.
- `streamChat` incluye `bag` en el payload.
- Markdown: soporta `==texto==` → `.fa-hl`; `strong` con estilo prominente.

**Admin** (`controller/admin/AdminAssistantController` + plantillas)
- `POST /admin/asistente/{id}/eliminar` (borra conversación + mensajes, auditoría, redirect).
- Botón "Eliminar" en detalle y en cada fila del listado, con confirmación.

## Estados y errores

- Lista de chats vacía → mensaje "Aún no tienes chats".
- Fallo al cargar historial → toast de error, el chat sigue usable.
- Fallo al borrar → toast de error, no se quita de la lista.
- Sin sesión/`localStorage` bloqueado → el widget funciona igual; la bolsa cae a memoria de sesión.
- Formulario: campos obligatorios validados en el cliente; si falta algo, el botón "Enviar" avisa.
- Panel lateral cerrable con Escape / botón; al cerrar se conserva el estado del chat.
- En móvil el panel lateral es pantalla completa y el botón vuelve al chat.

## Pruebas

- `AssistantControllerTest`: listar y borrar conversaciones propias/ajenas.
- `AdminAssistantControllerTest`: eliminar conversación.
- `AssistantToolServiceTest`: `mi_bolsa`, `editar_bolsa`, `recomendar_evento`, `pedir_datos_evento`,
  `consultar_alquiler`.
- `AssistantConversationServiceTest`: título, lista y borrado.
- `AssistantPromptBuilderTest`: verificación de reglas nuevas si aplica.

## Fuera de alcance

- Cambios de esquema en Mongo más allá del campo `titulo` (no se migran datos existentes).
- Autenticación nueva o cambios de seguridad.
- Rediseño del panel de administración más allá de los botones de cerrar/eliminar.
