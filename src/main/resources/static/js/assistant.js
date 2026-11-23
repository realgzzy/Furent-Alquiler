/**
 * Widget del asistente virtual de Furent.
 *
 * - Habla con POST /api/asistente/chat y consume el stream SSE con fetch + ReadableStream.
 * - Renderiza todo con textContent/createElement: el texto del modelo nunca se inyecta como HTML.
 * - Markdown mínimo (negrita, itálica, resaltado ==texto==, listas y enlaces) con nodos seguros.
 * - El historial de chats vive en el servidor: al cargar siempre se empieza un chat nuevo y la
 *   opción "Mis chats" del menú lista las conversaciones propias para abrir o borrar.
 * - Las entradas estructuradas (formulario de evento, calendario de fechas, bolsa y seguimiento
 *   del alquiler) se muestran en el panel lateral izquierdo del chat.
 * - Integra cotizaciones con la bolsa (`furent_bag`) y el checkout de la web.
 */
(function () {
    'use strict';

    var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
        'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    var MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    // Semana en español: empieza el lunes.
    var DIAS_CORTOS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
    var DIAS_LARGO = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    var BAG_KEY = 'furent_bag';
    // Conversación activa, para sobrevivir la navegación entre páginas (no las recargas).
    var ACTIVE_KEY = 'furent_active_conversation';

    /**
     * Preguntas sugeridas por página. Se inyectan en el compositor al cargar, de modo que
     * el usuario vea atajos útiles para lo que está viendo (catálogo, checkout, producto...).
     */
    var PAGE_SUGGESTIONS = [
        {
            match: /^\/catalogo/,
            placeholder: 'Busca mobiliario: sillas, mesas, carpas...',
            items: [
                { label: 'Sillas para una boda', prompt: 'Necesito sillas para una boda' },
                { label: 'Mesas para 100 personas', prompt: 'Busco mesas para 100 personas' },
                { label: 'Algo elegante y moderno', prompt: 'Busco mobiliario elegante y moderno para mi evento' },
                { label: 'Comparar precios', prompt: '¿Qué opciones tengo por menos de $8.000 al día?' }
            ]
        },
        {
            match: /^\/producto|^\/combo/,
            placeholder: 'Pregunta por este producto, stock o fechas...',
            items: [
                { label: '¿Está disponible?', prompt: '¿Este producto está disponible para mis fechas?' },
                { label: '¿Cuántas unidades hay?', prompt: '¿Cuántas unidades tienen disponibles de este producto?' },
                { label: 'Combinar con otros muebles', prompt: '¿Con qué otros muebles puedo combinar este producto?' },
                { label: 'Agregar a mi bolsa', prompt: 'Agrega este producto a mi bolsa' }
            ]
        },
        {
            match: /^\/cotizacion|^\/pago/,
            placeholder: 'Dudas con fechas, envío o formas de pago...',
            items: [
                { label: '¿Cómo va mi cotización?', prompt: '¿Cómo va mi cotización?' },
                { label: 'Cambiar fechas', prompt: 'Necesito cambiar las fechas de mi alquiler' },
                { label: 'Costo de envío y montaje', prompt: '¿Cuánto cuesta el envío y el montaje?' },
                { label: 'Formas de pago', prompt: '¿Qué formas de pago aceptan?' }
            ]
        },
        {
            match: /^\/panel|^\/reserva|^\/mis-reservas|^\/cuenta/,
            placeholder: 'Consulta tus reservas, pagos o cambios...',
            items: [
                { label: 'Estado de mi alquiler', prompt: '¿Cómo va el estado de mi alquiler?' },
                { label: 'Mis reservas', prompt: 'Muéstrame mis reservas' },
                { label: 'Cambiar o cancelar', prompt: 'Necesito cambiar o cancelar una reserva' },
                { label: 'Hablar con un asesor', prompt: 'Quiero hablar con un asesor' }
            ]
        },
        {
            match: /^\/contacto|^\/faq|^\/nosotros|^\/inspiracion/,
            placeholder: 'Pregunta lo que necesites...',
            items: [
                { label: 'Horarios y ubicación', prompt: '¿Cuál es su horario y dónde están ubicados?' },
                { label: 'Cobertura de envío', prompt: '¿A qué zonas hacen envíos?' },
                { label: 'Ideas para mi evento', prompt: 'Dame ideas de mobiliario para mi evento' },
                { label: 'Hablar con un asesor', prompt: 'Quiero hablar con un asesor' }
            ]
        }
    ];

    var PAGE_SUGGESTIONS_DEFAULT = {
        placeholder: 'Escribe tu duda o lo que necesitas...',
        items: [
            { label: 'Sillas y mesas para una boda', prompt: 'Necesito sillas y mesas para una boda' },
            { label: 'Organizar mi evento', prompt: 'Quiero organizar un cumpleaños para 50 personas' },
            { label: 'Ver mi bolsa', prompt: '¿Qué tengo en mi bolsa?' },
            { label: 'Estado de mi alquiler', prompt: '¿Cómo va el estado de mi alquiler?' }
        ]
    };

    // Tokens de Markdown inline. `==texto==` resalta datos importantes.
    var INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|==[^=]+==|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var launcher = document.getElementById('furent-assistant-launcher');
        var panel = document.getElementById('furent-assistant-panel');
        if (!launcher || !panel) {
            return;
        }

        var els = {
            launcher: launcher,
            panel: panel,
            messages: document.getElementById('furent-assistant-messages'),
            input: document.getElementById('furent-assistant-input'),
            send: document.getElementById('furent-assistant-send'),
            close: document.getElementById('furent-assistant-close'),
            badge: document.getElementById('furent-assistant-badge'),
            plus: document.getElementById('furent-assistant-plus'),
            quick: document.getElementById('furent-assistant-quick'),
            quickDates: document.getElementById('furent-assistant-quick-dates'),
            quickEvent: document.getElementById('furent-assistant-quick-event'),
            quickBag: document.getElementById('furent-assistant-quick-bag'),
            quickChats: document.getElementById('furent-assistant-quick-chats'),
            quickSuggest: document.getElementById('furent-assistant-quick-suggest'),
            chips: document.getElementById('furent-assistant-chips'),
            side: document.getElementById('furent-assistant-side'),
            sideTitle: document.getElementById('furent-assistant-side-title'),
            sideClose: document.getElementById('furent-assistant-side-close'),
            viewForm: document.getElementById('furent-assistant-view-form'),
            viewDetalles: document.getElementById('furent-assistant-view-detalles'),
            viewFechas: document.getElementById('furent-assistant-view-fechas'),
            viewBolsa: document.getElementById('furent-assistant-view-bolsa'),
            viewReco: document.getElementById('furent-assistant-view-reco'),
            viewAlquiler: document.getElementById('furent-assistant-view-alquiler'),
            viewComparar: document.getElementById('furent-assistant-view-comparar'),
            viewResenas: document.getElementById('furent-assistant-view-resenas'),
            viewInspiracion: document.getElementById('furent-assistant-view-inspiracion'),
            viewDirecciones: document.getElementById('furent-assistant-view-direcciones'),
            viewNotificaciones: document.getElementById('furent-assistant-view-notificaciones'),
            viewPlan: document.getElementById('furent-assistant-view-plan'),
            viewMesas: document.getElementById('furent-assistant-view-mesas'),
            viewPresupuesto: document.getElementById('furent-assistant-view-presupuesto'),
            calendarHost: document.getElementById('furent-assistant-calendar-host'),
            calendarClear: document.getElementById('furent-assistant-calendar-clear'),
            calendarUse: document.getElementById('furent-assistant-calendar-use'),
            calendarHint: document.getElementById('furent-assistant-calendar-hint'),
            eventTime: document.getElementById('furent-assistant-event-time'),
            timeQuick: document.getElementById('furent-assistant-time-quick'),
            timeWrap: document.getElementById('furent-assistant-event-time-wrap'),
            history: document.getElementById('furent-assistant-history'),
            historyList: document.getElementById('furent-assistant-history-list'),
            historyClose: document.getElementById('furent-assistant-history-close'),
            historyNew: document.getElementById('furent-assistant-history-new')
        };

        var chatUrl = panel.getAttribute('data-chat-url') || '/api/asistente/chat';
        var apiBase = chatUrl.replace(/\/chat$/, '');
        var feedbackUrl = apiBase + '/feedback';
        var quotePdfUrl = apiBase + '/cotizacion/pdf';
        var listUrl = (els.history && els.history.getAttribute('data-list-url'))
            || '/api/asistente/conversations';
        var authenticated = panel.getAttribute('data-authenticated') === 'true';
        var DEFAULT_WHATSAPP = '573105782442';

        // Para invitados el asistente pide iniciar sesión o registrarse; "Mis chats" no aplica.
        if (!authenticated) {
            var guestChats = document.getElementById('furent-assistant-quick-chats');
            if (guestChats) {
                guestChats.hidden = true;
            }
        }
        var headerAvatar = panel.querySelector('.fa-avatar img');
        var avatarSrc = headerAvatar ? headerAvatar.getAttribute('src') : '/images/furi.png';

        var state = { conversationId: null, whatsapp: null, closed: false };
        var lastQuote = null;          // última cotización mostrada, para exportarla a PDF
        var isOpen = false;
        var isStreaming = false;
        var currentBubble = null;
        var lastFocused = null;
        var lastUserText = '';
        var sideVista = null;
        var chatList = [];
        var authGateShown = false;

        // Estado del calendario de fechas (RangeCalendar propio, sin dependencias externas).
        var datesCalendar = null;      // calendario del panel lateral "Elegir fechas"
        var formFieldCal = null;       // calendario del campo de fechas del formulario
        var formPopover = null;        // popover abierto del campo de fechas (o null)
        var pendingStart = null;       // inicio elegido pero aún sin enviar (ISO y-m-d)
        var pendingEnd = null;         // fin elegido pero aún sin enviar (ISO y-m-d)
        var lastProductIds = [];       // ids de los productos mostrados, para consultar disponibilidad
        var reservedCache = {};        // { "ids": [{from,to}] } caché por conjunto de productos
        var reservedRanges = [];       // rangos ocupados vigentes para el contexto actual
        var pendingTime = '';          // hora del evento elegida en la vista de fechas

        els.launcher.addEventListener('click', openPanel);
        els.close.addEventListener('click', closePanel);
        els.send.addEventListener('click', function () { submitFromInput(); });
        els.input.addEventListener('keydown', function (event) {
            if (event.key === '/' && !els.input.value.trim() && els.chips && els.chips.hidden) {
                event.preventDefault();
                toggleSuggestions();
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitFromInput();
            }
        });
        els.input.addEventListener('input', function () {
            els.input.style.height = 'auto';
            els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
        });

        if (els.plus) {
            els.plus.addEventListener('click', toggleQuick);
        }
        if (els.quickDates) {
            els.quickDates.addEventListener('click', function () { openSidePanel('fechas'); });
        }
        if (els.quickEvent) {
            els.quickEvent.addEventListener('click', function () { openSidePanel('form', defaultFormData()); });
        }
        if (els.quickBag) {
            els.quickBag.addEventListener('click', function () { openSidePanel('bolsa'); });
        }
        if (els.quickSuggest) {
            els.quickSuggest.addEventListener('click', toggleSuggestions);
        }
        if (els.quickChats) {
            els.quickChats.addEventListener('click', function () {
                if (els.history && !els.history.hidden) {
                    closeHistory();
                } else {
                    collapseQuick();
                    openHistory();
                }
            });
        }
        if (els.sideClose) {
            els.sideClose.addEventListener('click', function () { closeSidePanel(); collapseQuick(); });
        }

        // Atajos de hora: rellenan el campo y se marcan como seleccionados.
        if (els.eventTime) {
            els.eventTime.addEventListener('input', function () {
                pendingTime = els.eventTime.value || '';
                syncTimeQuick();
                updateDatesUI();
            });
        }
        if (els.timeQuick) {
            els.timeQuick.addEventListener('click', function (event) {
                var chip = event.target.closest('[data-time]');
                if (!chip || !els.eventTime) {
                    return;
                }
                var valor = chip.getAttribute('data-time');
                els.eventTime.value = valor;
                pendingTime = valor;
                syncTimeQuick();
                updateDatesUI();
            });
        }

        els.chips.addEventListener('click', function (event) {
            var chip = event.target.closest('.fa-chip');
            if (chip && chip.getAttribute('data-prompt')) {
                collapseSuggestions();
                collapseQuick();
                sendUserMessage(chip.getAttribute('data-prompt'));
            }
        });

        if (els.historyClose) {
            els.historyClose.addEventListener('click', closeHistory);
        }
        if (els.historyNew) {
            els.historyNew.addEventListener('click', newChat);
        }

        document.addEventListener('click', function (event) {
            if (openSelect && !openSelect.control.contains(event.target)) {
                closeOpenSelect();
            }
            if (!isOpen) {
                return;
            }
            if (els.quick && !els.quick.hidden
                    && !els.quick.contains(event.target)
                    && els.plus && !els.plus.contains(event.target)
                    && !(els.chips && els.chips.contains(event.target))) {
                collapseQuick();
            }
            if (els.chips && !els.chips.hidden
                    && !els.chips.contains(event.target)
                    && els.quickSuggest && !els.quickSuggest.contains(event.target)) {
                collapseSuggestions();
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                if (openSelect) {
                    closeOpenSelect();
                } else if (els.history && !els.history.hidden) {
                    closeHistory();
                } else if (!isOpen) {
                    return;
                } else if (els.side && !els.side.hidden) {
                    closeSidePanel();
                } else if (els.chips && !els.chips.hidden) {
                    collapseSuggestions();
                } else if (els.quick && !els.quick.hidden) {
                    collapseQuick();
                } else {
                    closePanel();
                }
            } else if (event.key === 'Tab' && isOpen) {
                trapFocus(event);
            }
        });

        // ───────────────────────── Arranque ─────────────────────────

        function boot() {
            els.messages.textContent = '';
            state.conversationId = null;
            currentBubble = null;
            clearChatClosed();
            saveActiveId(null);
            closeSidePanel();
            resetDateState();
            updateHistoryActive();
            renderWelcome();
            scrollDown();
            loadChatList();
        }

        function renderWelcome() {
            appendNote('Este chat se cierra automáticamente a las 24 horas. Soy un asistente con IA; '
                + 'confirma precios y disponibilidad antes de reservar.');
            typeAssistantMessage('Hola, soy Furi. ¿En qué puedo ayudarte?', 560, function (row) {
                if (!row.isConnected) {
                    return;
                }
                var actions = document.createElement('div');
                actions.className = 'fa-row fa-enter';
                actions.style.flexWrap = 'wrap';
                actions.appendChild(button('Organizar mi evento', 'fa-btn-primary', function () {
                    openSidePanel('form', defaultFormData());
                }, ICONS.sparkles));
                actions.appendChild(button('Elegir fechas', 'fa-btn-ghost', function () {
                    openSidePanel('fechas');
                }, ICONS.calendar));
                els.messages.appendChild(actions);
                scrollDown();
            });
        }

        /** Muestra al asistente "escribiendo" y luego revela el texto. */
        function typeAssistantMessage(text, delay, done) {
            var built = assistantRow();
            var typing = document.createElement('span');
            typing.className = 'fa-typing';
            typing.appendChild(document.createElement('span'));
            typing.appendChild(document.createElement('span'));
            typing.appendChild(document.createElement('span'));
            built.bubble.appendChild(typing);
            els.messages.appendChild(built.row);
            scrollDown();
            window.setTimeout(function () {
                if (!built.row.isConnected) {
                    return;
                }
                renderMarkdown(built.bubble, text);
                scrollDown();
                if (typeof done === 'function') {
                    done(built.row);
                }
            }, delay || 500);
        }

        function appendNote(text) {
            var row = document.createElement('div');
            row.className = 'fa-note-row fa-enter';
            var note = document.createElement('div');
            note.className = 'fa-note';
            note.textContent = text;
            row.appendChild(note);
            els.messages.appendChild(row);
        }

        // ───────────────────────── Chat cerrado (solo lectura) ─────────────────────────

        /**
         * Aviso que se muestra cuando la conversación ya no admite escritura. El motivo
         * distingue el cierre por administrador del cierre automático por vigencia (24 h).
         */
        function appendClosedNotice(motivo) {
            var expirado = String(motivo || '').toUpperCase() === 'EXPIRADO';
            var row = document.createElement('div');
            row.className = 'fa-closed-row fa-enter';
            var box = document.createElement('div');
            box.className = 'fa-closed';

            var ico = document.createElement('span');
            ico.className = 'fa-closed-ico';
            ico.appendChild(svgIcon(ICONS.lock, 20));
            box.appendChild(ico);

            var title = document.createElement('p');
            title.className = 'fa-closed-title';
            title.textContent = 'Este chat está cerrado';
            box.appendChild(title);

            var desc = document.createElement('p');
            desc.className = 'fa-closed-desc';
            desc.textContent = expirado
                ? 'El chat se cerró automáticamente al cumplir 24 horas. Ya no puedes escribir aquí; '
                    + 'queda solo como historial.'
                : 'Un administrador cerró este chat. Ya no puedes escribir aquí; '
                    + 'queda solo como historial.';
            box.appendChild(desc);

            var actions = document.createElement('div');
            actions.className = 'fa-closed-actions';
            actions.appendChild(button('Empezar un chat nuevo', 'fa-btn-primary', newChat, ICONS.sparkles));
            box.appendChild(actions);

            row.appendChild(box);
            els.messages.appendChild(row);
            scrollDown();
        }

        /** Pone el compositor en solo lectura y muestra el aviso de chat cerrado. */
        function setChatClosed(motivo) {
            if (state.closed) {
                return;
            }
            state.closed = true;
            if (els.input) {
                els.input.value = '';
                els.input.style.height = 'auto';
                els.input.disabled = true;
                els.input.placeholder = 'Este chat está cerrado';
            }
            if (els.send) {
                els.send.disabled = true;
            }
            if (els.plus) {
                els.plus.disabled = true;
            }
            collapseSuggestions();
            collapseQuick();
            var card = els.panel.querySelector('.fa-composer-card');
            if (card) {
                card.classList.add('is-closed');
            }
            appendClosedNotice(motivo);
        }

        /** Restaura el compositor para un chat nuevo o activo. */
        function clearChatClosed() {
            state.closed = false;
            if (els.input) {
                els.input.disabled = false;
                els.input.placeholder = 'Escribe tu duda o lo que necesitas...';
            }
            if (els.send) {
                els.send.disabled = false;
            }
            if (els.plus) {
                els.plus.disabled = false;
            }
            var card = els.panel.querySelector('.fa-composer-card');
            if (card) {
                card.classList.remove('is-closed');
            }
        }

        // ───────────────────────── Panel ─────────────────────────

        function openPanel() {
            if (!isOpen) {
                lastFocused = document.activeElement;
            }
            isOpen = true;
            els.panel.hidden = false;
            els.launcher.hidden = true;
            els.launcher.setAttribute('aria-expanded', 'true');
            hideBadge();
            lockPageScroll(true);
            window.setTimeout(function () { els.input.focus(); }, 60);
        }

        function closePanel() {
            if (!isOpen) {
                return;
            }
            els.panel.hidden = true;
            els.launcher.hidden = false;
            els.launcher.setAttribute('aria-expanded', 'false');
            isOpen = false;
            collapseSuggestions();
            collapseQuick();
            closeHistory();
            lockPageScroll(false);
            if (lastFocused && typeof lastFocused.focus === 'function') {
                lastFocused.focus();
            }
        }

        /** Bloquea el scroll de la página mientras el chat está abierto. */
        function lockPageScroll(on) {
            var root = document.documentElement;
            if (on) {
                root.classList.add('fa-noscroll');
                document.body.classList.add('fa-noscroll');
            } else {
                root.classList.remove('fa-noscroll');
                document.body.classList.remove('fa-noscroll');
            }
        }

        function trapFocus(event) {
            var focusable = els.panel.querySelectorAll(
                'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])');
            if (focusable.length === 0) {
                return;
            }
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }

        // ───────────────────────── Envío ─────────────────────────

        function submitFromInput() {
            if (isStreaming || state.closed) {
                return;
            }
            var text = (els.input.value || '').trim();
            if (!text) {
                return;
            }
            if (!authenticated) {
                showAuthGate();
                return;
            }
            els.input.value = '';
            els.input.style.height = 'auto';
            sendUserMessage(text);
        }

        function sendUserMessage(text) {
            text = String(text || '').trim();
            if (!text || isStreaming || state.closed) {
                return;
            }
            collapseSuggestions();
            collapseQuick();
            if (!authenticated) {
                showAuthGate();
                return;
            }
            appendUserBubble(text, true);
            lastUserText = text;
            streamChat(text);
        }

        function streamChat(text) {
            isStreaming = true;
            els.send.disabled = true;
            beginAssistantReply();

            var payload = {
                message: text,
                pageContext: window.location.pathname,
                bag: readBagLines()
            };
            if (state.conversationId) {
                payload.conversationId = state.conversationId;
            }

            fetch(chatUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: JSON.stringify(payload)
            }).then(function (response) {
                if (!response.ok) {
                    return response.text().then(function (body) {
                        throw parseError(response.status, body);
                    });
                }
                if (!response.body) {
                    throw { mensaje: 'Tu navegador no soporta respuestas en vivo. Escríbenos por WhatsApp.' };
                }
                return readStream(response.body);
            }).catch(function (error) {
                if (error && error.codigo === 'AUTH_REQUIRED') {
                    closePendingBubble();
                    showAuthGate();
                    return;
                }
                if (error && error.codigo === 'CHAT_CLOSED') {
                    // El chat se cerró (administrador o 24 h): aviso y compositor bloqueado.
                    closePendingBubble();
                    state.closed = true;
                    if (state.conversationId) {
                        openConversation(state.conversationId, true);
                    } else {
                        setChatClosed(null);
                    }
                    return;
                }
                failReply(error && error.mensaje
                    ? error.mensaje
                    : 'No pude responder ahora mismo. Puedes intentar de nuevo o escribirnos por WhatsApp.');
                offerRetry(text);
                offerWhatsApp();
            }).finally(function () {
                isStreaming = false;
                if (!state.closed) {
                    els.send.disabled = false;
                }
                updateDatesUI();
                finishReply();
                updateHistoryActive();
            });
        }

        function readStream(body) {
            var reader = body.getReader();
            var decoder = new TextDecoder('utf-8');
            var buffer = '';

            function pump() {
                return reader.read().then(function (result) {
                    if (result.done) {
                        if (buffer.trim()) {
                            dispatchRawEvent(buffer);
                        }
                        return;
                    }
                    buffer += decoder.decode(result.value, { stream: true });
                    var index;
                    while ((index = buffer.indexOf('\n\n')) >= 0) {
                        var raw = buffer.slice(0, index);
                        buffer = buffer.slice(index + 2);
                        dispatchRawEvent(raw);
                    }
                    return pump();
                });
            }
            return pump();
        }

        function dispatchRawEvent(raw) {
            var type = 'message';
            var dataLines = [];
            raw.split('\n').forEach(function (line) {
                if (line.indexOf('event:') === 0) {
                    type = line.slice(6).trim();
                } else if (line.indexOf('data:') === 0) {
                    dataLines.push(line.slice(5).replace(/^ /, ''));
                }
            });
            if (dataLines.length === 0) {
                return;
            }
            var payload;
            try {
                payload = JSON.parse(dataLines.join('\n'));
            } catch (e) {
                return;
            }
            handleEvent(type, payload);
        }

        // ───────────────────────── Eventos SSE ─────────────────────────

        function handleEvent(type, data) {
            switch (type) {
                case 'meta':
                    if (data && data.conversationId) {
                        state.conversationId = data.conversationId;
                        saveActiveId(data.conversationId);
                    }
                    if (data && data.whatsapp) {
                        state.whatsapp = String(data.whatsapp);
                    }
                    break;
                case 'token':
                    if (data && typeof data.text === 'string') {
                        appendToken(data.text);
                    }
                    break;
                case 'card':
                    closePendingBubble();
                    appendProductCard(data);
                    break;
                case 'quote':
                    closePendingBubble();
                    appendQuoteCard(data);
                    break;
                case 'document':
                    closePendingBubble();
                    downloadDocument(data);
                    break;
                case 'links':
                    closePendingBubble();
                    appendLinksCard(data);
                    break;
                case 'panel':
                    if (data && data.vista) {
                        openSidePanel(data.vista, data);
                    }
                    break;
                case 'bag':
                    applyBagEvent(data);
                    break;
                case 'reservation':
                    openSidePanel('alquiler', data);
                    break;
                case 'escalation':
                    closePendingBubble();
                    appendEscalationCard(data);
                    break;
                case 'error':
                    failReply(data && data.mensaje ? data.mensaje : 'Ocurrió un error inesperado.');
                    offerRetry(lastUserText);
                    offerWhatsApp();
                    break;
                case 'status':
                    if (data && data.texto) {
                        setAssistantStatus(data.texto);
                    }
                    break;
                case 'done':
                    var doneBubble = currentBubble;
                    closePendingBubble();
                    attachFeedback(doneBubble);
                    break;
                default:
                    break;
            }
        }

        // ───────────────────────── Burbujas ─────────────────────────

        function assistantRow() {
            var row = document.createElement('div');
            row.className = 'fa-row assistant fa-enter';
            var avatar = document.createElement('div');
            avatar.className = 'fa-avatar-sm';
            avatar.setAttribute('aria-hidden', 'true');
            var img = document.createElement('img');
            img.src = avatarSrc;
            img.alt = '';
            avatar.appendChild(img);
            var bubble = document.createElement('div');
            bubble.className = 'fa-bubble assistant';
            row.appendChild(avatar);
            row.appendChild(bubble);
            return { row: row, bubble: bubble };
        }

        function appendUserBubble(text, animate) {
            var row = document.createElement('div');
            row.className = animate ? 'fa-row user fa-enter' : 'fa-row user';
            var bubble = document.createElement('div');
            bubble.className = 'fa-bubble user';
            bubble.textContent = text;
            row.appendChild(bubble);
            els.messages.appendChild(row);
            scrollDown();
        }

        function appendAssistantBubble(text, animate) {
            var built = assistantRow();
            if (!animate) {
                built.row.classList.remove('fa-enter');
            }
            renderMarkdown(built.bubble, text);
            els.messages.appendChild(built.row);
            scrollDown();
        }

        function beginAssistantReply() {
            var built = assistantRow();
            built.row.setAttribute('data-pending', 'true');
            var typing = document.createElement('span');
            typing.className = 'fa-typing';
            typing.appendChild(document.createElement('span'));
            typing.appendChild(document.createElement('span'));
            typing.appendChild(document.createElement('span'));
            built.bubble.appendChild(typing);
            var status = document.createElement('span');
            status.className = 'fa-typing-text';
            status.hidden = true;
            built.bubble.appendChild(status);
            els.messages.appendChild(built.row);
            currentBubble = built.bubble;
            currentBubble._textSpan = null;
            currentBubble._status = status;
            currentBubble._raw = '';
            scrollDown();
        }

        /** "Typing Intelligence": dice qué está haciendo el asistente mientras espera. */
        function setAssistantStatus(text) {
            if (!currentBubble) {
                return;
            }
            var status = currentBubble._status;
            if (!status || !status.isConnected) {
                status = document.createElement('span');
                status.className = 'fa-typing-text';
                currentBubble._status = status;
                currentBubble.appendChild(status);
            }
            if (text) {
                status.textContent = text;
                status.hidden = false;
            } else {
                status.hidden = true;
                status.textContent = '';
            }
            scrollDown();
        }

        function clearAssistantStatus() {
            if (!currentBubble || !currentBubble._status) {
                return;
            }
            if (currentBubble._status.isConnected) {
                currentBubble._status.remove();
            }
            currentBubble._status = null;
        }

        function textSpanOf(bubble) {
            if (!bubble._textSpan) {
                bubble.textContent = '';
                bubble._status = null;
                var span = document.createElement('span');
                bubble.appendChild(span);
                bubble._textSpan = span;
            }
            return bubble._textSpan;
        }

        function appendToken(text) {
            if (!currentBubble) {
                beginAssistantReply();
            }
            clearAssistantStatus();
            currentBubble._raw = (currentBubble._raw || '') + text;
            textSpanOf(currentBubble).appendChild(document.createTextNode(text));
            scrollDown();
        }

        function closePendingBubble() {
            if (currentBubble) {
                if (currentBubble.classList.contains('error')) {
                    currentBubble.parentNode.removeAttribute('data-pending');
                    currentBubble = null;
                    return;
                }
                var raw = stripLeakedMarkup(currentBubble._raw || '');
                if (!raw) {
                    var row = currentBubble.parentNode;
                    if (row) {
                        row.remove();
                    }
                } else {
                    renderMarkdown(currentBubble, raw);
                    currentBubble.parentNode.removeAttribute('data-pending');
                }
                currentBubble = null;
            }
        }

        function failReply(message) {
            if (!currentBubble) {
                beginAssistantReply();
            }
            currentBubble.textContent = '';
            currentBubble._textSpan = null;
            currentBubble._status = null;
            currentBubble._raw = '';
            currentBubble.appendChild(document.createTextNode(message));
            currentBubble.classList.add('error');
            currentBubble.parentNode.removeAttribute('data-pending');
            scrollDown();
        }

        function finishReply() {
            if (currentBubble) {
                closePendingBubble();
            }
        }

        function offerWhatsApp() {
            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            var wa = button('Continuar por WhatsApp', 'fa-btn-wa', function () {
                abrirWhatsApp('Hola Furent, vengo del asistente virtual.', 'error');
            }, ICONS.whatsapp);
            wa.style.maxWidth = '85%';
            row.appendChild(wa);
            els.messages.appendChild(row);
            scrollDown();
        }

        function offerRetry(text) {
            if (!text) {
                return;
            }
            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            var retry = button('Reintentar', 'fa-btn-ghost', function () {
                row.remove();
                if (!isStreaming) {
                    streamChat(text);
                }
            }, ICONS.sliders);
            retry.style.maxWidth = '85%';
            row.appendChild(retry);
            els.messages.appendChild(row);
            scrollDown();
        }

        /** Destino interno seguro para volver tras iniciar sesión o registrarse. */
        function authRedirectTarget() {
            var path = window.location.pathname + window.location.search;
            return path && path.charAt(0) === '/' ? path : '/';
        }

        /**
         * Muestra el candado para visitantes: para hablar con Furi hace falta una cuenta.
         * Ofrece iniciar sesión o registrarse y conserva la página actual como destino de vuelta.
         */
        function showAuthGate() {
            if (authGateShown) {
                scrollDown();
                return;
            }
            authGateShown = true;

            var card = document.createElement('div');
            card.className = 'fa-quote fa-auth-gate';

            var head = document.createElement('div');
            head.className = 'fa-quote-head';
            var ico = document.createElement('span');
            ico.className = 'fa-quote-ico';
            ico.appendChild(svgIcon(ICONS.lock, 16));
            var title = document.createElement('h4');
            title.textContent = 'Necesitas una cuenta para hablar conmigo';
            head.appendChild(ico);
            head.appendChild(title);
            card.appendChild(head);

            var note = document.createElement('p');
            note.className = 'fa-quote-note';
            note.textContent = 'Crea tu cuenta gratis o inicia sesión y con gusto te ayudo con tu evento: '
                + 'recomendaciones, precios y disponibilidad en tiempo real.';
            card.appendChild(note);

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';
            var target = authRedirectTarget();
            actions.appendChild(button('Iniciar sesión', 'fa-btn-primary', function () {
                trackAssistantEvent('assistant_auth_gate', { accion: 'login' });
                window.location.href = '/login?redirect=' + encodeURIComponent(target);
            }, ICONS.user));
            actions.appendChild(button('Crear cuenta', 'fa-btn-ghost', function () {
                trackAssistantEvent('assistant_auth_gate', { accion: 'register' });
                window.location.href = '/registro?redirect=' + encodeURIComponent(target);
            }, ICONS.userPlus));
            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row assistant fa-enter';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
        }

        // ───────────────────────── Tarjetas ─────────────────────────

        function appendProductCard(data) {
            if (!data) {
                return;
            }
            rememberContextProduct(data);
            var card = document.createElement('div');
            card.className = 'fa-card';
            var media = document.createElement('div');
            media.className = 'fa-card-media';

            var img = document.createElement('img');
            img.alt = data.nombre || 'Producto';
            img.loading = 'lazy';
            if (data.imagen) {
                img.src = data.imagen;
            }
            media.appendChild(img);

            var info = document.createElement('div');
            info.style.flex = '1 1 auto';
            info.style.minWidth = '0';
            var name = document.createElement('p');
            name.className = 'fa-card-name';
            name.textContent = data.nombre || 'Producto';
            var meta = document.createElement('p');
            meta.className = 'fa-card-meta';
            var parts = [];
            if (data.categoria) {
                parts.push(data.categoria);
            }
            if (typeof data.stockDisponible === 'number') {
                parts.push('Stock disponible: ' + data.stockDisponible);
            } else if (typeof data.stock === 'number') {
                parts.push('Stock: ' + data.stock);
            }
            meta.textContent = parts.join(' · ');
            var price = document.createElement('p');
            price.className = 'fa-card-price';
            price.style.marginTop = '4px';
            price.textContent = formatCOP(data.precioDia) + ' / día';
            info.appendChild(name);
            info.appendChild(meta);
            info.appendChild(price);
            media.appendChild(info);
            card.appendChild(media);

            if (data.id && data.disponible !== false) {
                var actions = document.createElement('div');
                actions.className = 'fa-card-actions';
                actions.appendChild(button('Agregar a la bolsa', 'fa-btn-ghost', function () {
                    addLinesToBag([{
                        id: data.id,
                        nombre: data.nombre,
                        imagen: data.imagen,
                        precioDia: data.precioDia,
                        cantidad: 1,
                        stock: data.stock
                    }]);
                }, ICONS.cart));
                card.appendChild(actions);
            }

            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
        }

        function appendQuoteCard(data) {
            if (!data) {
                return;
            }
            lastQuote = data;
            // La cotización ya trae los datos del evento que el usuario dio en el chat: se guardan
            // de una vez para que /cotizacion llegue precargado, sin depender del botón que pulse.
            persistirDatosEvento(data);
            (data.items || []).forEach(function (item) { rememberContextProduct(item); });
            var card = document.createElement('div');
            card.className = 'fa-quote';

            var head = document.createElement('div');
            head.className = 'fa-quote-head';
            var badge = document.createElement('span');
            badge.className = 'fa-quote-ico';
            badge.appendChild(svgIcon(ICONS.receipt, 16));
            head.appendChild(badge);
            var headText = document.createElement('div');
            headText.style.minWidth = '0';
            var title = document.createElement('h4');
            title.textContent = 'Cotización estimada';
            headText.appendChild(title);
            var rango = rangoFechas(data);
            if (rango) {
                var dates = document.createElement('p');
                dates.className = 'fa-quote-dates';
                dates.textContent = rango;
                headText.appendChild(dates);
            }
            head.appendChild(headText);
            card.appendChild(head);

            (data.items || []).forEach(function (item) {
                card.appendChild(quoteItem(item));
            });

            if (typeof data.subtotal === 'number') {
                card.appendChild(quoteLine('Subtotal', formatCOP(data.subtotal)));
            }

            var discount = Number(data.descuento || 0);
            if (discount > 0) {
                card.appendChild(quoteLine('Descuento', '-' + formatCOP(discount)));
            }

            var total = document.createElement('div');
            total.className = 'fa-quote-total';
            var totalLabel = document.createElement('span');
            totalLabel.textContent = 'Total estimado';
            var totalValue = document.createElement('span');
            totalValue.textContent = formatCOP(data.total);
            total.appendChild(totalLabel);
            total.appendChild(totalValue);
            card.appendChild(total);

            var puedeContinuar = data.puedeContinuar !== false;
            if (!puedeContinuar) {
                var stock = document.createElement('p');
                stock.className = 'fa-quote-stock';
                stock.textContent = 'No hay stock suficiente para esas fechas. Ajusta las cantidades '
                    + 'o habla con un asesor.';
                card.appendChild(stock);
            } else {
                var note = document.createElement('p');
                note.className = 'fa-quote-note';
                note.textContent = 'La disponibilidad no bloquea el inventario hasta confirmar y pagar. '
                    + 'Máximo 7 días por alquiler.';
                card.appendChild(note);
            }

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';

            if (!puedeContinuar) {
                actions.appendChild(button('Ajustar cantidades', 'fa-btn-ghost', function () {
                    trackAssistantEvent('assistant_quote_adjust');
                    els.input.focus();
                }, ICONS.sliders));
                actions.appendChild(button('Hablar con un asesor', 'fa-btn-wa', function () {
                    abrirWhatsApp('Hola Furent, necesito ayuda con una cotización sin stock suficiente.', 'quote-stock');
                }, ICONS.whatsapp));
            } else if (authenticated) {
                actions.appendChild(button('Reservar ahora', 'fa-btn-primary', function () {
                    trackAssistantEvent('assistant_checkout_click', { total: data.total });
                    prepararReserva(data);
                    goToCheckout(data.checkoutUrl);
                }, ICONS.cart));
                actions.appendChild(button('Enviar por WhatsApp', 'fa-btn-wa', function () {
                    abrirWhatsApp(cotizacionTexto(data), 'quote');
                }, ICONS.whatsapp));
                actions.appendChild(button('Descargar PDF', 'fa-btn-ghost', function () {
                    trackAssistantEvent('assistant_quote_pdf');
                    downloadQuotePdf(data);
                }, ICONS.receipt));
            } else {
                actions.appendChild(button('Continuar por WhatsApp', 'fa-btn-wa', function () {
                    abrirWhatsApp(cotizacionTexto(data), 'quote');
                }, ICONS.whatsapp));
                actions.appendChild(button('Crear cuenta y reservar', 'fa-btn-ghost', function () {
                    trackAssistantEvent('assistant_checkout_click', { total: data.total, via: 'login' });
                    prepararReserva(data);
                    goToCheckout(data.checkoutUrl);
                }, ICONS.userPlus));
            }

            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
            trackAssistantEvent('assistant_quote_view', { total: data.total, dias: data.dias });
        }

        /** Botones de navegación sugeridos por el asistente (catálogo, inspiración, checkout...). */
        function appendLinksCard(data) {
            var links = (data && data.links) || [];
            if (!links.length) {
                return;
            }
            var card = document.createElement('div');
            card.className = 'fa-quote';
            var head = document.createElement('div');
            head.className = 'fa-quote-head';
            var badge = document.createElement('span');
            badge.className = 'fa-quote-ico';
            badge.appendChild(svgIcon(ICONS.range, 16));
            head.appendChild(badge);
            var headText = document.createElement('div');
            headText.style.minWidth = '0';
            var title = document.createElement('h4');
            title.textContent = 'Te dejo el acceso directo';
            headText.appendChild(title);
            head.appendChild(headText);
            card.appendChild(head);

            var row = document.createElement('div');
            row.className = 'fa-links';
            links.forEach(function (link) {
                var a = document.createElement('a');
                a.className = 'fa-btn fa-btn-primary';
                a.href = link.url || '#';
                if (/^https?:/i.test(link.url || '')) {
                    a.target = '_blank';
                    a.rel = 'noopener';
                }
                a.textContent = link.label || 'Ver más';
                row.appendChild(a);
            });
            card.appendChild(row);

            var wrap = document.createElement('div');
            wrap.className = 'fa-row fa-enter';
            wrap.style.width = '100%';
            wrap.appendChild(card);
            els.messages.appendChild(wrap);
            scrollDown();
        }

        /** Descarga la cotización mostrada cuando el backend emite el evento "document". */
        function downloadDocument(data) {
            if (!data || data.tipo !== 'cotizacion' || !lastQuote) {
                appendAssistantBubble('Primero pídele a Furi una cotización y luego la descargo en PDF.'
                    + ' Así tendrás el detalle con precios reales.', true);
                return;
            }
            downloadQuotePdf(lastQuote);
        }

        function downloadQuotePdf(data) {
            var quote = data || lastQuote;
            if (!quote || !quote.items || !quote.items.length) {
                toast('Primero pide una cotización para descargarla.', 'info');
                return;
            }
            fetch(quotePdfUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(quote)
            }).then(function (response) {
                if (!response.ok) {
                    throw new Error('pdf ' + response.status);
                }
                return response.blob();
            }).then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'cotizacion-furent.pdf';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                trackAssistantEvent('assistant_quote_pdf_done');
            }).catch(function () {
                toast('No pude descargar el PDF. Intenta de nuevo en un momento.', 'error');
            });
        }

        /** Agrega la valoración positiva/negativa a una respuesta ya terminada. */
        function attachFeedback(bubble) {
            if (!bubble || bubble._feedbackAttached || !authenticated || !state.conversationId) {
                return;
            }
            if (!(bubble._raw || '').trim()) {
                return;
            }
            bubble._feedbackAttached = true;

            var wrap = document.createElement('div');
            wrap.className = 'fa-feedback';
            var note = document.createElement('span');
            note.className = 'fa-feedback-note';
            note.textContent = '¿Te sirvió esta respuesta?';
            var up = document.createElement('button');
            up.type = 'button';
            up.title = 'Me sirvió';
            up.setAttribute('aria-label', 'Respuesta útil');
            up.appendChild(svgIcon(ICONS.thumbUp, 15));
            var down = document.createElement('button');
            down.type = 'button';
            down.title = 'No me sirvió';
            down.setAttribute('aria-label', 'Respuesta poco útil');
            down.appendChild(svgIcon(ICONS.thumbDown, 15));
            wrap.appendChild(note);
            wrap.appendChild(up);
            wrap.appendChild(down);

            function send(valor, chosen) {
                up.disabled = true;
                down.disabled = true;
                chosen.classList.add('is-on');
                note.textContent = '¡Gracias por tu valoración!';
                fetch(feedbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ conversationId: state.conversationId, valor: valor })
                }).catch(function () { /* silencioso: la valoración no debe romper el chat */ });
            }

            up.addEventListener('click', function () {
                trackAssistantEvent('assistant_feedback', { valor: 'POSITIVO' });
                send('POSITIVO', up);
            });
            down.addEventListener('click', function () {
                trackAssistantEvent('assistant_feedback', { valor: 'NEGATIVO' });
                send('NEGATIVO', down);
            });

            bubble.appendChild(wrap);
            scrollDown();
        }

        function appendEscalationCard(data) {
            var card = document.createElement('div');
            card.className = 'fa-quote';
            var title = document.createElement('h4');
            title.textContent = 'Te conecto con un asesor';
            card.appendChild(title);
            var note = document.createElement('p');
            note.className = 'fa-quote-note';
            note.textContent = 'Puedes continuar la conversación por WhatsApp con el equipo de Furent.';
            card.appendChild(note);

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';
            var url = (data && data.whatsappUrl) || whatsappUrl('Hola Furent, vengo del asistente virtual.');
            actions.appendChild(button('Abrir WhatsApp', 'fa-btn-wa', function () {
                trackAssistantEvent('assistant_whatsapp_click', { origen: 'escalation' });
                window.open(url, '_blank');
            }, ICONS.whatsapp));
            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
        }

        function quoteItem(item) {
            var line = document.createElement('div');
            line.className = 'fa-quote-item';

            if (item.imagen) {
                var thumb = document.createElement('img');
                thumb.className = 'fa-quote-thumb';
                thumb.alt = '';
                thumb.loading = 'lazy';
                thumb.src = item.imagen;
                line.appendChild(thumb);
            }

            var main = document.createElement('div');
            main.className = 'fa-quote-item-main';
            var name = document.createElement('span');
            name.className = 'fa-quote-item-name';
            name.textContent = (item.nombre || 'Producto') + ' ×' + (item.cantidad || 0);
            main.appendChild(name);
            var unit = document.createElement('span');
            unit.className = 'fa-quote-item-unit';
            unit.textContent = formatCOP(item.precioDia) + ' / día';
            main.appendChild(unit);
            line.appendChild(main);

            var sub = document.createElement('span');
            sub.className = 'fa-quote-item-sub';
            sub.textContent = formatCOP(item.subtotal);
            line.appendChild(sub);
            return line;
        }

        function quoteLine(label, value) {
            var line = document.createElement('div');
            line.className = 'fa-quote-item';
            var left = document.createElement('span');
            left.textContent = label;
            var right = document.createElement('span');
            right.textContent = value;
            line.appendChild(left);
            line.appendChild(right);
            return line;
        }

        function button(label, className, onClick, icon) {
            var element = document.createElement('button');
            element.type = 'button';
            element.className = 'fa-btn ' + className;
            if (icon) {
                element.appendChild(svgIcon(icon, 15));
            }
            var span = document.createElement('span');
            span.textContent = label;
            element.appendChild(span);
            element.addEventListener('click', onClick);
            return element;
        }

        /**
         * Iconos SVG creados con nodos reales (nada de HTML crudo). `paths` es la lista de
         * atributos `d` y se trazan en el mismo estilo lineal del resto del widget.
         */
        function svgIcon(paths, size) {
            var ns = 'http://www.w3.org/2000/svg';
            var svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', size || 16);
            svg.setAttribute('height', size || 16);
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.9');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            (paths || []).forEach(function (d) {
                var path = document.createElementNS(ns, 'path');
                path.setAttribute('d', d);
                svg.appendChild(path);
            });
            return svg;
        }

        var ICONS = {
            whatsapp: ['M20.5 11.5a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.6-4.3A8.5 8.5 0 1 1 20.5 11.5Z',
                'M8.8 8.6c.5 2.4 2.2 4.1 4.6 4.6.5.1 1-.3 1-1v-.6l-1.4-.5-.7.6c-.9-.4-1.5-1-1.9-1.9l.6-.7-.5-1.4h-.6c-.7 0-1.1.5-1 1Z'],
            cart: ['M3 4h2l2.3 11.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L20.5 7H6',
                'M9.5 20.5a1 1 0 1 0 0-.01M17.5 20.5a1 1 0 1 0 0-.01'],
            userPlus: ['M15.5 20v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20',
                'M8.75 10.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z',
                'M19 7.5v5M21.5 10h-5'],
            sliders: ['M4 20v-6M4 10V4M12 20v-9M12 7V4M20 20v-4M20 12V4M1.5 14h5M9.5 7h5M17.5 16h5'],
            calendar: ['M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5'],
            clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.5V12l3 1.8'],
            receipt: ['M6.75 3.75h10.5A1.5 1.5 0 0 1 18.75 5.25v13.9l-2.6-1.5-2.6 1.5-2.6-1.5-2.6 1.5V5.25A1.5 1.5 0 0 1 6.75 3.75Z',
                'M9.5 8.5h5M9.5 12h3.5'],
            sparkles: ['M12 3.5l1.7 4.55L18.25 9.75l-4.55 1.7L12 16l-1.7-4.55L5.75 9.75l4.55-1.7L12 3.5Z',
                'M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z'],
            trash: ['M4.5 6.75h15M9.75 6.75V5.25A1.5 1.5 0 0 1 11.25 3.75h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5M6.75 6.75l.75 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l.75-12'],
            tag: ['M20.6 13.4 13.4 20.6a1.9 1.9 0 0 1-2.7 0l-7.3-7.3A1.9 1.9 0 0 1 2.8 12V5.5A2.3 2.3 0 0 1 5.1 3.2H12a1.9 1.9 0 0 1 1.3.6l7.3 7.3a1.9 1.9 0 0 1 0 2.7Z',
                'M7.6 7.6h.01'],
            pin: ['M12 21s6-5.4 6-10a6 6 0 1 0-12 0c0 4.6 6 10 6 10Z',
                'M12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
            users: ['M16 19.5v-1.6a3.6 3.6 0 0 0-3.6-3.6H7.1a3.6 3.6 0 0 0-3.6 3.6v1.6',
                'M9.75 10.9a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z',
                'M20.5 19.5v-1.6a3.6 3.6 0 0 0-2.7-3.5',
                'M15.6 3.9a3.6 3.6 0 0 1 0 7'],
            coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
                'M14.6 9.3a2.7 2.7 0 0 0-2.6-1.4c-1.4 0-2.5.8-2.5 2 0 2.9 5.1 1.4 5.1 4.3 0 1.2-1.1 2-2.6 2a2.7 2.7 0 0 1-2.6-1.4',
                'M12 6.4v11.2'],
            pencil: ['M16.6 3.5a2.1 2.1 0 0 1 3 3L7 19.2l-4 1 1-4Z', 'M13.5 6.5l4 4'],
            chevron: ['m6 9.5 6 6 6-6'],
            chevronLeft: ['m14.5 6-6 6 6 6'],
            chevronRight: ['m9.5 6 6 6-6 6'],
            range: ['M5 12h13', 'm12.5 6.2 5.8 5.8-5.8 5.8'],
            close: ['M6 18 18 6M6 6l12 12'],
            info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 7.5h.01'],
            bulb: ['M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.6.5 1 1.2 1.1 2v.6h4.4v-.6c.1-.8.5-1.5 1.1-2A5.5 5.5 0 0 0 12 3.5Z',
                'M10 19h4', 'M10.6 21.5h2.8'],
            alert: ['M12 3.6 21.6 20.4H2.4Z', 'M12 10v4.2', 'M12 17.3h.01'],
            check: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'm8.4 12.2 2.5 2.5 4.7-5.1'],
            rings: ['M9 15.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M15 15.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z'],
            cake: ['M4.5 20.25h15', 'M4.5 20.25V12A1.5 1.5 0 0 1 6 10.5h12a1.5 1.5 0 0 1 1.5 1.5v8.25',
                'M4.5 16.5h15', 'M12 10.5V7.5', 'M8.25 10.5V8.25', 'M15.75 10.5V8.25'],
            briefcase: ['M3.75 8.25h16.5A1.5 1.5 0 0 1 21.75 9.75v8.25a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V9.75a1.5 1.5 0 0 1 1.5-1.5Z',
                'M8.25 8.25V6.75A2.25 2.25 0 0 1 10.5 4.5h3a2.25 2.25 0 0 1 2.25 2.25v1.5', 'M2.25 13.5h19.5'],
            cap: ['M12 4.5 2.25 9 12 13.5 21.75 9Z', 'M6.75 11.25v4c0 1.1 2.35 2.25 5.25 2.25s5.25-1.15 5.25-2.25v-4', 'M21.75 9v5.25'],
            heart: ['M12 20.4 4.9 13.3a4.6 4.6 0 1 1 6.5-6.5l.6.6.6-.6a4.6 4.6 0 1 1 6.5 6.5Z'],
            diamond: ['M6.3 3.75h11.4l2.55 4.5L12 20.25 3.75 8.25Z', 'M3.75 8.25h16.5',
                'M9.3 3.75 7.5 8.25 12 20.25l4.5-12-1.8-4.5'],
            bolt: ['M13.5 3 5.5 13.5h5l-1 7.5 8-10.5h-5Z'],
            leaf: ['M4.5 19.5C4.5 10.5 10.5 4.5 19.5 4.5c0 9-6 15-15 15Z', 'M4.5 19.5 13 11'],
            minimal: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M8.25 12h7.5'],
            lock: ['M6.75 10.5h10.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H6.75a1.5 1.5 0 0 1-1.5-1.5V12a1.5 1.5 0 0 1 1.5-1.5Z',
                'M8.25 10.5V8.25a3.75 3.75 0 0 1 7.5 0v2.25'],
            user: ['M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.9 20.5a7.1 7.1 0 0 1 14.2 0'],
            thumbUp: ['M7 10v10H4.5A1.5 1.5 0 0 1 3 18.5v-7A1.5 1.5 0 0 1 4.5 10H7Z',
                'M7 10l3.2-6.4A1.6 1.6 0 0 1 11.7 3h.3a2.3 2.3 0 0 1 2.3 2.3V9h4.1a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 18 20H7'],
            thumbDown: ['M7 14V4H4.5A1.5 1.5 0 0 0 3 5.5v7A1.5 1.5 0 0 0 4.5 14H7Z',
                'M7 14l3.2 6.4A1.6 1.6 0 0 0 11.7 21h.3a2.3 2.3 0 0 0 2.3-2.3V15h4.1a2 2 0 0 0 2-2.4l-1.4-7A2 2 0 0 0 18 4H7'],
            eraser: ['M4 20h16',
                'M13.5 5.5 8 11l3.5 3.5 5.5-5.5a2.47 2.47 0 0 0-3.5-3.5Z',
                'm9.5 12.5-3 3a1.5 1.5 0 0 0 0 2.1l.9.9a1.5 1.5 0 0 0 2.1 0l3-3']
        };

        function rangoFechas(data) {
            if (!data || !data.fechaInicio || !data.fechaFin) {
                return '';
            }
            var rango = fmtFecha(data.fechaInicio) + ' – ' + fmtFecha(data.fechaFin);
            if (typeof data.dias === 'number') {
                rango += ' · ' + data.dias + (data.dias === 1 ? ' día' : ' días');
            }
            return rango;
        }

        // ───────────────────────── Panel lateral ─────────────────────────

        var VIEWS = {
            form: function () { return els.viewForm; },
            detalles: function () { return els.viewDetalles; },
            fechas: function () { return els.viewFechas; },
            bolsa: function () { return els.viewBolsa; },
            recomendacion: function () { return els.viewReco; },
            alquiler: function () { return els.viewAlquiler; },
            comparar: function () { return els.viewComparar; },
            resenas: function () { return els.viewResenas; },
            inspiracion: function () { return els.viewInspiracion; },
            direcciones: function () { return els.viewDirecciones; },
            notificaciones: function () { return els.viewNotificaciones; },
            plan: function () { return els.viewPlan; },
            mesas: function () { return els.viewMesas; },
            presupuesto: function () { return els.viewPresupuesto; }
        };

        var SIDE_TITLES = {
            form: 'Cuéntame de tu evento',
            detalles: 'Detalles del alquiler',
            fechas: 'Fechas del alquiler',
            bolsa: 'Tu bolsa',
            recomendacion: 'Recomendación',
            alquiler: 'Tu alquiler',
            comparar: 'Comparar mobiliario',
            resenas: 'Reseñas',
            inspiracion: 'Inspiración',
            direcciones: 'Mis direcciones',
            notificaciones: 'Notificaciones',
            plan: 'Plan del evento',
            mesas: 'Distribución de mesas',
            presupuesto: 'Presupuesto'
        };

        function openSidePanel(vista, data) {
            if (!els.side || !VIEWS[vista]) {
                return;
            }
            destroyFormFp();
            sideVista = vista;
            els.side.hidden = false;
            els.panel.classList.add('fa-wide');
            Object.keys(VIEWS).forEach(function (key) {
                var el = VIEWS[key]();
                if (el) {
                    el.hidden = key !== vista;
                }
            });
            els.sideTitle.textContent = (data && data.titulo) || SIDE_TITLES[vista] || 'Detalle';

            if (vista === 'fechas') {
                if (authenticated) {
                    loadReservedDays();
                }
                if (datesCalendar) {
                    datesCalendar.setRange(pendingStart, pendingEnd);
                }
                syncTimeQuick();
                updateDatesUI();
            } else if (vista === 'bolsa') {
                renderBagPanel(data && data.items);
            } else if (vista === 'form') {
                renderFormPanel(data && data.fields ? data : defaultFormData());
            } else if (vista === 'detalles') {
                renderDetallesPanel(data && data.fields ? data : defaultDetallesData());
            } else if (vista === 'recomendacion') {
                renderRecommendation(data || {});
            } else if (vista === 'alquiler') {
                renderReservation(data || {});
            } else if (vista === 'comparar') {
                renderComparar(data || {});
            } else if (vista === 'resenas') {
                renderReviews(data || {});
            } else if (vista === 'inspiracion') {
                renderInspiracion(data || {});
            } else if (vista === 'direcciones') {
                renderDirecciones(data || {});
            } else if (vista === 'notificaciones') {
                renderNotificaciones(data || {});
            } else if (vista === 'plan') {
                renderPlan(data || {});
            } else if (vista === 'mesas') {
                renderMesas(data || {});
            } else if (vista === 'presupuesto') {
                renderPresupuesto(data || {});
            }
        }

        function closeSidePanel() {
            if (!els.side) {
                return;
            }
            destroyFormFp();
            closeOpenSelect();
            els.side.hidden = true;
            els.panel.classList.remove('fa-wide');
            sideVista = null;
        }

        // ── Vistas: descubrimiento, plan y cuenta ──

        function panelIntro(view, texto) {
            var p = document.createElement('p');
            p.className = 'fa-panel-sub';
            p.textContent = texto;
            view.appendChild(p);
        }

        function panelEmpty(view, texto) {
            var p = document.createElement('p');
            p.className = 'fa-bag-empty';
            p.textContent = texto;
            view.appendChild(p);
        }

        function stars(rating) {
            var full = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
            var out = '';
            for (var i = 0; i < 5; i++) {
                out += i < full ? '★' : '☆';
            }
            return out;
        }

        /** Fila genérica del panel: imagen, título, metadatos, etiquetas, atributos y precio. */
        function panelItem(opts) {
            var item = document.createElement('div');
            item.className = 'fa-item';

            if (opts.imagen) {
                var img = document.createElement('img');
                img.className = 'fa-item-img';
                img.loading = 'lazy';
                img.alt = '';
                img.src = opts.imagen;
                item.appendChild(img);
            }

            var main = document.createElement('div');
            main.className = 'fa-item-main';

            var name = document.createElement('p');
            name.className = 'fa-item-name';
            name.textContent = opts.nombre || '';
            main.appendChild(name);

            if (opts.rating != null) {
                var rating = document.createElement('p');
                rating.className = 'fa-item-meta';
                var star = document.createElement('span');
                star.className = 'fa-stars';
                star.textContent = stars(opts.rating);
                rating.appendChild(star);
                if (opts.ratingTexto) {
                    rating.appendChild(document.createTextNode(' ' + opts.ratingTexto));
                }
                main.appendChild(rating);
            }

            if (opts.meta) {
                var meta = document.createElement('p');
                meta.className = 'fa-item-meta';
                meta.textContent = opts.meta;
                main.appendChild(meta);
            }

            if (opts.texto) {
                var texto = document.createElement('p');
                texto.className = 'fa-item-meta';
                texto.style.lineHeight = '1.5';
                texto.textContent = opts.texto;
                main.appendChild(texto);
            }

            if (opts.extra) {
                var extra = document.createElement('p');
                extra.className = 'fa-item-meta';
                extra.style.lineHeight = '1.5';
                extra.style.paddingLeft = '8px';
                extra.style.borderLeft = '2px solid var(--fa-line-2)';
                extra.textContent = 'Respuesta de Furent: ' + opts.extra;
                main.appendChild(extra);
            }

            (opts.attrs || []).forEach(function (attr) {
                var row = document.createElement('div');
                row.className = 'fa-cmp-attr';
                var label = document.createElement('span');
                label.textContent = attr.label;
                var value = document.createElement('span');
                value.textContent = attr.value;
                row.appendChild(label);
                row.appendChild(value);
                main.appendChild(row);
            });

            if (opts.tags && opts.tags.length) {
                var tags = document.createElement('div');
                tags.className = 'fa-tags';
                opts.tags.forEach(function (t) {
                    var tag = document.createElement(t.href ? 'a' : 'span');
                    tag.className = 'fa-tag' + (t.good ? ' is-good' : '');
                    tag.textContent = t.text;
                    if (t.href) {
                        tag.href = t.href;
                    }
                    tags.appendChild(tag);
                });
                main.appendChild(tags);
            }

            item.appendChild(main);

            if (opts.precio != null) {
                var price = document.createElement('span');
                price.className = 'fa-item-price';
                price.textContent = opts.precio;
                item.appendChild(price);
            }
            return item;
        }

        function renderComparar(data) {
            var view = els.viewComparar;
            if (!view) {
                return;
            }
            view.textContent = '';
            var productos = data.productos || [];
            if (!productos.length) {
                panelEmpty(view, 'No hay productos para comparar.');
                return;
            }
            panelIntro(view, 'Compara precio, valoración y disponibilidad antes de elegir.');
            var list = document.createElement('div');
            list.className = 'fa-list';
            productos.forEach(function (p) {
                var tags = [];
                if (p.mejorPrecio) {
                    tags.push({ text: 'Mejor precio', good: true });
                }
                if (p.mejorCalificacion) {
                    tags.push({ text: 'Mejor valorado', good: true });
                }
                var attrs = [
                    { label: 'Stock', value: String(p.stock == null ? '—' : p.stock) },
                    { label: 'Material', value: p.material || '—' },
                    { label: 'Medidas', value: p.dimensiones || '—' },
                    { label: 'Color', value: p.color || '—' }
                ];
                list.appendChild(panelItem({
                    imagen: p.imagen,
                    nombre: p.nombre,
                    meta: p.categoria || '',
                    rating: p.calificacion,
                    ratingTexto: p.cantidadResenas ? '(' + p.cantidadResenas + ')' : '',
                    attrs: attrs,
                    tags: tags,
                    precio: formatCOP(p.precioDia) + '/día'
                }));
            });
            view.appendChild(list);
        }

        function renderReviews(data) {
            var view = els.viewResenas;
            if (!view) {
                return;
            }
            view.textContent = '';
            var producto = data.producto || {};
            if (producto.nombre) {
                view.appendChild(panelItem({
                    imagen: producto.imagen,
                    nombre: producto.nombre,
                    meta: producto.categoria || 'Producto',
                    rating: producto.calificacion,
                    ratingTexto: (producto.cantidadResenas || 0) + ' reseñas',
                    precio: producto.precioDia != null ? formatCOP(producto.precioDia) + '/día' : null
                }));
            }
            var resenas = data.resenas || [];
            if (!resenas.length) {
                panelEmpty(view, 'Este producto todavía no tiene reseñas.');
                return;
            }
            var list = document.createElement('div');
            list.className = 'fa-list';
            list.style.marginTop = '12px';
            resenas.forEach(function (r) {
                var tags = [];
                if (r.respuesta) {
                    tags.push({ text: 'Respondida por Furent', good: true });
                }
                list.appendChild(panelItem({
                    nombre: r.usuario || 'Cliente Furent',
                    rating: r.rating,
                    meta: r.fecha || '',
                    texto: r.comentario || '',
                    tags: tags,
                    extra: r.respuesta ? r.respuesta : null
                }));
            });
            view.appendChild(list);
        }

        function renderInspiracion(data) {
            var view = els.viewInspiracion;
            if (!view) {
                return;
            }
            view.textContent = '';
            var imagenes = data.imagenes || [];
            if (!imagenes.length) {
                panelEmpty(view, 'No hay imágenes de inspiración con esos filtros.');
                return;
            }
            var list = document.createElement('div');
            list.className = 'fa-list';
            imagenes.forEach(function (img) {
                var card = document.createElement('div');
                card.className = 'fa-item';
                card.style.flexDirection = 'column';
                if (img.imagen) {
                    var foto = document.createElement('img');
                    foto.className = 'fa-insp-img';
                    foto.loading = 'lazy';
                    foto.alt = img.titulo || 'Inspiración';
                    foto.src = img.imagen;
                    card.appendChild(foto);
                }
                var main = document.createElement('div');
                main.className = 'fa-item-main';
                var title = document.createElement('p');
                title.className = 'fa-item-name';
                title.textContent = img.titulo || 'Inspiración';
                main.appendChild(title);
                var bits = [];
                if (img.tipoEvento) { bits.push(img.tipoEvento); }
                if (img.ubicacion) { bits.push(img.ubicacion); }
                if (img.invitados) { bits.push(img.invitados + ' invitados'); }
                if (bits.length) {
                    var meta = document.createElement('p');
                    meta.className = 'fa-item-meta';
                    meta.textContent = bits.join(' · ');
                    main.appendChild(meta);
                }
                var pins = img.pins || [];
                if (pins.length) {
                    var tags = document.createElement('div');
                    tags.className = 'fa-tags';
                    pins.forEach(function (pin) {
                        if (!pin.nombre) { return; }
                        var tag = document.createElement('a');
                        tag.className = 'fa-tag';
                        tag.href = pin.productoId ? ('/producto/' + encodeURIComponent(pin.productoId)) : '#';
                        tag.textContent = pin.nombre + (pin.precioDia ? ' · ' + formatCOP(pin.precioDia) : '');
                        tags.appendChild(tag);
                    });
                    main.appendChild(tags);
                }
                card.appendChild(main);
                list.appendChild(card);
            });
            view.appendChild(list);
        }

        function renderDirecciones(data) {
            var view = els.viewDirecciones;
            if (!view) {
                return;
            }
            view.textContent = '';
            var direcciones = data.direcciones || [];
            if (!direcciones.length) {
                panelEmpty(view, 'Aún no tienes direcciones guardadas. Puedes agregarlas en tu perfil.');
                return;
            }
            var list = document.createElement('div');
            list.className = 'fa-list';
            direcciones.forEach(function (d) {
                var tags = [];
                if (d.predeterminada) {
                    tags.push({ text: 'Predeterminada', good: true });
                }
                var partes = [d.ciudad, d.departamento, d.pais].filter(Boolean);
                list.appendChild(panelItem({
                    nombre: d.alias || 'Dirección',
                    meta: d.direccion || '',
                    texto: partes.join(', ') + (d.codigoPostal ? ' · CP ' + d.codigoPostal : ''),
                    tags: tags
                }));
            });
            view.appendChild(list);
        }

        function renderNotificaciones(data) {
            var view = els.viewNotificaciones;
            if (!view) {
                return;
            }
            view.textContent = '';
            var total = Number(data.noLeidas || 0);
            if (data.notificaciones && data.notificaciones.length) {
                panelIntro(view, total > 0
                    ? ('Tienes ' + total + (total === 1 ? ' notificación sin leer.' : ' notificaciones sin leer.'))
                    : 'Estás al día.');
            }
            var lista = data.notificaciones || [];
            if (!lista.length) {
                panelEmpty(view, 'No tienes notificaciones por ahora.');
                return;
            }
            var list = document.createElement('div');
            list.className = 'fa-list';
            lista.forEach(function (n) {
                var tags = [];
                if (n.tipo) {
                    tags.push({ text: n.tipo });
                }
                if (!n.leida) {
                    tags.push({ text: 'Nueva', good: true });
                }
                var item = panelItem({
                    nombre: n.titulo || 'Notificación',
                    meta: n.fecha || '',
                    texto: n.mensaje || '',
                    tags: tags
                });
                if (n.link) {
                    item.style.cursor = 'pointer';
                    item.addEventListener('click', function () { window.location.href = n.link; });
                }
                list.appendChild(item);
            });
            view.appendChild(list);
        }

        function renderMesas(data) {
            var view = els.viewMesas;
            if (!view) {
                return;
            }
            view.textContent = '';
            var totalMesas = Number(data.totalMesas || 0);
            var totalSillas = Number(data.totalSillas || 0);
            panelIntro(view, totalMesas + (totalMesas === 1 ? ' mesa' : ' mesas') + ' y '
                + totalSillas + (totalSillas === 1 ? ' silla' : ' sillas') + ' para tu evento.');
            var grid = document.createElement('div');
            grid.className = 'fa-grid';
            (data.detalle || []).forEach(function (mesa) {
                var celda = document.createElement('div');
                celda.className = 'fa-mesa';
                var num = document.createElement('div');
                num.className = 'fa-mesa-num';
                num.textContent = 'Mesa ' + mesa.numero;
                var cap = document.createElement('div');
                cap.className = 'fa-mesa-cap';
                cap.textContent = mesa.personas + ' personas';
                celda.appendChild(num);
                celda.appendChild(cap);
                grid.appendChild(celda);
            });
            view.appendChild(grid);
        }

        function renderPresupuesto(data) {
            var view = els.viewPresupuesto;
            if (!view) {
                return;
            }
            view.textContent = '';
            (data.niveles || []).forEach(function (nivel) {
                var card = document.createElement('div');
                card.className = 'fa-level' + (nivel.nombre === 'Recomendado' ? ' is-main' : '');
                var top = document.createElement('div');
                top.className = 'fa-level-top';
                var name = document.createElement('span');
                name.className = 'fa-level-name';
                name.textContent = nivel.nombre || '';
                var total = document.createElement('span');
                total.className = 'fa-level-total';
                total.textContent = formatCOP(nivel.total);
                top.appendChild(name);
                top.appendChild(total);
                card.appendChild(top);
                var desc = document.createElement('p');
                desc.className = 'fa-level-desc';
                desc.textContent = nivel.descripcion || '';
                card.appendChild(desc);
                view.appendChild(card);
            });

            var categorias = data.categorias || [];
            if (categorias.length) {
                var title = document.createElement('h4');
                title.className = 'fa-panel-title';
                title.textContent = 'Por categoría';
                view.appendChild(title);
                var max = categorias.reduce(function (acc, c) { return Math.max(acc, Number(c.total) || 0); }, 0) || 1;
                categorias.forEach(function (c) {
                    var row = document.createElement('div');
                    row.style.marginBottom = '8px';
                    var head = document.createElement('div');
                    head.className = 'fa-cmp-attr';
                    var label = document.createElement('span');
                    label.textContent = c.categoria || 'Otros';
                    var value = document.createElement('span');
                    value.textContent = formatCOP(c.total);
                    head.appendChild(label);
                    head.appendChild(value);
                    row.appendChild(head);
                    var bar = document.createElement('div');
                    bar.className = 'fa-bar';
                    var fill = document.createElement('span');
                    fill.style.width = Math.round((Number(c.total) || 0) / max * 100) + '%';
                    bar.appendChild(fill);
                    row.appendChild(bar);
                    view.appendChild(row);
                });
            }
        }

        function renderPlan(data) {
            var view = els.viewPlan;
            if (!view) {
                return;
            }
            view.textContent = '';
            var resumen = data.resumen || {};
            var bits = [];
            if (resumen.invitados) { bits.push(resumen.invitados + ' invitados'); }
            if (resumen.dias) { bits.push(resumen.dias + (resumen.dias === 1 ? ' día' : ' días')); }
            if (resumen.tipoEvento) { bits.push(resumen.tipoEvento); }
            if (resumen.estilo) { bits.push('estilo ' + resumen.estilo); }
            if (resumen.fechaInicio) {
                bits.push(fmtFecha(resumen.fechaInicio) + (resumen.fechaFin ? ' al ' + fmtFecha(resumen.fechaFin) : ''));
            }
            panelIntro(view, bits.length ? bits.join(' · ') : 'Plan sugerido para tu evento.');
            if (resumen.totalEstimado != null) {
                var total = document.createElement('p');
                total.className = 'fa-reco-budget';
                total.textContent = 'Total estimado: ' + formatCOP(resumen.totalEstimado);
                view.appendChild(total);
            }

            var mobiliario = data.mobiliario || [];
            if (mobiliario.length) {
                var h1 = document.createElement('h4');
                h1.className = 'fa-panel-title';
                h1.textContent = 'Mobiliario';
                view.appendChild(h1);
                var list = document.createElement('div');
                list.className = 'fa-list';
                mobiliario.forEach(function (m) {
                    list.appendChild(panelItem({
                        imagen: m.imagen,
                        nombre: m.nombre,
                        meta: (m.categoria || '') + ' · ' + m.cantidad + ' × ' + formatCOP(m.precioDia) + '/día',
                        precio: formatCOP(m.subtotal)
                    }));
                });
                view.appendChild(list);
            }

            var categorias = data.categorias || [];
            if (categorias.length) {
                var h2 = document.createElement('h4');
                h2.className = 'fa-panel-title';
                h2.textContent = 'Presupuesto por categoría';
                h2.style.marginTop = '14px';
                view.appendChild(h2);
                var max = categorias.reduce(function (acc, c) { return Math.max(acc, Number(c.total) || 0); }, 0) || 1;
                categorias.forEach(function (c) {
                    var row = document.createElement('div');
                    row.style.marginBottom = '8px';
                    var head = document.createElement('div');
                    head.className = 'fa-cmp-attr';
                    var label = document.createElement('span');
                    label.textContent = c.categoria || 'Otros';
                    var value = document.createElement('span');
                    value.textContent = formatCOP(c.total);
                    head.appendChild(label);
                    head.appendChild(value);
                    row.appendChild(head);
                    var bar = document.createElement('div');
                    bar.className = 'fa-bar';
                    var fill = document.createElement('span');
                    fill.style.width = Math.round((Number(c.total) || 0) / max * 100) + '%';
                    bar.appendChild(fill);
                    row.appendChild(bar);
                    view.appendChild(row);
                });
            }

            var mesas = data.mesas || {};
            if (mesas.totalMesas) {
                var h3 = document.createElement('h4');
                h3.className = 'fa-panel-title';
                h3.textContent = 'Mesas';
                h3.style.marginTop = '14px';
                view.appendChild(h3);
                panelIntro(view, mesas.totalMesas + ' mesas · ' + mesas.totalSillas + ' sillas');
            }

            var checklist = data.checklist || [];
            if (checklist.length) {
                var h4 = document.createElement('h4');
                h4.className = 'fa-panel-title';
                h4.textContent = 'Pasos clave';
                h4.style.marginTop = '14px';
                view.appendChild(h4);
                var ul = document.createElement('ul');
                ul.className = 'fa-plan-list';
                checklist.forEach(function (paso) {
                    var li = document.createElement('li');
                    var strong = document.createElement('strong');
                    strong.textContent = paso.titulo || '';
                    li.appendChild(strong);
                    if (paso.fecha) {
                        li.appendChild(document.createTextNode(' · ' + fmtFecha(paso.fecha)));
                    }
                    if (paso.detalle) {
                        li.appendChild(document.createTextNode(' — ' + paso.detalle));
                    }
                    ul.appendChild(li);
                });
                view.appendChild(ul);
            }
        }

        // ── Vista: formulario del evento ──

        function defaultFormData() {
            return {
                vista: 'form',
                titulo: 'Cuéntame de tu evento',
                descripcion: 'Con estos datos te recomiendo el mobiliario ideal.',
                submitLabel: 'Recomendar mobiliario',
                fields: [
                    { name: 'tipoEvento', label: 'Tipo de evento', type: 'select', required: true, options: [
                        { value: 'boda', label: 'Boda' }, { value: 'cumpleanos', label: 'Cumpleaños' },
                        { value: 'corporativo', label: 'Evento corporativo' }, { value: 'grado', label: 'Grado' },
                        { value: 'baby_shower', label: 'Baby shower' }, { value: 'otro', label: 'Otro' }] },
                    { name: 'invitados', label: 'Número de personas', type: 'number', required: true, placeholder: '120' },
                    { name: 'estilo', label: 'Estilo', type: 'select', options: [
                        { value: 'elegante', label: 'Elegante' }, { value: 'moderno', label: 'Moderno' },
                        { value: 'rustico', label: 'Rústico' }, { value: 'minimalista', label: 'Minimalista' }] },
                    { name: 'presupuesto', label: 'Presupuesto aproximado (COP)', type: 'number', placeholder: '3000000' },
                    { name: 'fechaInicio', label: 'Desde', type: 'date' },
                    { name: 'fechaFin', label: 'Hasta', type: 'date' },
                    { name: 'horaEvento', label: 'Hora del evento', type: 'time', required: true },
                    { name: 'nota', label: 'Nota (opcional)', type: 'textarea', placeholder: 'Ej: colores, temática, requerimientos especiales' }
                ]
            };
        }

        function renderFormPanel(data) {
            var view = els.viewForm;
            if (!view) {
                return;
            }
            destroyFormFp();
            closeOpenSelect();
            view.textContent = '';
            var form = document.createElement('form');
            form.className = 'fa-form';
            form.setAttribute('novalidate', 'novalidate');

            if (data.descripcion) {
                var desc = document.createElement('p');
                desc.className = 'fa-form-desc';
                desc.textContent = data.descripcion;
                form.appendChild(desc);
            }

            var inputs = {};
            var dateFields = [];
            var step = 0;
            (data.fields || []).forEach(function (field) {
                if (field.type === 'date') {
                    dateFields.push(field);
                    return;
                }
                var wrap = buildFormControl(field, inputs);
                if (wrap) {
                    wrap.style.animationDelay = (step * 45) + 'ms';
                    step++;
                    form.appendChild(wrap);
                }
            });
            if (dateFields.length) {
                var range = buildDateRangeField(dateFields, inputs);
                range.style.animationDelay = (step * 45) + 'ms';
                form.appendChild(range);
            }

            var error = document.createElement('p');
            error.className = 'fa-form-error';
            error.hidden = true;
            form.appendChild(error);

            var submit = document.createElement('button');
            submit.type = 'submit';
            submit.className = 'fa-btn fa-btn-primary';
            submit.textContent = data.submitLabel || 'Enviar';
            form.appendChild(submit);

            form.addEventListener('submit', function (event) {
                event.preventDefault();
                var lines = [];
                var missing = null;
                (data.fields || []).forEach(function (field) {
                    var value = (inputs[field.name] && inputs[field.name].value || '').trim();
                    if (field.required && !value && !missing) {
                        missing = field.label || field.name;
                    }
                    if (value) {
                        lines.push('- ' + (field.label || field.name) + ': ' + value);
                    }
                });
                if (missing) {
                    error.textContent = 'Completa: ' + missing + '.';
                    error.hidden = false;
                    return;
                }
                if (lines.length === 0) {
                    error.textContent = 'Completa al menos un dato.';
                    error.hidden = false;
                    return;
                }
                closeSidePanel();
                sendUserMessage((data.submitPrefix || 'Datos de mi evento:') + '\n' + lines.join('\n'));
            });

            view.appendChild(form);
        }

        // ── Vista: detalles del alquiler (mismos campos que el checkout) ──

        var DETALLES_HORA_MIN = '08:00';
        var DETALLES_HORA_MAX = '20:00';
        var DETALLES_MAX_DIAS = 7;

        function defaultDetallesData() {
            // Rescata lo que el usuario ya dio antes (en el asistente o en un intento previo de
            // checkout) para que el formulario no arranque en blanco.
            var saved = {};
            var dates = {};
            try { saved = JSON.parse(localStorage.getItem('furent_event_details') || '{}') || {}; } catch (e) { saved = {}; }
            try { dates = JSON.parse(localStorage.getItem('furent_selected_dates') || '{}') || {}; } catch (e) { dates = {}; }
            if (!dates.start && pendingStart) { dates.start = pendingStart; }
            if (!dates.end && pendingEnd) { dates.end = pendingEnd; }
            return {
                vista: 'detalles',
                titulo: 'Detalles del alquiler',
                descripcion: 'Revisa y completa los datos de tu evento; te los dejo listos en el checkout.',
                submitLabel: 'Confirmar y reservar',
                fields: [
                    { name: 'tipoEvento', label: 'Tipo de evento', type: 'select', required: true,
                        value: saved.tipoEvento || '', options: [
                        { value: 'Boda', label: 'Boda' }, { value: 'Corporativo', label: 'Corporativo' },
                        { value: 'Cumpleaños', label: 'Cumpleaños' }, { value: 'Graduación', label: 'Graduación' },
                        { value: 'Feria', label: 'Feria' }, { value: 'Otro', label: 'Otro' }] },
                    { name: 'invitados', label: 'Número de invitados', type: 'number', required: true,
                        placeholder: '120', value: saved.invitados || '' },
                    { name: 'fechaInicio', label: 'Desde', type: 'date', required: true, value: dates.start || '' },
                    { name: 'fechaFin', label: 'Hasta', type: 'date', required: true, value: dates.end || '' },
                    { name: 'horaEntrega', label: 'Hora de entrega', type: 'time', required: true,
                        min: DETALLES_HORA_MIN, max: DETALLES_HORA_MAX, value: saved.horaEntrega || '09:00' },
                    { name: 'direccion', label: 'Dirección del evento', type: 'text', required: true,
                        placeholder: 'Calle, número, ciudad...', value: saved.direccion || '' },
                    { name: 'notas', label: 'Notas (opcional)', type: 'textarea',
                        placeholder: 'Accesos, requerimientos especiales...', value: saved.notas || '' }
                ]
            };
        }

        /** Valida los datos del alquiler con las mismas reglas del checkout. */
        function validarDetalles(v) {
            var errores = [];
            var avisos = [];
            if (!v.tipoEvento) {
                errores.push('Selecciona el tipo de evento.');
            }
            var invitados = parseInt(v.invitados, 10);
            if (!v.invitados || isNaN(invitados) || invitados < 1) {
                errores.push('Indica cuántos invitados esperas.');
            }
            var dias = (v.fechaInicio && v.fechaFin) ? diasEntre(v.fechaInicio, v.fechaFin) : 0;
            if (!v.fechaInicio || !v.fechaFin) {
                errores.push('Elige el rango de fechas del alquiler.');
            } else if (dias < 1) {
                errores.push('La fecha final no puede ser antes de la inicial.');
            } else if (dias > DETALLES_MAX_DIAS) {
                errores.push('El alquiler es de máximo ' + DETALLES_MAX_DIAS + ' días.');
            } else if (v.fechaInicio < todayIso()) {
                errores.push('La fecha de inicio ya pasó. Elige una fecha desde hoy.');
            }
            if (!v.horaEntrega) {
                errores.push('Indica la hora de entrega.');
            } else if (v.horaEntrega < DETALLES_HORA_MIN || v.horaEntrega > DETALLES_HORA_MAX) {
                avisos.push('La entrega ideal es entre 8:00 a.m. y 8:00 p.m. Fuera de ese horario, un asesor te contacta.');
            }
            if (!v.direccion) {
                errores.push('Escribe la dirección del evento.');
            }
            return { errores: errores, avisos: avisos };
        }

        function renderDetallesPanel(data) {
            var view = els.viewDetalles;
            if (!view) {
                return;
            }
            destroyFormFp();
            closeOpenSelect();
            view.textContent = '';

            var fields = data.fields || [];
            // El asistente nos dio estos valores: se recuerdan para que el checkout los recupere
            // aunque el usuario no llegue a enviar el formulario.
            var conocido = {};
            fields.forEach(function (f) {
                if (f && f.value != null && f.value !== '') {
                    conocido[f.name] = f.value;
                }
            });
            persistirDatosEvento(conocido);
            var inputs = {};

            var form = document.createElement('form');
            form.className = 'fa-form';
            form.setAttribute('novalidate', 'novalidate');

            if (data.descripcion) {
                var desc = document.createElement('p');
                desc.className = 'fa-form-desc';
                desc.textContent = data.descripcion;
                form.appendChild(desc);
            }

            // Checklist de lo que falta: se va marcando al completar cada dato.
            var check = document.createElement('div');
            check.className = 'fa-checklist';
            form.appendChild(check);

            function collect() {
                var values = {};
                fields.forEach(function (field) {
                    var el = inputs[field.name];
                    values[field.name] = el ? String(el.value || '').trim() : '';
                });
                return values;
            }

            function refrescarChecklist() {
                var v = collect();
                check.textContent = '';
                [
                    { ok: !!v.tipoEvento, label: 'Tipo de evento' },
                    { ok: !!v.invitados, label: 'Invitados' },
                    { ok: !!(v.fechaInicio && v.fechaFin), label: 'Fechas' },
                    { ok: !!v.horaEntrega, label: 'Hora de entrega' },
                    { ok: !!v.direccion, label: 'Dirección' }
                ].forEach(function (p) {
                    var row = document.createElement('span');
                    row.className = 'fa-check-item' + (p.ok ? ' done' : '');
                    row.appendChild(svgIcon(p.ok ? ICONS.check : ICONS.minimal, 13));
                    var txt = document.createElement('span');
                    txt.textContent = p.label;
                    row.appendChild(txt);
                    check.appendChild(row);
                });
            }

            var dateFields = [];
            var step = 0;
            fields.forEach(function (field) {
                if (field.type === 'date') {
                    dateFields.push(field);
                    return;
                }
                var wrap = buildFormControl(field, inputs);
                if (wrap) {
                    wrap.style.animationDelay = (step * 45) + 'ms';
                    step++;
                    form.appendChild(wrap);
                }
            });
            if (dateFields.length) {
                var range = buildDateRangeField(dateFields, inputs);
                range.style.animationDelay = (step * 45) + 'ms';
                form.appendChild(range);
            }

            Object.keys(inputs).forEach(function (name) {
                inputs[name].addEventListener('input', refrescarChecklist);
                inputs[name].addEventListener('change', refrescarChecklist);
            });
            refrescarChecklist();

            var error = document.createElement('p');
            error.className = 'fa-form-error';
            error.hidden = true;
            form.appendChild(error);

            var submit = document.createElement('button');
            submit.type = 'submit';
            submit.className = 'fa-btn fa-btn-primary';
            submit.textContent = data.submitLabel || 'Confirmar y reservar';
            form.appendChild(submit);

            form.addEventListener('submit', function (event) {
                event.preventDefault();
                var v = collect();
                var res = validarDetalles(v);
                if (res.errores.length) {
                    error.textContent = res.errores[0];
                    error.hidden = false;
                    return;
                }
                guardarDetalles(v, res.avisos);
            });

            view.appendChild(form);
        }

        /** Guarda los datos para el checkout y muestra el resumen con el pase. */
        function guardarDetalles(v, avisos) {
            var detalles = {
                tipoEvento: v.tipoEvento,
                invitados: parseInt(v.invitados, 10) || 0,
                direccion: v.direccion,
                horaEntrega: v.horaEntrega,
                notas: v.notas || ''
            };
            try {
                localStorage.setItem('furent_event_details', JSON.stringify(detalles));
                if (v.fechaInicio && v.fechaFin) {
                    localStorage.setItem('furent_selected_dates', JSON.stringify({
                        start: v.fechaInicio, end: v.fechaFin
                    }));
                }
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
            closeSidePanel();
            appendDetallesResumen(v, avisos);
        }

        /** Resumen ordenado en el chat con el siguiente paso hacia el checkout. */
        function appendDetallesResumen(v, avisos) {
            var card = document.createElement('div');
            card.className = 'fa-quote';
            var head = document.createElement('div');
            head.className = 'fa-quote-head';
            var ico = document.createElement('span');
            ico.className = 'fa-quote-ico';
            ico.appendChild(svgIcon(ICONS.check, 16));
            var title = document.createElement('h4');
            title.textContent = 'Detalles del alquiler listos';
            head.appendChild(ico);
            head.appendChild(title);
            card.appendChild(head);

            if (v.tipoEvento) {
                card.appendChild(quoteLine('Tipo de evento', String(v.tipoEvento)));
            }
            if (v.invitados) {
                card.appendChild(quoteLine('Invitados', String(v.invitados)));
            }
            if (v.fechaInicio && v.fechaFin) {
                card.appendChild(quoteLine('Fechas', fmtFecha(v.fechaInicio) + ' – ' + fmtFecha(v.fechaFin)
                    + ' · ' + diasEntre(v.fechaInicio, v.fechaFin) + ' días'));
            }
            if (v.horaEntrega) {
                card.appendChild(quoteLine('Hora de entrega', String(v.horaEntrega)));
            }
            if (v.direccion) {
                card.appendChild(quoteLine('Dirección', String(v.direccion)));
            }
            if (v.notas) {
                card.appendChild(quoteLine('Notas', String(v.notas)));
            }
            (avisos || []).forEach(function (aviso) {
                var note = document.createElement('p');
                note.className = 'fa-quote-note';
                note.textContent = aviso;
                card.appendChild(note);
            });

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';
            actions.appendChild(button('Ir al checkout', 'fa-btn-primary', function () {
                trackAssistantEvent('assistant_detalles_checkout');
                goToCheckout('/cotizacion');
            }, ICONS.cart));
            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row assistant fa-enter';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
        }

        /** Icono que acompaña a un campo del formulario. */
        function fieldIcon(field) {
            switch (field.name) {
                case 'tipoEvento': return ICONS.tag;
                case 'invitados': return ICONS.users;
                case 'estilo': return ICONS.pencil;
                case 'presupuesto': return ICONS.coin;
                case 'horaEvento': return ICONS.clock;
                case 'horaEntrega': return ICONS.clock;
                case 'direccion': return ICONS.pin;
                case 'notas': return ICONS.pencil;
                default: break;
            }
            if (field.type === 'time') { return ICONS.clock; }
            if (field.type === 'number') { return ICONS.coin; }
            if (field.type === 'textarea') { return ICONS.pencil; }
            return ICONS.tag;
        }

        function fieldHead(field) {
            var head = document.createElement('span');
            head.className = 'fa-field-head';
            var icon = fieldIcon(field);
            if (icon) {
                head.appendChild(svgIcon(icon, 14));
            }
            var label = document.createElement('span');
            label.textContent = field.label || field.name;
            if (field.required) {
                var req = document.createElement('span');
                req.className = 'fa-field-req';
                req.textContent = ' *';
                label.appendChild(req);
            }
            head.appendChild(label);
            return head;
        }

        /** Campo de texto, número, select o textarea con el control estilo Tailwind. */
        function buildFormControl(field, inputs) {
            if (field.type === 'select') {
                return buildSelectField(field, inputs);
            }

            var wrap = document.createElement('label');
            wrap.className = 'fa-field';
            wrap.appendChild(fieldHead(field));

            var control = document.createElement('div');
            control.className = 'fa-control';
            var icon = fieldIcon(field);
            if (icon && field.type !== 'textarea') {
                control.classList.add('has-ico');
                var ico = document.createElement('span');
                ico.className = 'fa-control-ico';
                ico.appendChild(svgIcon(icon, 16));
                control.appendChild(ico);
            }

            var input;
            if (field.type === 'textarea') {
                input = document.createElement('textarea');
                input.rows = 3;
                if (field.placeholder) {
                    input.placeholder = field.placeholder;
                }
            } else {
                input = document.createElement('input');
                if (field.type === 'number') {
                    input.type = 'number';
                    input.min = '0';
                    input.inputMode = 'numeric';
                } else if (field.type === 'time') {
                    input.type = 'time';
                    input.step = field.step || '900';
                    if (field.min) { input.min = field.min; }
                    if (field.max) { input.max = field.max; }
                } else {
                    input.type = 'text';
                }
                if (field.placeholder) {
                    input.placeholder = field.placeholder;
                }
            }
            input.name = field.name;
            if (field.required) {
                input.required = true;
            }
            if (field.value != null) {
                input.value = field.value;
            }
            inputs[field.name] = input;
            control.appendChild(input);

            wrap.appendChild(control);
            return wrap;
        }

        /**
         * Metadatos visuales de las opciones de los desplegables del formulario: icono y tono de
         * color, para que cada opción se distinga de un vistazo.
         */
        var SELECT_META = {
            boda: { icon: 'rings', tone: 'rose' },
            cumpleanos: { icon: 'cake', tone: 'amber' },
            corporativo: { icon: 'briefcase', tone: 'blue' },
            grado: { icon: 'cap', tone: 'violet' },
            baby_shower: { icon: 'heart', tone: 'pink' },
            otro: { icon: 'sparkles', tone: 'slate' },
            elegante: { icon: 'diamond', tone: 'amber' },
            moderno: { icon: 'bolt', tone: 'blue' },
            rustico: { icon: 'leaf', tone: 'green' },
            minimalista: { icon: 'minimal', tone: 'slate' },
            Boda: { icon: 'rings', tone: 'rose' },
            'Cumpleaños': { icon: 'cake', tone: 'amber' },
            Corporativo: { icon: 'briefcase', tone: 'blue' },
            'Graduación': { icon: 'cap', tone: 'violet' },
            Feria: { icon: 'tag', tone: 'slate' },
            Otro: { icon: 'sparkles', tone: 'slate' }
        };

        // Desplegable abierto, para cerrarlo al hacer clic fuera o al salir de la vista.
        var openSelect = null;

        function selectMeta(field, value) {
            var meta = SELECT_META[value];
            if (meta && ICONS[meta.icon]) {
                return { icon: ICONS[meta.icon], tone: meta.tone || 'slate' };
            }
            return { icon: fieldIcon(field), tone: 'slate' };
        }

        function closeOpenSelect() {
            if (!openSelect) {
                return;
            }
            openSelect.menu.hidden = true;
            openSelect.trigger.setAttribute('aria-expanded', 'false');
            openSelect.trigger.classList.remove('is-open');
            openSelect.control.classList.remove('is-open');
            if (openSelect.wrap) {
                openSelect.wrap.classList.remove('is-open');
            }
            openSelect = null;
        }

        /** Coloca el menú bajo el disparador y limita su alto al espacio visible del panel. */
        function positionSelectMenu(menu, trigger) {
            var body = els.viewForm ? els.viewForm.closest('.fa-side-body') : null;
            var max = 240;
            var rect = trigger.getBoundingClientRect();
            if (body) {
                var bodyRect = body.getBoundingClientRect();
                var below = bodyRect.bottom - rect.bottom - 14;
                var above = rect.top - bodyRect.top - 14;
                if (below < 170 && above > below) {
                    menu.style.top = 'auto';
                    menu.style.bottom = 'calc(100% + 6px)';
                    max = Math.min(max, above);
                } else {
                    menu.style.bottom = 'auto';
                    menu.style.top = 'calc(100% + 6px)';
                    max = Math.min(max, below);
                }
            }
            menu.style.maxHeight = Math.max(120, max) + 'px';
        }

        /** Construye el campo desplegable propio (trigger + menú con iconos y colores). */
        function buildSelectField(field, inputs) {
            var wrap = document.createElement('div');
            wrap.className = 'fa-field';
            wrap.appendChild(fieldHead(field));

            var control = document.createElement('div');
            control.className = 'fa-control';

            var trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'fa-select';
            trigger.setAttribute('aria-haspopup', 'listbox');
            trigger.setAttribute('aria-expanded', 'false');

            var valueIco = document.createElement('span');
            valueIco.className = 'fa-select-ico';
            valueIco.appendChild(svgIcon(fieldIcon(field), 16));
            var label = document.createElement('span');
            label.className = 'fa-select-label';
            label.textContent = 'Selecciona...';
            var caret = document.createElement('span');
            caret.className = 'fa-select-caret';
            caret.appendChild(svgIcon(ICONS.chevron, 16));
            trigger.appendChild(valueIco);
            trigger.appendChild(label);
            trigger.appendChild(caret);

            var menu = document.createElement('ul');
            menu.className = 'fa-select-menu';
            menu.setAttribute('role', 'listbox');
            menu.hidden = true;

            var hidden = hiddenInput(field.name);
            inputs[field.name] = hidden;

            function applyValue(value, optLabel) {
                hidden.value = value || '';
                control.classList.toggle('has-value', !!value);
                var items = menu.querySelectorAll('.fa-select-opt');
                for (var k = 0; k < items.length; k++) {
                    items[k].setAttribute('aria-selected',
                        items[k].getAttribute('data-value') === value ? 'true' : 'false');
                }
                valueIco.textContent = '';
                if (value) {
                    var meta = selectMeta(field, value);
                    valueIco.appendChild(svgIcon(meta.icon, 16));
                    valueIco.setAttribute('data-tone', meta.tone);
                    label.textContent = optLabel || value;
                } else {
                    valueIco.appendChild(svgIcon(fieldIcon(field), 16));
                    valueIco.removeAttribute('data-tone');
                    label.textContent = 'Selecciona...';
                }
            }

            var optEls = [];
            (field.options || []).forEach(function (opt) {
                var value = opt.value != null ? opt.value : opt;
                var text = opt.label != null ? opt.label : opt;
                var meta = selectMeta(field, value);
                var li = document.createElement('li');
                li.className = 'fa-select-opt';
                li.setAttribute('role', 'option');
                li.setAttribute('data-value', value);
                li.setAttribute('aria-selected', 'false');
                var ico = document.createElement('span');
                ico.className = 'fa-select-opt-ico';
                ico.setAttribute('data-tone', meta.tone);
                ico.appendChild(svgIcon(meta.icon, 16));
                var span = document.createElement('span');
                span.className = 'fa-select-opt-text';
                span.textContent = text;
                var check = document.createElement('span');
                check.className = 'fa-select-check';
                check.appendChild(svgIcon(ICONS.check, 15));
                li.appendChild(ico);
                li.appendChild(span);
                li.appendChild(check);
                li.addEventListener('click', function () {
                    applyValue(value, text);
                    closeOpenSelect();
                    trigger.focus();
                });
                optEls.push(li);
                menu.appendChild(li);
            });

            // Valor inicial: si el dato ya se conoce (p. ej. lo dijo al asistente) se preselecciona.
            if (field.value != null && field.value !== '') {
                for (var q = 0; q < optEls.length; q++) {
                    if (optEls[q].getAttribute('data-value') === String(field.value)) {
                        var iniSpan = optEls[q].querySelector('.fa-select-opt-text');
                        applyValue(String(field.value), iniSpan ? iniSpan.textContent : String(field.value));
                        break;
                    }
                }
            }

            var activeIndex = -1;

            function setActive(index) {
                activeIndex = index;
                for (var n = 0; n < optEls.length; n++) {
                    var on = n === index;
                    optEls[n].classList.toggle('is-active', on);
                    if (on && optEls[n].scrollIntoView) {
                        optEls[n].scrollIntoView({ block: 'nearest' });
                    }
                }
            }

            function openMenu() {
                closeOpenSelect();
                menu.hidden = false;
                trigger.setAttribute('aria-expanded', 'true');
                trigger.classList.add('is-open');
                control.classList.add('is-open');
                wrap.classList.add('is-open');
                openSelect = { control: control, menu: menu, trigger: trigger, wrap: wrap };
                positionSelectMenu(menu, trigger);
                var current = hidden.value;
                var found = -1;
                for (var n = 0; n < optEls.length; n++) {
                    if (optEls[n].getAttribute('data-value') === current) {
                        found = n;
                        break;
                    }
                }
                setActive(found);
            }

            trigger.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                if (menu.hidden) {
                    openMenu();
                } else {
                    closeOpenSelect();
                }
            });

            trigger.addEventListener('keydown', function (event) {
                var key = event.key;
                if (menu.hidden) {
                    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
                        event.preventDefault();
                        openMenu();
                        setActive(key === 'ArrowUp' ? optEls.length - 1 : 0);
                    }
                    return;
                }
                if (key === 'ArrowDown') {
                    event.preventDefault();
                    setActive(Math.min(activeIndex + 1, optEls.length - 1));
                } else if (key === 'ArrowUp') {
                    event.preventDefault();
                    setActive(Math.max(activeIndex - 1, 0));
                } else if (key === 'Home') {
                    event.preventDefault();
                    setActive(0);
                } else if (key === 'End') {
                    event.preventDefault();
                    setActive(optEls.length - 1);
                } else if (key === 'Enter' || key === ' ') {
                    event.preventDefault();
                    if (activeIndex >= 0 && optEls[activeIndex]) {
                        optEls[activeIndex].click();
                    }
                } else if (key === 'Tab') {
                    closeOpenSelect();
                }
            });

            control.appendChild(trigger);
            control.appendChild(hidden);
            control.appendChild(menu);
            wrap.appendChild(control);
            return wrap;
        }

        /**
         * Campo de fechas del formulario: DateRangePicker de HeroUI.
         * Anatomía: etiqueta + grupo con los dos segmentos (inicio y fin) unidos por un
         * separador, el disparador de calendario como sufijo y el popover con el RangeCalendar.
         * El popover se anexa al panel para heredar los tokens --fa-* y el modo oscuro.
         */
        function buildDateRangeField(dateFields, inputs) {
            var first = dateFields[0];
            var second = dateFields[1] || null;

            var wrap = document.createElement('div');
            wrap.className = 'fa-field';
            var head = document.createElement('span');
            head.className = 'fa-field-head';
            head.appendChild(svgIcon(ICONS.calendar, 14));
            var label = document.createElement('span');
            label.textContent = second ? 'Fechas del evento' : (first.label || 'Fecha');
            wrap.appendChild(head);
            head.appendChild(label);

            var control = document.createElement('div');
            control.className = 'fa-control';

            // Disparador: grupo con los dos segmentos, separador y disparador de calendario.
            var trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'fa-drp';
            trigger.setAttribute('aria-haspopup', 'dialog');
            trigger.setAttribute('aria-expanded', 'false');

            var startSeg = document.createElement('span');
            startSeg.className = 'fa-drp-seg';
            startSeg.setAttribute('data-slot', 'start');
            startSeg.setAttribute('data-empty', 'true');
            startSeg.textContent = second ? 'Desde' : 'Selecciona la fecha';
            trigger.appendChild(startSeg);

            if (second) {
                var sep = document.createElement('span');
                sep.className = 'fa-drp-sep';
                sep.setAttribute('aria-hidden', 'true');
                sep.appendChild(svgIcon(ICONS.range, 15));
                trigger.appendChild(sep);

                var endSeg = document.createElement('span');
                endSeg.className = 'fa-drp-seg';
                endSeg.setAttribute('data-slot', 'end');
                endSeg.setAttribute('data-empty', 'true');
                endSeg.textContent = 'Hasta';
                trigger.appendChild(endSeg);
            }

            var ico = document.createElement('span');
            ico.className = 'fa-drp-ico';
            ico.setAttribute('aria-hidden', 'true');
            ico.appendChild(svgIcon(ICONS.calendar, 16));
            trigger.appendChild(ico);

            control.appendChild(trigger);

            var hiddenStart = hiddenInput(first.name);
            inputs[first.name] = hiddenStart;
            control.appendChild(hiddenStart);
            var hiddenEnd = null;
            if (second) {
                hiddenEnd = hiddenInput(second.name);
                inputs[second.name] = hiddenEnd;
                control.appendChild(hiddenEnd);
            }

            var clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'fa-drp-clear';
            clearBtn.setAttribute('aria-label', 'Limpiar fechas');
            clearBtn.setAttribute('title', 'Limpiar fechas');
            clearBtn.appendChild(svgIcon(ICONS.close, 15));
            control.appendChild(clearBtn);

            wrap.appendChild(control);

            // Pie del popover: resumen de días + acción de limpiar.
            var footHint = document.createElement('span');
            footHint.className = 'fa-drp-foot-hint';
            var footClear = document.createElement('button');
            footClear.type = 'button';
            footClear.className = 'fa-drp-foot-clear';
            footClear.textContent = 'Limpiar';
            footClear.hidden = true;

            function updateFoot() {
                var s = hiddenStart.value;
                var e = hiddenEnd ? hiddenEnd.value : '';
                footHint.textContent = '';
                footClear.hidden = !s;
                if (!s) {
                    footHint.textContent = second
                        ? 'Elige el día de inicio.'
                        : 'Elige una fecha.';
                    return;
                }
                if (second && !e) {
                    footHint.textContent = 'Ahora elige el día de fin.';
                    return;
                }
                var d = diasEntre(s, e || s);
                var strong = document.createElement('strong');
                strong.textContent = String(d);
                footHint.appendChild(strong);
                footHint.appendChild(document.createTextNode(
                    ' ' + (d === 1 ? 'día' : 'días') + ' de alquiler'));
            }

            function updateTrigger() {
                var s = hiddenStart.value;
                var e = hiddenEnd ? hiddenEnd.value : '';
                if (!s) {
                    startSeg.textContent = second ? 'Desde' : 'Selecciona la fecha';
                    startSeg.setAttribute('data-empty', 'true');
                    if (second) {
                        endSeg.textContent = 'Hasta';
                        endSeg.setAttribute('data-empty', 'true');
                    }
                } else {
                    startSeg.textContent = fmtFecha(s);
                    startSeg.removeAttribute('data-empty');
                    if (second) {
                        endSeg.textContent = (e && e !== s) ? fmtFecha(e) : 'Mismo día';
                        endSeg.setAttribute('data-empty', (e && e !== s) ? 'false' : 'true');
                    }
                    // Reinicia la animación de intercambio de los segmentos.
                    trigger.classList.remove('is-filled');
                    void trigger.offsetWidth;
                    trigger.classList.add('is-filled');
                }
                control.classList.toggle('has-clear', !!s);
                updateFoot();
            }

            // El calendario vive dentro del popover; no requiere dependencias externas.
            var cal = createRangeCalendar({
                single: !second,
                maxSpan: DETALLES_MAX_DIAS,
                onChange: function (s, e) {
                    hiddenStart.value = s || '';
                    if (hiddenEnd) {
                        hiddenEnd.value = e || '';
                    }
                    updateTrigger();
                    // Los campos ocultos no emiten 'input' al asignarles valor: lo avisamos a mano
                    // para que la vista (p. ej. el checklist) reaccione al rango elegido.
                    hiddenStart.dispatchEvent(new Event('input'));
                    if (hiddenEnd) {
                        hiddenEnd.dispatchEvent(new Event('input'));
                    }
                    // Con el rango completo elegido, el popover se cierra solo (tras dejar ver
                    // el resaltado de la selección) para devolver el foco al formulario.
                    if (s && e) {
                        window.setTimeout(function () {
                            if (!pop.hidden) {
                                closeFormPopover();
                                trigger.focus();
                            }
                        }, 160);
                    }
                }
            });
            formFieldCal = cal;

            var pop = document.createElement('div');
            pop.className = 'fa-drp-pop';
            pop.setAttribute('role', 'dialog');
            pop.setAttribute('aria-label', second ? 'Selecciona el rango de fechas' : 'Selecciona una fecha');
            pop.hidden = true;
            pop.appendChild(cal.el);
            var foot = document.createElement('div');
            foot.className = 'fa-drp-foot';
            foot.appendChild(footHint);
            foot.appendChild(footClear);
            pop.appendChild(foot);

            trigger.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                if (!pop.hidden) {
                    closeFormPopover();
                    return;
                }
                openFormPopover({
                    anchor: trigger,
                    pop: pop,
                    cal: cal,
                    onClose: function () { trigger.setAttribute('aria-expanded', 'false'); }
                });
                trigger.setAttribute('aria-expanded', 'true');
            });

            function clearRange(event) {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                cal.clear();
                hiddenStart.value = '';
                if (hiddenEnd) {
                    hiddenEnd.value = '';
                }
                updateTrigger();
                hiddenStart.dispatchEvent(new Event('input'));
                if (hiddenEnd) {
                    hiddenEnd.dispatchEvent(new Event('input'));
                }
                if (!pop.hidden && !second) {
                    // Sin rango no hay nada más que elegir: se cierra el popover.
                    closeFormPopover();
                }
            }

            clearBtn.addEventListener('click', clearRange);
            footClear.addEventListener('click', clearRange);

            // Rango inicial: si las fechas ya se conocen (asistente o intento previo) se precargan.
            var initStart = first.value || null;
            var initEnd = (second && second.value) || initStart;
            if (initStart) {
                hiddenStart.value = initStart;
                if (hiddenEnd) {
                    hiddenEnd.value = initEnd || initStart;
                }
                cal.setRange(initStart, initEnd || initStart);
            }

            updateTrigger();
            return wrap;
        }

        /** Abre el popover del calendario del formulario, anclado a su disparador. */
        function openFormPopover(ctx) {
            closeFormPopover();
            els.panel.appendChild(ctx.pop);
            ctx.pop.hidden = false;
            formPopover = ctx;
            positionFormPopover();
            if (ctx.cal && typeof ctx.cal.focus === 'function') {
                ctx.cal.focus();
            }

            ctx.onDoc = function (event) {
                if (ctx.pop.contains(event.target) || ctx.anchor.contains(event.target)) {
                    return;
                }
                closeFormPopover();
            };
            ctx.onKey = function (event) {
                if (event.key === 'Escape') {
                    closeFormPopover();
                    ctx.anchor.focus();
                }
            };
            ctx.onReflow = positionFormPopover;
            document.addEventListener('mousedown', ctx.onDoc, true);
            document.addEventListener('keydown', ctx.onKey, true);
            var body = els.panel.querySelector('.fa-side-body');
            if (body) {
                body.addEventListener('scroll', ctx.onReflow, { passive: true });
            }
            window.addEventListener('resize', ctx.onReflow);
        }

        /** Coloca el popover bajo el disparador y lo mantiene dentro del panel. */
        function positionFormPopover() {
            if (!formPopover) {
                return;
            }
            var panelRect = els.panel.getBoundingClientRect();
            var anchorRect = formPopover.anchor.getBoundingClientRect();
            var pop = formPopover.pop;
            var width = pop.offsetWidth || 304;
            var height = pop.offsetHeight || 396;
            var left = anchorRect.left - panelRect.left;
            var top = anchorRect.bottom - panelRect.top + 8;
            var maxLeft = panelRect.width - width - 12;
            left = Math.max(12, Math.min(left, Math.max(12, maxLeft)));
            if (top + height > panelRect.height - 12) {
                var above = anchorRect.top - panelRect.top - height - 8;
                top = above >= 12 ? above : Math.max(12, panelRect.height - height - 12);
            }
            pop.style.left = Math.round(left) + 'px';
            pop.style.top = Math.round(top) + 'px';
        }

        /** Cierra y limpia el popover del calendario del formulario. */
        function closeFormPopover() {
            if (!formPopover) {
                return;
            }
            var ctx = formPopover;
            formPopover = null;
            document.removeEventListener('mousedown', ctx.onDoc, true);
            document.removeEventListener('keydown', ctx.onKey, true);
            var body = els.panel.querySelector('.fa-side-body');
            if (body) {
                body.removeEventListener('scroll', ctx.onReflow);
            }
            window.removeEventListener('resize', ctx.onReflow);
            if (ctx.pop.parentNode) {
                ctx.pop.parentNode.removeChild(ctx.pop);
            }
            ctx.pop.hidden = true;
            if (ctx.onClose) {
                ctx.onClose();
            }
        }

        function hiddenInput(name) {
            var input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            return input;
        }

        function destroyFormFp() {
            closeFormPopover();
            formFieldCal = null;
        }

        // ── Vista: recomendación ──

        function renderRecommendation(data) {
            var view = els.viewReco;
            if (!view) {
                return;
            }
            view.textContent = '';
            var sub = document.createElement('p');
            sub.className = 'fa-panel-sub';
            var bits = [];
            if (data.invitados) {
                bits.push(data.invitados + ' personas');
            }
            if (data.estilo) {
                bits.push('estilo ' + data.estilo);
            }
            if (data.dias) {
                bits.push(data.dias + (data.dias === 1 ? ' día' : ' días'));
            }
            sub.textContent = bits.length ? ('Para ' + bits.join(' · ')) : 'Propuesta de mobiliario para tu evento.';
            view.appendChild(sub);

            var items = data.items || [];
            if (items.length === 0) {
                var empty = document.createElement('p');
                empty.className = 'fa-bag-empty';
                empty.textContent = 'No hay una recomendación todavía.';
                view.appendChild(empty);
                return;
            }

            items.forEach(function (item) {
                var line = document.createElement('div');
                line.className = 'fa-bag-item';
                if (item.imagen) {
                    var thumb = document.createElement('img');
                    thumb.className = 'fa-bag-thumb';
                    thumb.alt = '';
                    thumb.loading = 'lazy';
                    thumb.src = item.imagen;
                    line.appendChild(thumb);
                }
                var main = document.createElement('div');
                main.className = 'fa-bag-main';
                var name = document.createElement('p');
                name.className = 'fa-bag-name';
                name.textContent = (item.nombre || 'Producto') + ' ×' + (item.cantidad || 0);
                main.appendChild(name);
                var price = document.createElement('p');
                price.className = 'fa-bag-price';
                price.textContent = formatCOP(item.precioDia) + ' / día';
                main.appendChild(price);
                line.appendChild(main);
                var sub2 = document.createElement('span');
                sub2.className = 'fa-quote-item-sub';
                sub2.textContent = formatCOP(item.subtotalDia);
                line.appendChild(sub2);
                view.appendChild(line);
            });

            if (data.totalEstimado != null) {
                var total = document.createElement('div');
                total.className = 'fa-bag-total';
                total.appendChild(textSpan('Total estimado'));
                total.appendChild(textSpan(formatCOP(data.totalEstimado)));
                view.appendChild(total);
            }
            if (data.presupuesto) {
                var budget = document.createElement('p');
                budget.className = 'fa-reco-budget';
                budget.textContent = 'Presupuesto indicado: ' + formatCOP(data.presupuesto) + '.';
                view.appendChild(budget);
            }

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';
            actions.appendChild(button('Agregar a mi bolsa', 'fa-btn-primary', function () {
                setBagFromLines(items);
                toast('Recomendación agregada a tu bolsa', 'success');
                openSidePanel('bolsa');
            }, ICONS.cart));
            actions.appendChild(button('Elegir fechas', 'fa-btn-ghost', function () {
                openSidePanel('fechas');
            }, ICONS.calendar));
            view.appendChild(actions);
        }

        // ── Vista: bolsa ──

        function renderBagPanel(serverItems) {
            var view = els.viewBolsa;
            if (!view) {
                return;
            }
            if (serverItems && serverItems.length) {
                mergeBagFromServer(serverItems);
            }
            view.textContent = '';
            var bag = readBag();
            if (bag.length === 0) {
                var empty = document.createElement('p');
                empty.className = 'fa-bag-empty';
                empty.textContent = 'Tu bolsa está vacía. Pídeme recomendaciones o agrega productos '
                    + 'desde el catálogo.';
                view.appendChild(empty);
                return;
            }

            var totalDia = 0;
            bag.forEach(function (item) {
                var line = document.createElement('div');
                line.className = 'fa-bag-item';
                if (item.image) {
                    var thumb = document.createElement('img');
                    thumb.className = 'fa-bag-thumb';
                    thumb.alt = '';
                    thumb.loading = 'lazy';
                    thumb.src = item.image;
                    line.appendChild(thumb);
                }
                var main = document.createElement('div');
                main.className = 'fa-bag-main';
                var name = document.createElement('p');
                name.className = 'fa-bag-name';
                name.textContent = item.name || 'Producto';
                main.appendChild(name);
                var price = document.createElement('p');
                price.className = 'fa-bag-price';
                price.textContent = formatCOP(item.price) + ' / día';
                main.appendChild(price);
                line.appendChild(main);

                var qty = document.createElement('div');
                qty.className = 'fa-qty';
                qty.appendChild(qtyButton('-', function () {
                    changeBagQty(item.id, -1);
                    renderBagPanel();
                }));
                var value = document.createElement('span');
                value.textContent = item.qty || 0;
                qty.appendChild(value);
                qty.appendChild(qtyButton('+', function () {
                    changeBagQty(item.id, 1);
                    renderBagPanel();
                }));
                line.appendChild(qty);
                view.appendChild(line);

                totalDia += (Number(item.price) || 0) * (Number(item.qty) || 0);
            });

            var total = document.createElement('div');
            total.className = 'fa-bag-total';
            total.appendChild(textSpan('Total por día'));
            total.appendChild(textSpan(formatCOP(totalDia)));
            view.appendChild(total);

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';
            actions.appendChild(button('Cotizar mi bolsa', 'fa-btn-primary', function () {
                closeSidePanel();
                sendUserMessage('Quiero cotizar lo que tengo en mi bolsa.');
            }, ICONS.receipt));
            actions.appendChild(button('Vaciar', 'fa-btn-ghost', function () {
                writeBag([]);
                renderBagPanel();
                toast('Bolsa vaciada', 'success');
            }, ICONS.trash));
            view.appendChild(actions);
        }

        function qtyButton(label, onClick) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.addEventListener('click', onClick);
            return b;
        }

        // ── Vista: seguimiento del alquiler ──

        /** Estados de una reserva con su etiqueta y tono de color. */
        var ESTADOS_RESERVA = {
            PENDIENTE: { label: 'Pendiente', tone: 'amber' },
            CONFIRMADA: { label: 'Confirmada', tone: 'blue' },
            ENTREGADA: { label: 'Entregada', tone: 'violet' },
            COMPLETADA: { label: 'Completada', tone: 'green' },
            CANCELADA: { label: 'Cancelada', tone: 'red' }
        };

        /** Chip de estado con color, para leer el avance de un vistazo. */
        function estadoChip(estado) {
            var meta = ESTADOS_RESERVA[String(estado || '').toUpperCase()]
                || { label: estado || '—', tone: 'slate' };
            var chip = document.createElement('span');
            chip.className = 'fa-status fa-status-' + meta.tone;
            var text = document.createElement('span');
            text.textContent = meta.label;
            chip.appendChild(text);
            return chip;
        }

        /** Caja con título que agrupa un bloque del detalle. */
        function seccion(titulo, contenido) {
            var box = document.createElement('div');
            box.className = 'fa-quote fa-res-section';
            if (titulo) {
                var head = document.createElement('p');
                head.className = 'fa-panel-title';
                head.textContent = titulo;
                box.appendChild(head);
            }
            (Array.isArray(contenido) ? contenido : [contenido]).forEach(function (node) {
                if (node) {
                    box.appendChild(node);
                }
            });
            return box;
        }

        /** Fila "etiqueta / valor" con icono, para los datos del evento. */
        function infoRow(icon, label, value) {
            var row = document.createElement('div');
            row.className = 'fa-res-row';
            var ico = document.createElement('span');
            ico.className = 'fa-res-row-ico';
            ico.appendChild(svgIcon(icon, 16));
            row.appendChild(ico);
            var main = document.createElement('div');
            main.className = 'fa-res-row-main';
            var lab = document.createElement('span');
            lab.className = 'fa-res-row-label';
            lab.textContent = label;
            main.appendChild(lab);
            var val = document.createElement('span');
            val.className = 'fa-res-row-value';
            val.textContent = value;
            main.appendChild(val);
            row.appendChild(main);
            return row;
        }

        function renderReservation(data) {
            var view = els.viewAlquiler;
            if (!view) {
                return;
            }
            view.textContent = '';
            if (data.reserva) {
                renderReservationDetail(view, data.reserva);
                return;
            }
            var list = data.reservas || [];
            if (list.length === 0) {
                var empty = document.createElement('p');
                empty.className = 'fa-bag-empty';
                empty.textContent = 'No encuentro alquileres en tu cuenta.';
                view.appendChild(empty);
                return;
            }
            list.forEach(function (r) {
                var box = document.createElement('div');
                box.className = 'fa-quote fa-res-list-item';
                var head = document.createElement('div');
                head.className = 'fa-res-top';
                var title = document.createElement('h4');
                title.textContent = 'Alquiler #' + shortId(r.id);
                head.appendChild(title);
                head.appendChild(estadoChip(r.estado));
                box.appendChild(head);
                var meta = document.createElement('p');
                meta.className = 'fa-quote-dates';
                meta.textContent = rangoDeReserva(r)
                    + (typeof r.dias === 'number' ? ' · ' + r.dias + (r.dias === 1 ? ' día' : ' días') : '');
                box.appendChild(meta);
                if (r.total != null) {
                    box.appendChild(quoteLine('Total', formatCOP(r.total)));
                }
                view.appendChild(box);
            });
        }

        function renderReservationDetail(view, r) {
            // Encabezado: número, estado y fechas.
            var head = document.createElement('div');
            head.className = 'fa-res-head';
            var top = document.createElement('div');
            top.className = 'fa-res-top';
            var title = document.createElement('h3');
            title.className = 'fa-res-id';
            title.textContent = 'Alquiler #' + shortId(r.id);
            top.appendChild(title);
            top.appendChild(estadoChip(r.estado));
            head.appendChild(top);
            var range = document.createElement('p');
            range.className = 'fa-res-range';
            range.textContent = rangoDeReserva(r)
                + (typeof r.dias === 'number' ? ' · ' + r.dias + (r.dias === 1 ? ' día' : ' días') : '');
            head.appendChild(range);
            view.appendChild(head);

            // Estado del pedido (línea de tiempo).
            if (r.timeline && r.timeline.length) {
                view.appendChild(seccion('Estado del pedido', buildTimeline(r.timeline)));
            }

            // Datos del evento.
            var evento = [];
            if (r.tipoEvento) {
                evento.push(infoRow('tag', 'Tipo de evento', String(r.tipoEvento)));
            }
            if (r.horaEntrega) {
                evento.push(infoRow('clock', 'Hora de entrega', String(r.horaEntrega)));
            }
            if (r.direccionEvento) {
                evento.push(infoRow('pin', 'Dirección', String(r.direccionEvento)));
            }
            if (r.notasEvento) {
                evento.push(infoRow('pencil', 'Notas', String(r.notasEvento)));
            }
            if (evento.length) {
                view.appendChild(seccion('Datos del evento', evento));
            }

            // Muebles solicitados.
            if (r.items && r.items.length) {
                view.appendChild(seccion('Muebles solicitados', r.items.map(function (item) {
                    return quoteLine(item.nombre || 'Producto', '×' + (item.cantidad || 0));
                })));
            }

            // Resumen de pago con barra de progreso.
            var pago = seccion('Resumen de pago', []);
            var pct = Math.max(0, Math.min(100, Math.round(Number(r.porcentajePagado || 0))));
            var bar = document.createElement('div');
            bar.className = 'fa-res-bar';
            var fill = document.createElement('span');
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            pago.appendChild(bar);
            var barLabel = document.createElement('div');
            barLabel.className = 'fa-res-bar-label';
            var barLeft = document.createElement('span');
            barLeft.textContent = 'Pagado';
            var barRight = document.createElement('span');
            barRight.textContent = pct + '%';
            barLabel.appendChild(barLeft);
            barLabel.appendChild(barRight);
            pago.appendChild(barLabel);
            pago.appendChild(quoteLine('Total', formatCOP(r.total)));
            pago.appendChild(quoteLine('Pagado', formatCOP(r.montoAbonado)));
            pago.appendChild(quoteLine('Saldo pendiente', formatCOP(r.saldoPendiente)));
            if (r.estadoPago) {
                pago.appendChild(quoteLine('Estado de pago', String(r.estadoPago)));
            }
            if (r.metodoPago) {
                pago.appendChild(quoteLine('Método de pago', String(r.metodoPago)));
            }
            view.appendChild(pago);

            // Pagos registrados.
            if (r.pagos && r.pagos.length) {
                view.appendChild(seccion('Pagos registrados', r.pagos.map(function (pg) {
                    return quoteLine(
                        (pg.tipo || 'Pago') + (pg.fecha ? ' · ' + fmtFecha(pg.fecha.slice(0, 10)) : ''),
                        formatCOP(pg.monto)
                    );
                })));
            }
        }

        function buildTimeline(steps) {
            var wrap = document.createElement('div');
            wrap.className = 'fa-timeline';
            steps.forEach(function (step) {
                var row = document.createElement('div');
                row.className = 'fa-step' + (step.completado ? ' done' : '') + (step.actual ? ' current' : '');
                var col = document.createElement('div');
                col.className = 'fa-step-col';
                var dot = document.createElement('span');
                dot.className = 'fa-step-dot';
                col.appendChild(dot);
                var line = document.createElement('span');
                line.className = 'fa-step-line';
                col.appendChild(line);
                row.appendChild(col);
                var label = document.createElement('span');
                label.className = 'fa-step-label';
                label.textContent = step.estado || '';
                row.appendChild(label);
                wrap.appendChild(row);
            });
            return wrap;
        }

        function rangoDeReserva(r) {
            if (!r.fechaInicio || !r.fechaFin) {
                return '';
            }
            return fmtFecha(r.fechaInicio) + ' – ' + fmtFecha(r.fechaFin);
        }

        function textSpan(text) {
            var span = document.createElement('span');
            span.textContent = text;
            return span;
        }

        // ───────────────────────── Historial (servidor) ─────────────────────────

        function loadChatList() {
            if (!els.historyList) {
                return;
            }
            fetch(listUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error('conversations ' + response.status);
                    }
                    return response.json();
                })
                .then(function (data) {
                    chatList = (data && data.conversations) || [];
                    renderHistoryList();
                })
                .catch(function () {
                    chatList = [];
                    renderHistoryList(true);
                });
        }

        function renderHistoryList(failed) {
            if (!els.historyList) {
                return;
            }
            els.historyList.textContent = '';
            if (chatList.length === 0) {
                var empty = document.createElement('p');
                empty.className = 'fa-hist-empty';
                empty.textContent = failed
                    ? 'No se pudo cargar tu historial. El chat sigue disponible.'
                    : 'Aún no tienes chats.';
                els.historyList.appendChild(empty);
                return;
            }
            chatList.forEach(function (conversation) {
                var item = document.createElement('div');
                item.className = 'fa-hist-item';

                var open = document.createElement('button');
                open.type = 'button';
                open.className = 'fa-hist-open';
                open.setAttribute('role', 'listitem');
                if (state.conversationId === conversation.conversationId) {
                    open.setAttribute('data-active', 'true');
                }
                var title = document.createElement('span');
                title.className = 'fa-hist-title';
                title.textContent = conversation.titulo || 'Nuevo chat';
                open.appendChild(title);
                var meta = document.createElement('span');
                meta.className = 'fa-hist-meta';
                var total = conversation.totalMensajes || 0;
                meta.textContent = total + (total === 1 ? ' mensaje' : ' mensajes')
                    + (conversation.ultimoMensaje ? ' · ' + fmtFecha(conversation.ultimoMensaje.slice(0, 10)) : '');
                open.appendChild(meta);
                if (String(conversation.estado || '').toUpperCase() === 'CERRADA') {
                    var badge = document.createElement('span');
                    badge.className = 'fa-hist-badge';
                    badge.textContent = 'Cerrado';
                    open.appendChild(badge);
                }
                open.addEventListener('click', function () {
                    openConversation(conversation.conversationId);
                });
                item.appendChild(open);

                var del = document.createElement('button');
                del.type = 'button';
                del.className = 'fa-hist-del';
                del.setAttribute('aria-label', 'Eliminar chat');
                del.appendChild(svgIcon(ICONS.trash, 15));
                del.addEventListener('click', function () {
                    startDelete(item, conversation);
                });
                item.appendChild(del);

                els.historyList.appendChild(item);
            });
        }

        function updateHistoryActive() {
            if (!els.historyList) {
                return;
            }
            var buttons = els.historyList.querySelectorAll('.fa-hist-open');
            for (var i = 0; i < buttons.length; i++) {
                var isActive = buttons[i].querySelector('.fa-hist-title')
                    && chatList[i] && chatList[i].conversationId === state.conversationId;
                if (isActive) {
                    buttons[i].setAttribute('data-active', 'true');
                } else {
                    buttons[i].removeAttribute('data-active');
                }
            }
        }

        function openConversation(id, silent) {
            if (!id) {
                return;
            }
            fetch(listUrl + '/' + encodeURIComponent(id), {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            }).then(function (response) {
                if (!response.ok) {
                    throw new Error('conversation ' + response.status);
                }
                return response.json();
            }).then(function (data) {
                state.conversationId = id;
                saveActiveId(id);
                resetDateState();
                els.messages.textContent = '';
                currentBubble = null;
                clearChatClosed();
                var messages = (data && data.messages) || [];
                messages.forEach(function (message) {
                    if (message.rol === 'USER' && message.contenido) {
                        appendUserBubble(message.contenido, false);
                    } else if (message.rol === 'ASSISTANT' && message.contenido) {
                        appendAssistantBubble(message.contenido, false);
                    }
                });
                if (messages.length === 0) {
                    renderWelcome();
                }
                if (String(data.estado || '').toUpperCase() === 'CERRADA') {
                    setChatClosed(data.motivoCierre);
                }
                closeSidePanel();
                closeHistory();
                if (!silent) {
                    openPanel();
                }
                updateHistoryActive();
                window.setTimeout(scrollDown, 40);
            }).catch(function () {
                if (silent) {
                    boot();
                } else {
                    toast('No se pudo abrir ese chat', 'error');
                }
            });
        }

        /** Guarda/limpia la conversación activa para sobrevivir la navegación entre páginas. */
        function saveActiveId(id) {
            try {
                if (id) {
                    sessionStorage.setItem(ACTIVE_KEY, id);
                } else {
                    sessionStorage.removeItem(ACTIVE_KEY);
                }
            } catch (e) { /* almacenamiento bloqueado */ }
        }

        function readActiveId() {
            try {
                return sessionStorage.getItem(ACTIVE_KEY) || null;
            } catch (e) {
                return null;
            }
        }

        /** Tipo de navegación: al recargar (F5) se empieza un chat nuevo; al navegar se restaura. */
        function navigationType() {
            try {
                var entries = window.performance
                    && performance.getEntriesByType
                    && performance.getEntriesByType('navigation');
                if (entries && entries.length && entries[0].type) {
                    return entries[0].type;
                }
            } catch (e) { /* opcional */ }
            return 'navigate';
        }

        /** Arranque: restaura la conversación activa salvo que sea una recarga. */
        function start() {
            if (navigationType() === 'reload') {
                saveActiveId(null);
                boot();
                return;
            }
            var saved = readActiveId();
            if (saved) {
                openConversation(saved, true);
            } else {
                boot();
            }
        }

        /**
         * Confirmación de borrado en línea: reemplaza el contenido del ítem por un aviso con
         * "Cancelar" y "Eliminar". Todo ocurre dentro del propio historial (sin `window.confirm`).
         */
        function startDelete(item, conversation) {
            if (!item) {
                return;
            }
            item.textContent = '';
            var box = document.createElement('div');
            box.className = 'fa-hist-confirm';
            var text = document.createElement('p');
            text.className = 'fa-hist-confirm-text';
            text.textContent = '¿Eliminar "' + (conversation.titulo || 'este chat')
                + '"? Esta acción no se puede deshacer.';
            box.appendChild(text);
            var actions = document.createElement('div');
            actions.className = 'fa-hist-confirm-actions';
            actions.appendChild(button('Cancelar', 'fa-btn-ghost', function () {
                renderHistoryList();
            }));
            var confirmBtn = button('Eliminar', 'fa-btn-danger', function () {
                confirmBtn.disabled = true;
                performDelete(conversation.conversationId);
            });
            actions.appendChild(confirmBtn);
            box.appendChild(actions);
            item.appendChild(box);
            confirmBtn.focus();
        }

        function performDelete(id) {
            if (!id) {
                return;
            }
            fetch(listUrl + '/' + encodeURIComponent(id), {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            }).then(function (response) {
                if (!response.ok) {
                    throw new Error('delete ' + response.status);
                }
                chatList = chatList.filter(function (c) { return c.conversationId !== id; });
                renderHistoryList();
                if (state.conversationId === id) {
                    boot();
                }
            }).catch(function () {
                toast('No se pudo eliminar el chat', 'error');
                renderHistoryList();
            });
        }

        function newChat() {
            closeHistory();
            openPanel();
            boot();
        }

        function openHistory() {
            if (!els.history) {
                return;
            }
            els.history.hidden = false;
            if (els.quickChats) {
                els.quickChats.setAttribute('aria-expanded', 'true');
            }
            loadChatList();
        }

        function closeHistory() {
            if (!els.history) {
                return;
            }
            els.history.hidden = true;
            if (els.quickChats) {
                els.quickChats.setAttribute('aria-expanded', 'false');
            }
        }

        // ───────────────────────── Fechas / calendario ─────────────────────────

        function initDatePicker() {
            if (!els.calendarHost || !els.calendarUse) {
                return;
            }
            if (els.calendarClear) {
                els.calendarClear.addEventListener('click', clearDates);
            }
            els.calendarUse.addEventListener('click', useDates);

            els.calendarHost.textContent = '';
            datesCalendar = createRangeCalendar({
                maxSpan: DETALLES_MAX_DIAS,
                start: pendingStart,
                end: pendingEnd,
                onChange: function (start, end) {
                    pendingStart = start || null;
                    pendingEnd = end || null;
                    updateDatesUI();
                }
            });
            els.calendarHost.appendChild(datesCalendar.el);
            syncTimeQuick();
            updateDatesUI();
        }

        // ── RangeCalendar (réplica del componente de HeroUI, sin dependencias) ──

        /** Primer día del mes de `date`. */
        function startOfMonth(date) {
            return new Date(date.getFullYear(), date.getMonth(), 1);
        }

        /** Índice absoluto del mes (año * 12 + mes), para comparar meses. */
        function monthIndex(date) {
            return date.getFullYear() * 12 + date.getMonth();
        }

        /** Suma meses a `date` conservando el primer día del mes. */
        function addMonths(date, n) {
            return new Date(date.getFullYear(), date.getMonth() + n, 1);
        }

        /**
         * Construye un calendario de rango (o de fecha única) con el aspecto y la
         * interacción del RangeCalendar de HeroUI. Devuelve el nodo y una API mínima
         * para leer/fijar el rango, refrescar la vista y limpiar la selección.
         *
         * Conserva la lógica actual: no permite fechas pasadas, marca los días ocupados
         * (reservedRanges) y limita el rango a `maxSpan` días (DETALLES_MAX_DIAS).
         */
        function createRangeCalendar(opts) {
            opts = opts || {};
            var maxSpan = opts.maxSpan || DETALLES_MAX_DIAS;
            var single = !!opts.single;
            var onChange = opts.onChange || function () {};

            var root = document.createElement('div');
            root.className = 'fa-rcal';
            root.setAttribute('role', 'group');
            root.setAttribute('aria-label', single ? 'Calendario' : 'Rango de fechas');

            var initial = opts.start ? parseIso(opts.start) : null;
            var view = startOfMonth(initial || new Date());
            var start = opts.start || null;
            var end = opts.end || null;
            var hoverIso = null;

            /** Mientras se elige el segundo extremo, la ventana se limita a `maxSpan` días. */
            function inAllowedWindow(iso) {
                if (single || !start || end) {
                    return true;
                }
                return iso >= addDaysIso(start, -(maxSpan - 1)) && iso <= addDaysIso(start, maxSpan - 1);
            }

            function dayDisabled(iso) {
                if (iso < todayIso()) { return true; }
                if (findReserved(iso)) { return true; }
                return !inAllowedWindow(iso);
            }

            /** ¿Hay algún día ocupado dentro del rango [lo, hi]? */
            function rangeHasReserved(lo, hi) {
                for (var i = 0; i < reservedRanges.length; i++) {
                    var r = reservedRanges[i];
                    if (r && r.from && r.to && r.from <= hi && r.to >= lo) {
                        return true;
                    }
                }
                return false;
            }

            function buildDay(date, hoy) {
                var iso = toIso(date);
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'fa-rcal-day';
                btn.setAttribute('role', 'gridcell');
                btn.setAttribute('data-iso', iso);
                btn.setAttribute('aria-label', DIAS_LARGO[(date.getDay() + 6) % 7] + ', '
                    + date.getDate() + ' de ' + MESES_LARGO[date.getMonth()] + ' de ' + date.getFullYear());

                var num = document.createElement('span');
                num.className = 'fa-rcal-day-num';
                num.textContent = String(date.getDate());
                btn.appendChild(num);

                if (date.getMonth() !== view.getMonth()) {
                    btn.setAttribute('data-outside', 'true');
                }
                if (iso === hoy) {
                    btn.setAttribute('data-today', 'true');
                }
                if (findReserved(iso)) {
                    btn.setAttribute('data-unavailable', 'true');
                }
                if (dayDisabled(iso)) {
                    btn.setAttribute('data-disabled', 'true');
                    btn.disabled = true;
                }

                var rs = null;
                var re = null;
                if (start && end) {
                    rs = start;
                    re = end;
                } else if (start && hoverIso) {
                    rs = start < hoverIso ? start : hoverIso;
                    re = start < hoverIso ? hoverIso : start;
                } else if (start) {
                    rs = start;
                    re = start;
                }
                // La banda solo se dibuja cuando hay un tramo entre dos días distintos.
                if (rs && re && rs !== re && iso >= rs && iso <= re) {
                    btn.setAttribute('data-in-selection', 'true');
                }
                if (rs && iso === rs) {
                    btn.setAttribute('data-selection-start', 'true');
                    btn.setAttribute('data-selected', 'true');
                }
                if (re && iso === re && re !== rs) {
                    btn.setAttribute('data-selection-end', 'true');
                    btn.setAttribute('data-selected', 'true');
                }
                return btn;
            }

            /** Dibuja el mes visible. `dir` distinto de 0 desliza la rejilla (cambio de mes). */
            function render(dir) {
                root.textContent = '';

                var head = document.createElement('div');
                head.className = 'fa-rcal-head';

                var prev = document.createElement('button');
                prev.type = 'button';
                prev.className = 'fa-rcal-navbtn';
                prev.setAttribute('data-nav', '-1');
                prev.setAttribute('aria-label', 'Mes anterior');
                prev.appendChild(svgIcon(ICONS.chevronLeft, 17));
                if (monthIndex(view) <= monthIndex(startOfMonth(new Date()))) {
                    prev.disabled = true;
                }

                var title = document.createElement('span');
                title.className = 'fa-rcal-month';
                title.setAttribute('aria-live', 'polite');
                title.textContent = MESES_LARGO[view.getMonth()] + ' ' + view.getFullYear();

                var next = document.createElement('button');
                next.type = 'button';
                next.className = 'fa-rcal-navbtn';
                next.setAttribute('data-nav', '1');
                next.setAttribute('aria-label', 'Mes siguiente');
                next.appendChild(svgIcon(ICONS.chevronRight, 17));

                head.appendChild(prev);
                head.appendChild(title);
                head.appendChild(next);
                root.appendChild(head);

                var viewport = document.createElement('div');
                viewport.className = 'fa-rcal-viewport';

                var grid = document.createElement('div');
                grid.className = 'fa-rcal-grid';
                grid.setAttribute('role', 'grid');
                if (dir) {
                    grid.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
                }

                var week = document.createElement('div');
                week.className = 'fa-rcal-week';
                week.setAttribute('role', 'row');
                DIAS_CORTOS.forEach(function (dia, i) {
                    var wd = document.createElement('abbr');
                    wd.className = 'fa-rcal-wd';
                    wd.setAttribute('role', 'columnheader');
                    wd.setAttribute('aria-label', DIAS_LARGO[i]);
                    wd.textContent = dia;
                    week.appendChild(wd);
                });
                grid.appendChild(week);

                var hoy = todayIso();
                var first = startOfMonth(view);
                var offset = (first.getDay() + 6) % 7;   // semana empieza en lunes
                var cellStart = addDays(first, -offset);
                for (var w = 0; w < 6; w++) {
                    var row = document.createElement('div');
                    row.className = 'fa-rcal-row';
                    row.setAttribute('role', 'row');
                    for (var c = 0; c < 7; c++) {
                        row.appendChild(buildDay(addDays(cellStart, w * 7 + c), hoy));
                    }
                    grid.appendChild(row);
                }
                viewport.appendChild(grid);
                root.appendChild(viewport);
            }

            function selectIso(iso) {
                if (single) {
                    start = iso;
                    end = iso;
                    hoverIso = null;
                    render();
                    onChange(start, end);
                    return;
                }
                if (!start || end) {
                    start = iso;
                    end = null;
                } else if (iso < start) {
                    end = start;
                    start = iso;
                } else {
                    end = iso;
                }
                // No se permite un rango que cruce días ocupados.
                if (start && end && rangeHasReserved(start, end)) {
                    start = iso;
                    end = null;
                }
                // Recorte de seguridad (la ventana ya limita a maxSpan).
                if (start && end && diasEntre(start, end) > maxSpan) {
                    end = addDaysIso(start, maxSpan - 1);
                }
                hoverIso = null;
                render();
                onChange(start, end);
            }

            /** Lleva el foco a la fecha indicada, cambiando de mes si es necesario. */
            function focusIso(iso) {
                var d = parseIso(iso);
                if (!d) {
                    return;
                }
                if (monthIndex(d) !== monthIndex(view)) {
                    view = startOfMonth(d);
                    render();
                }
                var btns = root.querySelectorAll('.fa-rcal-day');
                var fallback = null;
                for (var i = 0; i < btns.length; i++) {
                    var b = btns[i];
                    if (b.disabled) { continue; }
                    if (b.getAttribute('data-iso') === iso) { b.focus(); return; }
                    if (!b.hasAttribute('data-outside') && !fallback) { fallback = b; }
                }
                if (fallback) { fallback.focus(); }
            }

            /** Avanza `delta` días saltando los días no disponibles. */
            function stepEnabled(fromIso, delta) {
                var dir = delta > 0 ? 1 : -1;
                var step = Math.abs(delta);
                var iso = fromIso;
                for (var i = 0; i < 60; i++) {
                    iso = addDaysIso(iso, dir * step);
                    if (!dayDisabled(iso)) { return iso; }
                }
                return iso;
            }

            function weekEdge(iso, dir) {
                var d = parseIso(iso);
                if (!d) { return iso; }
                var dow = (d.getDay() + 6) % 7;   // 0 = lunes
                return addDaysIso(iso, dir < 0 ? -dow : (6 - dow));
            }

            function shiftMonthIso(iso, delta) {
                var d = parseIso(iso);
                if (!d) { return iso; }
                var target = new Date(d.getFullYear(), d.getMonth() + delta, 1);
                var last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
                target.setDate(Math.min(d.getDate(), last));
                return toIso(target);
            }

            root.addEventListener('click', function (event) {
                var nav = event.target.closest ? event.target.closest('[data-nav]') : null;
                if (nav && root.contains(nav)) {
                    event.preventDefault();
                    if (nav.disabled) { return; }
                    var dir = parseInt(nav.getAttribute('data-nav'), 10);
                    view = addMonths(view, dir);
                    render(dir);
                    return;
                }
                var cell = event.target.closest ? event.target.closest('.fa-rcal-day') : null;
                if (!cell || cell.disabled) {
                    return;
                }
                event.preventDefault();
                selectIso(cell.getAttribute('data-iso'));
            });

            root.addEventListener('mouseover', function (event) {
                if (single || !start || end) { return; }
                var cell = event.target.closest ? event.target.closest('.fa-rcal-day') : null;
                if (!cell || cell.disabled) { return; }
                var iso = cell.getAttribute('data-iso');
                if (iso !== hoverIso) {
                    hoverIso = iso;
                    render();
                }
            });

            root.addEventListener('mouseleave', function () {
                if (hoverIso) {
                    hoverIso = null;
                    render();
                }
            });

            root.addEventListener('keydown', function (event) {
                var cell = event.target.closest ? event.target.closest('.fa-rcal-day') : null;
                if (!cell) { return; }
                var iso = cell.getAttribute('data-iso');
                var key = event.key;
                var target = null;
                if (key === 'Enter' || key === ' ') {
                    event.preventDefault();
                    cell.click();
                    return;
                } else if (key === 'ArrowLeft') { target = stepEnabled(iso, -1); }
                else if (key === 'ArrowRight') { target = stepEnabled(iso, 1); }
                else if (key === 'ArrowUp') { target = stepEnabled(iso, -7); }
                else if (key === 'ArrowDown') { target = stepEnabled(iso, 7); }
                else if (key === 'Home') { target = weekEdge(iso, -1); }
                else if (key === 'End') { target = weekEdge(iso, 1); }
                else if (key === 'PageUp') { target = shiftMonthIso(iso, -1); }
                else if (key === 'PageDown') { target = shiftMonthIso(iso, 1); }
                else { return; }
                event.preventDefault();
                if (target) { focusIso(target); }
            });

            render();

            return {
                el: root,
                getStart: function () { return start; },
                getEnd: function () { return end; },
                setRange: function (s, e) {
                    start = s || null;
                    end = e || null;
                    hoverIso = null;
                    if (start) {
                        var d = parseIso(start);
                        if (d) { view = startOfMonth(d); }
                    }
                    render();
                },
                clear: function () {
                    start = null;
                    end = null;
                    hoverIso = null;
                    render();
                },
                refresh: render,
                focus: function () { focusIso(start || todayIso()); },
                destroy: function () {
                    if (root.parentNode) { root.parentNode.removeChild(root); }
                }
            };
        }

        function updateDatesUI() {
            if (!els.calendarUse) {
                return;
            }
            var hasDates = !!(pendingStart && pendingEnd);
            // La hora solo se pide cuando ya hay un rango de fechas elegido.
            if (els.timeWrap) {
                els.timeWrap.hidden = !hasDates;
            }
            if (!hasDates && pendingTime) {
                pendingTime = '';
                if (els.eventTime) {
                    els.eventTime.value = '';
                }
                syncTimeQuick();
            }
            var dias = hasDates ? diasEntre(pendingStart, pendingEnd) : 0;
            var etiqueta = hasDates
                ? rangoCorto(pendingStart, pendingEnd) + ' · ' + dias + (dias === 1 ? ' día' : ' días')
                : '';
            if (hasDates && pendingTime) {
                etiqueta += ' · ' + pendingTime;
            }

            els.calendarUse.disabled = !hasDates || !pendingTime || isStreaming;
            if (els.calendarHint) {
                if (hasDates && !pendingTime) {
                    els.calendarHint.textContent = etiqueta + '. Elige la hora del evento.';
                    els.calendarHint.setAttribute('data-tone', 'warn');
                } else if (hasDates) {
                    els.calendarHint.textContent = etiqueta + '. Pulsa "Usar estas fechas".';
                    els.calendarHint.setAttribute('data-tone', 'ok');
                } else {
                    els.calendarHint.textContent = 'Elige desde y hasta. Máximo 7 días por alquiler.';
                    els.calendarHint.removeAttribute('data-tone');
                }
            }
        }

        function useDates() {
            if (isStreaming || !pendingStart || !pendingEnd) {
                return;
            }
            rememberDates(pendingStart, pendingEnd);
            trackAssistantEvent('assistant_dates_use', {
                dias: diasEntre(pendingStart, pendingEnd),
                conHora: !!pendingTime
            });
            closeSidePanel();
            var mensaje = 'Usa estas fechas para mi evento: ' + pendingStart + ' al ' + pendingEnd;
            if (pendingTime) {
                mensaje += ' (Hora del evento: ' + pendingTime + ')';
            }
            sendUserMessage(mensaje + '. Confirma la disponibilidad y cotiza lo que te pedí.');
        }

        /** Limpia las fechas y la hora de la vista sin tocar lo guardado para el checkout. */
        function resetDateState() {
            pendingStart = null;
            pendingEnd = null;
            pendingTime = '';
            lastProductIds = [];
            reservedRanges = [];
            if (datesCalendar) {
                datesCalendar.clear();
            }
            if (formFieldCal) {
                formFieldCal.clear();
            }
            if (els.eventTime) {
                els.eventTime.value = '';
            }
            syncTimeQuick();
            updateDatesUI();
        }

        function syncTimeQuick() {
            if (!els.timeQuick) {
                return;
            }
            var chips = els.timeQuick.querySelectorAll('[data-time]');
            for (var i = 0; i < chips.length; i++) {
                chips[i].setAttribute('aria-pressed',
                    chips[i].getAttribute('data-time') === pendingTime ? 'true' : 'false');
            }
        }

        function clearDates() {
            pendingStart = null;
            pendingEnd = null;
            pendingTime = '';
            if (datesCalendar) {
                datesCalendar.clear();
            }
            if (els.eventTime) {
                els.eventTime.value = '';
            }
            syncTimeQuick();
            try { localStorage.removeItem('furent_selected_dates'); } catch (e) { /* opcional */ }
            updateDatesUI();
        }

        function rememberDates(start, end) {
            try {
                localStorage.setItem('furent_selected_dates', JSON.stringify({ start: start, end: end }));
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
        }

        // ── Disponibilidad de días ocupados (solo autenticados) ──

        function rememberContextProduct(data) {
            if (!data) {
                return;
            }
            var id = data.id || data.productoId;
            if (!id || lastProductIds.indexOf(id) !== -1) {
                return;
            }
            lastProductIds.push(id);
            if (lastProductIds.length > 25) {
                lastProductIds = lastProductIds.slice(-25);
            }
        }

        function loadReservedDays() {
            var ids = lastProductIds.slice(0, 25);
            if (ids.length === 0) {
                return;
            }
            var key = ids.slice().sort().join(',');
            if (reservedCache[key]) {
                applyReserved(reservedCache[key]);
                return;
            }
            fetch('/api/productos/availability?ids=' + encodeURIComponent(ids.join(',')), {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            }).then(function (response) {
                if (!response.ok) {
                    throw new Error('availability ' + response.status);
                }
                return response.json();
            }).then(function (ranges) {
                var list = (ranges || []).map(function (r) {
                    return { from: r.start, to: r.end };
                });
                reservedCache[key] = list;
                applyReserved(list);
            }).catch(function () {
                if (els.calendarHint) {
                    els.calendarHint.textContent = 'No pudimos verificar los días ocupados; el asistente confirmará la disponibilidad.';
                    els.calendarHint.setAttribute('data-tone', 'warn');
                }
            });
        }

        function applyReserved(ranges) {
            reservedRanges = ranges || [];
            if (datesCalendar) {
                datesCalendar.refresh();
            }
            if (formFieldCal) {
                formFieldCal.refresh();
            }
        }

        function findReserved(iso) {
            for (var i = 0; i < reservedRanges.length; i++) {
                var r = reservedRanges[i];
                if (r && r.from && r.to && iso >= r.from && iso <= r.to) {
                    return true;
                }
            }
            return false;
        }

        // ── Utilidades de fecha ──

        function pad2(n) {
            return (n < 10 ? '0' : '') + n;
        }

        function toIso(date) {
            if (!date) {
                return null;
            }
            return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
        }

        function parseIso(iso) {
            var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
            if (!m) {
                return null;
            }
            return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        }

        function addDays(date, n) {
            var d = new Date(date.getTime());
            d.setDate(d.getDate() + n);
            return d;
        }

        function addDaysIso(iso, n) {
            var d = parseIso(iso);
            return d ? toIso(addDays(d, n)) : iso;
        }

        function diasEntre(startIso, endIso) {
            var a = parseIso(startIso);
            var b = parseIso(endIso);
            if (!a || !b) {
                return 0;
            }
            return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
        }

        function todayIso() {
            var now = new Date();
            return toIso(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        }

        function rangoCorto(start, end) {
            var a = parseIso(start);
            var b = parseIso(end);
            if (!a || !b) {
                return fmtFecha(start) + ' – ' + fmtFecha(end);
            }
            var da = a.getDate();
            var db = b.getDate();
            var ma = MESES[a.getMonth()];
            var mb = MESES[b.getMonth()];
            var yb = b.getFullYear();
            if (a.getFullYear() === yb && a.getMonth() === b.getMonth()) {
                return da + ' – ' + db + ' ' + mb + ' ' + yb;
            }
            return da + ' ' + ma + ' – ' + db + ' ' + mb + ' ' + yb;
        }

        // ───────────────────────── Bolsa y checkout ─────────────────────────

        function readBag() {
            var bag;
            try {
                bag = JSON.parse(localStorage.getItem(BAG_KEY) || '[]');
            } catch (e) {
                bag = [];
            }
            if (!Array.isArray(bag)) {
                bag = [];
            }
            return bag.filter(function (item) { return item && item.id; });
        }

        function writeBag(bag) {
            try {
                localStorage.setItem(BAG_KEY, JSON.stringify(bag || []));
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
            notifyBagChanged();
        }

        function readBagLines() {
            return readBag().map(function (item) {
                return {
                    id: item.id,
                    nombre: item.name || item.nombre || 'Producto',
                    cantidad: Math.max(1, parseInt(item.qty, 10) || 1),
                    precioDia: item.price != null ? item.price : item.precioDia
                };
            });
        }

        function addLinesToBag(items) {
            if (!items || items.length === 0) {
                return;
            }
            var bag = readBag();
            items.forEach(function (item) {
                var id = item.id;
                if (!id) {
                    return;
                }
                var qty = Math.max(1, parseInt(item.cantidad, 10) || 1);
                var existing = bag.find(function (entry) { return entry.id === id; });
                if (existing) {
                    existing.qty = (parseInt(existing.qty, 10) || 0) + qty;
                } else {
                    bag.push({
                        id: id,
                        name: item.nombre || item.name || 'Producto',
                        price: item.precioDia != null ? item.precioDia : item.price,
                        image: item.imagen || item.image || '',
                        qty: qty,
                        maxStock: item.stock || 0,
                        maxQty: 0
                    });
                }
            });
            writeBag(bag);
            toast('Productos agregados a tu bolsa', 'success');
            if (sideVista === 'bolsa') {
                renderBagPanel();
            }
        }

        function setBagFromLines(items) {
            if (!items || !items.length) {
                return;
            }
            var bag = [];
            items.forEach(function (item) {
                var id = item.id || item.productoId;
                if (!id) {
                    return;
                }
                bag.push({
                    id: id,
                    name: item.nombre || item.name || 'Producto',
                    price: item.precioDia != null ? item.precioDia : (item.price || 0),
                    image: item.imagen || item.image || '',
                    qty: Math.max(1, parseInt(item.cantidad, 10) || 1),
                    maxStock: item.stock || 0,
                    maxQty: 0
                });
            });
            writeBag(bag);
        }

        function changeBagQty(id, delta) {
            var bag = readBag();
            var entry = bag.find(function (b) { return b.id === id; });
            if (!entry) {
                return;
            }
            entry.qty = (parseInt(entry.qty, 10) || 0) + delta;
            if (entry.qty <= 0) {
                bag = bag.filter(function (b) { return b.id !== id; });
            }
            writeBag(bag);
        }

        function mergeBagFromServer(items) {
            var bag = readBag();
            items.forEach(function (item) {
                if (!item || !item.id) {
                    return;
                }
                var entry = bag.find(function (b) { return b.id === item.id; });
                if (entry) {
                    if (item.nombre) { entry.name = item.nombre; }
                    if (item.precioDia != null) { entry.price = item.precioDia; }
                    if (item.imagen) { entry.image = item.imagen; }
                    if (item.stock != null) { entry.maxStock = item.stock; }
                } else {
                    bag.push({
                        id: item.id,
                        name: item.nombre || 'Producto',
                        price: item.precioDia != null ? item.precioDia : 0,
                        image: item.imagen || '',
                        qty: Math.max(1, parseInt(item.cantidad, 10) || 1),
                        maxStock: item.stock || 0,
                        maxQty: 0
                    });
                }
            });
            try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch (e) { /* opcional */ }
        }

        function applyBagEvent(data) {
            if (!data) {
                return;
            }
            var op = data.operacion || 'agregar';
            var items = data.items || [];
            var bag = readBag();
            if (op === 'vaciar') {
                bag = [];
            } else if (op === 'quitar') {
                var ids = items.map(function (i) { return i.id; });
                bag = bag.filter(function (b) { return ids.indexOf(b.id) === -1; });
            } else if (op === 'cambiar_cantidad') {
                items.forEach(function (item) {
                    if (!item || !item.id) {
                        return;
                    }
                    var entry = bag.find(function (b) { return b.id === item.id; });
                    if (!entry) {
                        return;
                    }
                    var qty = parseInt(item.cantidad, 10);
                    if (qty <= 0) {
                        bag = bag.filter(function (b) { return b.id !== item.id; });
                    } else {
                        entry.qty = qty;
                    }
                });
            } else {
                items.forEach(function (item) {
                    if (!item || !item.id) {
                        return;
                    }
                    var qty = Math.max(1, parseInt(item.cantidad, 10) || 1);
                    var entry = bag.find(function (b) { return b.id === item.id; });
                    if (entry) {
                        entry.qty = (parseInt(entry.qty, 10) || 0) + qty;
                    } else {
                        bag.push({
                            id: item.id,
                            name: item.nombre || 'Producto',
                            price: item.precioDia != null ? item.precioDia : 0,
                            image: item.imagen || '',
                            qty: qty,
                            maxStock: item.stock || 0,
                            maxQty: 0
                        });
                    }
                });
            }
            writeBag(bag);
            toast(bagMessage(op), 'success');
            if (sideVista === 'bolsa') {
                renderBagPanel();
            }
        }

        function bagMessage(op) {
            if (op === 'vaciar') {
                return 'Bolsa vaciada';
            }
            if (op === 'quitar') {
                return 'Producto quitado de tu bolsa';
            }
            if (op === 'cambiar_cantidad') {
                return 'Cantidad actualizada';
            }
            return 'Productos agregados a tu bolsa';
        }

        function notifyBagChanged() {
            window.dispatchEvent(new CustomEvent('furent:bag-updated'));
            if (typeof window.updateBagUI === 'function') {
                try { window.updateBagUI(); } catch (e) { /* opcional */ }
            }
        }

        /**
         * Persiste los datos del evento que el asistente ya conoce y avisa al checkout abierto en
         * la misma pestaña para que se actualice en vivo. Así /cotizacion llega precargado sin
         * depender de qué botón pulse el usuario.
         */
        function persistirDatosEvento(datos) {
            if (!datos) {
                return;
            }
            var detalles;
            try {
                detalles = JSON.parse(localStorage.getItem('furent_event_details') || '{}') || {};
            } catch (e) {
                detalles = {};
            }
            var cambio = false;
            ['tipoEvento', 'invitados', 'direccion', 'horaEntrega', 'notas'].forEach(function (campo) {
                var valor = datos[campo];
                if (valor != null && valor !== '' && valor !== detalles[campo]) {
                    detalles[campo] = valor;
                    cambio = true;
                }
            });
            try {
                if (cambio || !localStorage.getItem('furent_event_details')) {
                    localStorage.setItem('furent_event_details', JSON.stringify(detalles));
                }
                if (datos.fechaInicio && datos.fechaFin) {
                    localStorage.setItem('furent_selected_dates', JSON.stringify({
                        start: datos.fechaInicio, end: datos.fechaFin
                    }));
                }
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
            var evento = Object.assign({}, detalles);
            if (datos.fechaInicio && datos.fechaFin) {
                evento.fechaInicio = datos.fechaInicio;
                evento.fechaFin = datos.fechaFin;
            }
            try {
                document.dispatchEvent(new CustomEvent('furent:evento-actualizado', { detail: evento }));
            } catch (e) { /* CustomEvent no soportado */ }
        }

        /**
         * Guarda las fechas y deja en la bolsa exactamente lo cotizado. Es idempotente: repetir la
         * acción no multiplica cantidades. Así /cotizacion llega precargada por el asistente.
         */
        function prepararReserva(data) {
            var items = (data && data.items) || [];
            var bag = readBag();
            items.forEach(function (item) {
                var id = item.id || item.productoId;
                if (!id) {
                    return;
                }
                var qty = Math.max(1, parseInt(item.cantidad, 10) || 1);
                var existing = bag.find(function (entry) { return entry.id === id; });
                if (existing) {
                    existing.qty = qty;
                } else {
                    bag.push({
                        id: id,
                        name: item.nombre || item.name || 'Producto',
                        price: item.precioDia != null ? item.precioDia : (item.price || 0),
                        image: item.imagen || item.image || '',
                        qty: qty,
                        maxStock: item.stock || 0,
                        maxQty: 0
                    });
                }
            });
            try {
                localStorage.setItem(BAG_KEY, JSON.stringify(bag));
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
            persistirDatosEvento(data);
            notifyBagChanged();
        }

        function goToCheckout(url) {
            var target = url || '/cotizacion';
            if (authenticated) {
                window.location.href = target;
            } else {
                window.location.href = '/login?redirect=' + encodeURIComponent(target);
            }
        }

        // ───────────────────────── Utilidades ─────────────────────────

        function toggleQuick() {
            if (!els.quick) {
                return;
            }
            var open = els.quick.hidden;
            els.quick.hidden = !open;
            if (els.plus) {
                els.plus.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            if (open) {
                collapseSuggestions();
            }
        }

        function collapseQuick() {
            if (els.quick && !els.quick.hidden) {
                els.quick.hidden = true;
            }
            if (els.plus) {
                els.plus.setAttribute('aria-expanded', 'false');
            }
        }

        function toggleSuggestions() {
            if (!els.chips) {
                return;
            }
            var open = els.chips.hidden;
            els.chips.hidden = !open;
            if (els.quickSuggest) {
                els.quickSuggest.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            if (open) {
                // Al desplegar las sugerencias, el menú "+" se cierra para no ocupar medio chat.
                collapseQuick();
            }
        }

        function collapseSuggestions() {
            if (els.chips && !els.chips.hidden) {
                els.chips.hidden = true;
            }
            if (els.quickSuggest) {
                els.quickSuggest.setAttribute('aria-expanded', 'false');
            }
        }

        /** Configuración de sugerencias y placeholder según la página actual. */
        function pageSuggestions() {
            var path = window.location.pathname || '/';
            for (var i = 0; i < PAGE_SUGGESTIONS.length; i++) {
                if (PAGE_SUGGESTIONS[i].match.test(path)) {
                    return PAGE_SUGGESTIONS[i];
                }
            }
            return PAGE_SUGGESTIONS_DEFAULT;
        }

        /** Reemplaza los chips estáticos por preguntas pensadas para esta página. */
        function renderSuggestions() {
            var config = pageSuggestions();
            if (els.input) {
                els.input.placeholder = config.placeholder || PAGE_SUGGESTIONS_DEFAULT.placeholder;
            }
            if (!els.chips) {
                return;
            }
            els.chips.textContent = '';
            (config.items || []).forEach(function (item) {
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'fa-chip';
                chip.setAttribute('data-prompt', item.prompt);
                chip.appendChild(svgIcon(ICONS.sparkles, 14));
                chip.appendChild(document.createTextNode(item.label));
                els.chips.appendChild(chip);
            });
        }

        function hideBadge() {
            if (els.badge) {
                els.badge.style.display = 'none';
            }
        }

        function scrollDown() {
            els.messages.scrollTop = els.messages.scrollHeight;
        }

        function shortId(id) {
            var value = String(id || '');
            return value.length > 8 ? value.slice(0, 8) : value;
        }

        function parseError(status, body) {
            var mensaje = 'No pude procesar tu solicitud.';
            var codigo = null;
            try {
                var parsed = JSON.parse(body);
                if (parsed) {
                    if (parsed.mensaje) {
                        mensaje = parsed.mensaje;
                    }
                    if (parsed.codigo) {
                        codigo = parsed.codigo;
                    }
                }
            } catch (e) {
                if (status === 401) {
                    mensaje = 'Inicia sesión o crea una cuenta para usar el asistente.';
                    codigo = 'AUTH_REQUIRED';
                } else if (status === 429) {
                    mensaje = 'El asistente está recibiendo muchas solicitudes ahora mismo. Espera unos segundos e intenta de nuevo.';
                } else if (status === 503) {
                    mensaje = 'El asistente está sobrecargado en este momento. Intenta de nuevo en unos segundos.';
                }
            }
            if (status === 401 && !codigo) {
                codigo = 'AUTH_REQUIRED';
            }
            return { mensaje: mensaje, codigo: codigo, status: status };
        }

        function formatCOP(value) {
            var number = Number(value || 0);
            try {
                return new Intl.NumberFormat('es-CO', {
                    style: 'currency', currency: 'COP', maximumFractionDigits: 0
                }).format(number);
            } catch (e) {
                return '$' + Math.round(number).toLocaleString('es-CO');
            }
        }

        function toast(message, type) {
            if (typeof window.showToast === 'function') {
                window.showToast({ message: message, type: type || 'success' });
            }
        }

        // ───────────────────────── Fechas, WhatsApp y medición ─────────────────────────

        function fmtFecha(iso) {
            var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
            if (!match) {
                return String(iso || '');
            }
            return parseInt(match[3], 10) + ' ' + MESES[parseInt(match[2], 10) - 1] + ' ' + match[1];
        }

        function whatsappUrl(text) {
            var number = state.whatsapp || DEFAULT_WHATSAPP;
            return 'https://wa.me/' + number + '?text=' + encodeURIComponent(text || '');
        }

        function abrirWhatsApp(text, origen) {
            trackAssistantEvent('assistant_whatsapp_click', { origen: origen || 'general' });
            window.open(whatsappUrl(text), '_blank');
        }

        function cotizacionTexto(data) {
            var lines = ['Hola Furent, quiero cotizar este mobiliario:'];
            (data.items || []).forEach(function (item) {
                lines.push('- ' + (item.nombre || 'Producto') + ' ×' + (item.cantidad || 0));
            });
            if (data.fechaInicio && data.fechaFin) {
                lines.push('Fechas: ' + fmtFecha(data.fechaInicio) + ' al ' + fmtFecha(data.fechaFin)
                    + (typeof data.dias === 'number' ? ' (' + data.dias + ' días)' : ''));
            } else if (typeof data.dias === 'number') {
                lines.push('Días: ' + data.dias);
            }
            if (typeof data.total === 'number') {
                lines.push('Total estimado: ' + formatCOP(data.total));
            }
            lines.push('¿Me ayudan a confirmar disponibilidad?');
            return lines.join('\n');
        }

        function trackAssistantEvent(name, payload) {
            var detail = { event: name, ts: Date.now() };
            if (payload) {
                Object.keys(payload).forEach(function (key) { detail[key] = payload[key]; });
            }
            try {
                window.dispatchEvent(new CustomEvent('furent:assistant-event', { detail: detail }));
            } catch (e) { /* CustomEvent no disponible */ }
            try {
                window.dataLayer = window.dataLayer || [];
                window.dataLayer.push({ event: name, assistant: detail });
            } catch (e) { /* opcional */ }
        }

        // ───────────────────────── Markdown seguro ─────────────────────────
        //
        // Parser mínimo que construye nodos de texto: el contenido del modelo nunca se inyecta
        // como HTML. Soporta negrita, itálica, resaltado (==texto==), código en línea, listas y
        // encabezados, con enlaces limitados a http(s), mailto, rutas relativas y anclas.

        function stripLeakedMarkup(text) {
            var out = String(text || '');
            out = out.replace(/<([a-zA-Z][\w:-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>/g, '');
            out = out.replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, '');
            out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            return out;
        }

        function renderMarkdown(container, text) {
            container.textContent = '';
            var lines = stripLeakedMarkup(text).replace(/\r\n?/g, '\n').split('\n');
            var i = 0;
            while (i < lines.length) {
                var line = lines[i];
                if (/^\s*$/.test(line)) {
                    i++;
                    continue;
                }
                var callout = line.match(/^\s*>\s*\[!([A-Za-zÁÉÍÓÚÑáéíóúñ]+)\]\s*(.*)$/);
                if (callout) {
                    var inner = [];
                    i++;
                    while (i < lines.length && /^\s*>/.test(lines[i])) {
                        inner.push(lines[i].replace(/^\s*>\s?/, ''));
                        i++;
                    }
                    container.appendChild(buildCallout(callout[1], callout[2].trim(), inner));
                    continue;
                }
                if (/^\s*[-*•]\s+/.test(line)) {
                    var ul = document.createElement('ul');
                    while (i < lines.length) {
                        var bullet = lines[i].match(/^\s*[-*•]\s+(.*)$/);
                        if (!bullet) {
                            break;
                        }
                        var li = document.createElement('li');
                        appendInline(li, bullet[1]);
                        ul.appendChild(li);
                        i++;
                    }
                    container.appendChild(ul);
                    continue;
                }
                if (/^\s*\d+[.)]\s+/.test(line)) {
                    var ol = document.createElement('ol');
                    while (i < lines.length) {
                        var ordered = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
                        if (!ordered) {
                            break;
                        }
                        var oli = document.createElement('li');
                        appendInline(oli, ordered[1]);
                        ol.appendChild(oli);
                        i++;
                    }
                    container.appendChild(ol);
                    continue;
                }
                var heading = line.match(/^\s*#{1,6}\s+(.*)$/);
                if (heading) {
                    var h = document.createElement('p');
                    h.className = 'fa-md-h';
                    appendInline(h, heading[1]);
                    container.appendChild(h);
                    i++;
                    continue;
                }
                var para = document.createElement('p');
                para.className = 'fa-md-p';
                var parte = 0;
                while (i < lines.length && !/^\s*$/.test(lines[i])
                        && !/^\s*[-*•]\s+/.test(lines[i])
                        && !/^\s*\d+[.)]\s+/.test(lines[i])
                        && !/^\s*#{1,6}\s+/.test(lines[i])
                        && !/^\s*>\s*\[!/.test(lines[i])) {
                    if (parte > 0) {
                        para.appendChild(document.createElement('br'));
                    }
                    appendInline(para, lines[i]);
                    parte++;
                    i++;
                }
                container.appendChild(para);
            }
        }

        // Englobes (callouts) para resaltar información importante. El modelo los escribe con la
        // sintaxis de alerta: "> [!TIPO]" y luego líneas "> contenido". Se aceptan varios alias.
        var CALLOUTS = {
            info: { cls: 'info', icon: 'info', title: 'Información' },
            dato: { cls: 'info', icon: 'info', title: 'Dato útil' },
            nota: { cls: 'info', icon: 'info', title: 'Nota' },
            idea: { cls: 'tip', icon: 'bulb', title: 'Idea' },
            tip: { cls: 'tip', icon: 'bulb', title: 'Idea' },
            consejo: { cls: 'tip', icon: 'bulb', title: 'Idea' },
            sugerencia: { cls: 'tip', icon: 'bulb', title: 'Idea' },
            precio: { cls: 'precio', icon: 'coin', title: 'Precio' },
            costo: { cls: 'precio', icon: 'coin', title: 'Precio' },
            total: { cls: 'precio', icon: 'coin', title: 'Precio' },
            price: { cls: 'precio', icon: 'coin', title: 'Precio' },
            fecha: { cls: 'fecha', icon: 'calendar', title: 'Fechas' },
            fechas: { cls: 'fecha', icon: 'calendar', title: 'Fechas' },
            hora: { cls: 'fecha', icon: 'calendar', title: 'Fechas' },
            date: { cls: 'fecha', icon: 'calendar', title: 'Fechas' },
            alerta: { cls: 'alerta', icon: 'alert', title: 'Importante' },
            importante: { cls: 'alerta', icon: 'alert', title: 'Importante' },
            atencion: { cls: 'alerta', icon: 'alert', title: 'Importante' },
            ojo: { cls: 'alerta', icon: 'alert', title: 'Importante' },
            warning: { cls: 'alerta', icon: 'alert', title: 'Importante' },
            exito: { cls: 'exito', icon: 'check', title: 'Listo' },
            listo: { cls: 'exito', icon: 'check', title: 'Listo' },
            hecho: { cls: 'exito', icon: 'check', title: 'Listo' },
            ok: { cls: 'exito', icon: 'check', title: 'Listo' }
        };

        function buildCallout(tipo, titulo, lineas) {
            var def = CALLOUTS[String(tipo || '').toLowerCase()] || CALLOUTS.info;
            var wrap = document.createElement('div');
            wrap.className = 'fa-callout fa-callout--' + def.cls;
            var ico = document.createElement('span');
            ico.className = 'fa-callout-ico';
            ico.appendChild(svgIcon(ICONS[def.icon], 17));
            var body = document.createElement('div');
            body.className = 'fa-callout-body';
            var head = document.createElement('p');
            head.className = 'fa-callout-title';
            head.textContent = titulo || def.title;
            body.appendChild(head);
            var content = document.createElement('div');
            content.className = 'fa-callout-content';
            renderMarkdown(content, lineas.join('\n'));
            body.appendChild(content);
            wrap.appendChild(ico);
            wrap.appendChild(body);
            return wrap;
        }

        function appendInline(container, text) {
            var str = String(text || '');
            var re = new RegExp(INLINE_RE.source, 'g');
            var last = 0;
            var match;
            while ((match = re.exec(str)) !== null) {
                if (match.index > last) {
                    container.appendChild(document.createTextNode(str.slice(last, match.index)));
                }
                container.appendChild(inlineNode(match[0]));
                last = match.index + match[0].length;
            }
            if (last < str.length) {
                container.appendChild(document.createTextNode(str.slice(last)));
            }
        }

        function inlineNode(token) {
            if (token.length > 4 && token.slice(0, 2) === '**' && token.slice(-2) === '**') {
                var strong = document.createElement('strong');
                appendInline(strong, token.slice(2, -2));
                return strong;
            }
            if (token.length > 4 && token.slice(0, 2) === '__' && token.slice(-2) === '__') {
                var strongAlt = document.createElement('strong');
                appendInline(strongAlt, token.slice(2, -2));
                return strongAlt;
            }
            if (token.length > 4 && token.slice(0, 2) === '==' && token.slice(-2) === '==') {
                var hl = document.createElement('span');
                hl.className = 'fa-hl';
                appendInline(hl, token.slice(2, -2));
                return hl;
            }
            if (token.charAt(0) === '`' && token.charAt(token.length - 1) === '`') {
                var code = document.createElement('code');
                code.className = 'fa-md-code';
                code.textContent = token.slice(1, -1);
                return code;
            }
            if (token.charAt(0) === '*') {
                var em = document.createElement('em');
                appendInline(em, token.slice(1, -1));
                return em;
            }
            if (token.charAt(0) === '_') {
                var emAlt = document.createElement('em');
                appendInline(emAlt, token.slice(1, -1));
                return emAlt;
            }
            if (token.charAt(0) === '[') {
                var close = token.indexOf('](');
                var label = token.slice(1, close);
                var url = token.slice(close + 2, -1);
                var safe = safeUrl(url);
                if (safe) {
                    var link = document.createElement('a');
                    link.className = 'fa-md-link';
                    link.href = safe;
                    link.rel = 'noopener noreferrer';
                    if (/^https?:/i.test(safe)) {
                        link.target = '_blank';
                    }
                    appendInline(link, label);
                    return link;
                }
                return document.createTextNode(label + ' (' + url + ')');
            }
            return document.createTextNode(token);
        }

        function safeUrl(url) {
            var value = String(url || '').trim();
            if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) {
                return value;
            }
            if (value.charAt(0) === '/' || value.charAt(0) === '#') {
                return value;
            }
            return null;
        }

        // Arranque: se difiere hasta aquí porque renderWelcome usa ICONS y boot usa varios
        // objetos (VIEWS, SIDE_TITLES) que se definen más abajo en este mismo ámbito.
        renderSuggestions();
        initDatePicker();
        start();
    }
})();
