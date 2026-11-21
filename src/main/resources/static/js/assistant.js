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
            viewFechas: document.getElementById('furent-assistant-view-fechas'),
            viewBolsa: document.getElementById('furent-assistant-view-bolsa'),
            viewReco: document.getElementById('furent-assistant-view-reco'),
            viewAlquiler: document.getElementById('furent-assistant-view-alquiler'),
            calendarHost: document.getElementById('furent-assistant-calendar-host'),
            datesInput: document.getElementById('furent-assistant-dates-input'),
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
        var listUrl = (els.history && els.history.getAttribute('data-list-url'))
            || '/api/asistente/conversations';
        var authenticated = panel.getAttribute('data-authenticated') === 'true';
        var DEFAULT_WHATSAPP = '573105782442';
        var headerAvatar = panel.querySelector('.fa-avatar img');
        var avatarSrc = headerAvatar ? headerAvatar.getAttribute('src') : '/images/furi.png';

        var state = { conversationId: null, whatsapp: null };
        var isOpen = false;
        var isStreaming = false;
        var currentBubble = null;
        var lastFocused = null;
        var lastUserText = '';
        var sideVista = null;
        var chatList = [];

        // Estado del calendario de fechas.
        var fp = null;                 // instancia de flatpickr (null si no está disponible)
        var formFp = null;             // flatpickr del rango de fechas del formulario
        var pendingStart = null;       // inicio elegido pero aún sin enviar (ISO y-m-d)
        var pendingEnd = null;         // fin elegido pero aún sin enviar (ISO y-m-d)
        var lastProductIds = [];       // ids de los productos mostrados, para consultar disponibilidad
        var reservedCache = {};        // { "ids": [{from,to}] } caché por conjunto de productos
        var reservedRanges = [];       // rangos ocupados vigentes para el contexto actual
        var nativeDates = false;       // true si se degradó a <input type="date">
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
            saveActiveId(null);
            closeSidePanel();
            resetDateState();
            updateHistoryActive();
            renderWelcome();
            scrollDown();
            loadChatList();
        }

        function renderWelcome() {
            appendNote('Este chat es temporal: se conserva 24 h. Soy un asistente con IA; '
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
            if (isStreaming) {
                return;
            }
            var text = (els.input.value || '').trim();
            if (!text) {
                return;
            }
            els.input.value = '';
            els.input.style.height = 'auto';
            sendUserMessage(text);
        }

        function sendUserMessage(text) {
            text = String(text || '').trim();
            if (!text || isStreaming) {
                return;
            }
            collapseSuggestions();
            collapseQuick();
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
                failReply(error && error.mensaje
                    ? error.mensaje
                    : 'No pude responder ahora mismo. Puedes intentar de nuevo o escribirnos por WhatsApp.');
                offerRetry(text);
                offerWhatsApp();
            }).finally(function () {
                isStreaming = false;
                els.send.disabled = false;
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
                    closePendingBubble();
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
            users: ['M16 19.5v-1.6a3.6 3.6 0 0 0-3.6-3.6H7.1a3.6 3.6 0 0 0-3.6 3.6v1.6',
                'M9.75 10.9a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z',
                'M20.5 19.5v-1.6a3.6 3.6 0 0 0-2.7-3.5',
                'M15.6 3.9a3.6 3.6 0 0 1 0 7'],
            coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
                'M14.6 9.3a2.7 2.7 0 0 0-2.6-1.4c-1.4 0-2.5.8-2.5 2 0 2.9 5.1 1.4 5.1 4.3 0 1.2-1.1 2-2.6 2a2.7 2.7 0 0 1-2.6-1.4',
                'M12 6.4v11.2'],
            pencil: ['M16.6 3.5a2.1 2.1 0 0 1 3 3L7 19.2l-4 1 1-4Z', 'M13.5 6.5l4 4'],
            chevron: ['m6 9.5 6 6 6-6'],
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
            fechas: function () { return els.viewFechas; },
            bolsa: function () { return els.viewBolsa; },
            recomendacion: function () { return els.viewReco; },
            alquiler: function () { return els.viewAlquiler; }
        };

        var SIDE_TITLES = {
            form: 'Cuéntame de tu evento',
            fechas: 'Fechas del alquiler',
            bolsa: 'Tu bolsa',
            recomendacion: 'Recomendación',
            alquiler: 'Tu alquiler'
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
                syncTimeQuick();
                updateDatesUI();
            } else if (vista === 'bolsa') {
                renderBagPanel(data && data.items);
            } else if (vista === 'form') {
                renderFormPanel(data && data.fields ? data : defaultFormData());
            } else if (vista === 'recomendacion') {
                renderRecommendation(data || {});
            } else if (vista === 'alquiler') {
                renderReservation(data || {});
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
                sendUserMessage('Datos de mi evento:\n' + lines.join('\n'));
            });

            view.appendChild(form);
        }

        /** Icono que acompaña a un campo del formulario. */
        function fieldIcon(field) {
            switch (field.name) {
                case 'tipoEvento': return ICONS.tag;
                case 'invitados': return ICONS.users;
                case 'estilo': return ICONS.pencil;
                case 'presupuesto': return ICONS.coin;
                case 'horaEvento': return ICONS.clock;
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
                    input.step = '900';
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
            minimalista: { icon: 'minimal', tone: 'slate' }
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
                openSelect = { control: control, menu: menu, trigger: trigger };
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

        /** Une los campos de fecha en un único flatpickr (rango), como en la pasarela. */
        function buildDateRangeField(dateFields, inputs) {
            var first = dateFields[0];
            var second = dateFields[1] || null;

            var wrap = document.createElement('label');
            wrap.className = 'fa-field';
            var head = document.createElement('span');
            head.className = 'fa-field-head';
            head.appendChild(svgIcon(ICONS.calendar, 14));
            var label = document.createElement('span');
            label.textContent = second ? 'Fechas del evento' : (first.label || 'Fecha');
            head.appendChild(label);
            wrap.appendChild(head);

            var control = document.createElement('div');
            control.className = 'fa-control has-ico has-action';
            var ico = document.createElement('span');
            ico.className = 'fa-control-ico';
            ico.appendChild(svgIcon(ICONS.calendar, 16));
            control.appendChild(ico);

            var input = document.createElement('input');
            input.type = 'text';
            input.readOnly = true;
            input.autocomplete = 'off';
            input.placeholder = second ? 'Selecciona el rango de fechas...' : 'Selecciona una fecha...';
            control.appendChild(input);

            var hiddenStart = hiddenInput(first.name);
            inputs[first.name] = hiddenStart;
            control.appendChild(hiddenStart);
            var hiddenEnd = null;
            if (second) {
                hiddenEnd = hiddenInput(second.name);
                inputs[second.name] = hiddenEnd;
                control.appendChild(hiddenEnd);
            }

            var clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'fa-control-action';
            clear.setAttribute('aria-label', 'Limpiar fechas');
            clear.setAttribute('title', 'Limpiar fechas');
            clear.appendChild(svgIcon(ICONS.eraser, 16));
            clear.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                if (formFp && typeof formFp.clear === 'function') {
                    formFp.clear();
                }
            });
            control.appendChild(clear);

            wrap.appendChild(control);

            if (typeof window.flatpickr === 'function') {
                try {
                    formFp = window.flatpickr(input, {
                        locale: 'es',
                        mode: second ? 'range' : 'single',
                        minDate: 'today',
                        dateFormat: 'Y-m-d',
                        altInput: true,
                        altFormat: 'j \\de M, Y',
                        disableMobile: true,
                        onReady: function (d, s, instance) {
                            instance.calendarContainer.classList.add('fa-fp');
                        },
                        onChange: function (dates) {
                            hiddenStart.value = dates[0] ? toIso(dates[0]) : '';
                            if (hiddenEnd) {
                                hiddenEnd.value = dates.length > 1 ? toIso(dates[dates.length - 1]) : '';
                            }
                            control.classList.toggle('has-value', dates.length > 0);
                        }
                    });
                } catch (e) {
                    formFp = null;
                }
            }
            return wrap;
        }

        function hiddenInput(name) {
            var input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            return input;
        }

        function destroyFormFp() {
            if (formFp && typeof formFp.destroy === 'function') {
                try { formFp.destroy(); } catch (e) { /* opcional */ }
            }
            formFp = null;
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
                box.className = 'fa-quote';
                box.style.marginBottom = '10px';
                var title = document.createElement('h4');
                title.textContent = '#' + shortId(r.id);
                box.appendChild(title);
                var meta = document.createElement('p');
                meta.className = 'fa-quote-dates';
                meta.textContent = (r.estado || '') + ' · ' + rangoDeReserva(r);
                box.appendChild(meta);
                if (r.total != null) {
                    box.appendChild(quoteLine('Total', formatCOP(r.total)));
                }
                view.appendChild(box);
            });
        }

        function renderReservationDetail(view, r) {
            var title = document.createElement('p');
            title.className = 'fa-panel-title';
            title.textContent = 'Alquiler #' + shortId(r.id);
            view.appendChild(title);

            var sub = document.createElement('p');
            sub.className = 'fa-panel-sub';
            sub.textContent = (r.estado || '') + ' · ' + rangoDeReserva(r);
            view.appendChild(sub);

            var meta = document.createElement('div');
            meta.className = 'fa-quote';
            meta.appendChild(quoteLine('Total', formatCOP(r.total)));
            meta.appendChild(quoteLine('Pagado', formatCOP(r.montoAbonado)));
            meta.appendChild(quoteLine('Saldo', formatCOP(r.saldoPendiente)));
            if (r.estadoPago) {
                meta.appendChild(quoteLine('Estado de pago', String(r.estadoPago)));
            }
            view.appendChild(meta);

            if (r.items && r.items.length) {
                var itemsTitle = document.createElement('p');
                itemsTitle.className = 'fa-panel-title';
                itemsTitle.style.marginTop = '12px';
                itemsTitle.textContent = 'Muebles solicitados';
                view.appendChild(itemsTitle);
                r.items.forEach(function (item) {
                    view.appendChild(quoteLine((item.nombre || 'Producto') + ' ×' + (item.cantidad || 0), ''));
                });
            }

            if (r.timeline && r.timeline.length) {
                var tlTitle = document.createElement('p');
                tlTitle.className = 'fa-panel-title';
                tlTitle.style.marginTop = '12px';
                tlTitle.textContent = 'Estado del pedido';
                view.appendChild(tlTitle);
                view.appendChild(buildTimeline(r.timeline));
            }

            if (r.pagos && r.pagos.length) {
                var payTitle = document.createElement('p');
                payTitle.className = 'fa-panel-title';
                payTitle.style.marginTop = '12px';
                payTitle.textContent = 'Pagos registrados';
                view.appendChild(payTitle);
                r.pagos.forEach(function (pago) {
                    view.appendChild(quoteLine(
                        (pago.tipo || 'Pago') + (pago.fecha ? ' · ' + fmtFecha(pago.fecha.slice(0, 10)) : ''),
                        formatCOP(pago.monto)
                    ));
                });
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
            if (!els.datesInput || !els.calendarUse) {
                return;
            }
            if (els.calendarClear) {
                els.calendarClear.addEventListener('click', clearDates);
            }
            els.calendarUse.addEventListener('click', useDates);

            if (typeof window.flatpickr === 'function') {
                try {
                    fp = window.flatpickr(els.datesInput, {
                        locale: 'es',
                        mode: 'range',
                        inline: true,
                        minDate: 'today',
                        dateFormat: 'Y-m-d',
                        showMonths: 1,
                        disableMobile: true,
                        onReady: function (dObj, dStr, instance) {
                            instance.calendarContainer.classList.add('fa-fp');
                        },
                        onChange: onDatesChange,
                        onDayCreate: function (dObj, dStr, instance, dayElem) {
                            markReserved(dayElem);
                        }
                    });
                } catch (e) {
                    fp = null;
                }
            }
            if (!fp) {
                nativeDates = true;
                buildNativeFallback();
            }
            syncTimeQuick();
            updateDatesUI();
        }

        function buildNativeFallback() {
            if (!els.calendarHost) {
                return;
            }
            els.calendarHost.textContent = '';
            var wrap = document.createElement('div');
            wrap.className = 'fa-native-dates';

            var startField = nativeField('Desde', 'furent-assistant-native-start');
            var endField = nativeField('Hasta', 'furent-assistant-native-end');
            wrap.appendChild(startField.wrap);
            wrap.appendChild(endField.wrap);
            els.calendarHost.appendChild(wrap);
            els._nativeStart = startField.input;
            els._nativeEnd = endField.input;

            function sync() {
                var start = startField.input.value;
                var end = endField.input.value;
                if (start && end && diasEntre(start, end) > 7) {
                    end = addDaysIso(start, 6);
                    endField.input.value = end;
                }
                pendingStart = start || null;
                pendingEnd = end || null;
                updateDatesUI();
            }
            startField.input.addEventListener('change', sync);
            endField.input.addEventListener('change', sync);
        }

        function nativeField(label, id) {
            var wrap = document.createElement('label');
            wrap.className = 'fa-native-field';
            wrap.setAttribute('for', id);
            wrap.appendChild(document.createTextNode(label));
            var input = document.createElement('input');
            input.type = 'date';
            input.id = id;
            input.min = todayIso();
            wrap.appendChild(input);
            return { wrap: wrap, input: input };
        }

        function onDatesChange(selectedDates) {
            if (!selectedDates || selectedDates.length === 0) {
                pendingStart = null;
                pendingEnd = null;
                updateDatesUI();
                return;
            }
            pendingStart = toIso(selectedDates[0]);
            pendingEnd = selectedDates.length > 1 ? toIso(selectedDates[selectedDates.length - 1]) : null;

            if (pendingStart && pendingEnd && diasEntre(pendingStart, pendingEnd) > 7) {
                pendingEnd = addDaysIso(pendingStart, 6);
                if (fp && typeof fp.setDate === 'function') {
                    fp.setDate([pendingStart, pendingEnd], false);
                }
            }
            updateDatesUI();
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
            if (fp && typeof fp.clear === 'function') {
                try { fp.clear(false); } catch (e) { /* opcional */ }
            }
            if (fp && typeof fp.set === 'function') {
                try { fp.set('disable', []); } catch (e) { /* opcional */ }
            }
            if (els._nativeStart) {
                els._nativeStart.value = '';
            }
            if (els._nativeEnd) {
                els._nativeEnd.value = '';
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
            if (fp && typeof fp.clear === 'function') {
                try { fp.clear(false); } catch (e) { /* opcional */ }
            }
            if (els._nativeStart) {
                els._nativeStart.value = '';
            }
            if (els._nativeEnd) {
                els._nativeEnd.value = '';
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
            if (fp && typeof fp.set === 'function') {
                try { fp.set('disable', reservedRanges); } catch (e) { /* opcional */ }
            }
            if (els.calendarHost) {
                var days = els.calendarHost.querySelectorAll('.flatpickr-day');
                for (var i = 0; i < days.length; i++) {
                    markReserved(days[i]);
                }
            }
        }

        function markReserved(dayElem) {
            if (!dayElem || !dayElem.dateObj) {
                return;
            }
            if (findReserved(toIso(dayElem.dateObj))) {
                dayElem.classList.add('is-reserved');
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
                if (data && data.fechaInicio && data.fechaFin) {
                    localStorage.setItem('furent_selected_dates', JSON.stringify({
                        start: data.fechaInicio,
                        end: data.fechaFin
                    }));
                }
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
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
            try {
                var parsed = JSON.parse(body);
                if (parsed && parsed.mensaje) {
                    mensaje = parsed.mensaje;
                }
            } catch (e) {
                if (status === 429) {
                    mensaje = 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.';
                } else if (status === 503) {
                    mensaje = 'El asistente no está disponible en este momento.';
                }
            }
            return { mensaje: mensaje };
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
