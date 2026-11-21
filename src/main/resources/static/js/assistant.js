/**
 * Widget del asistente virtual de Furent.
 *
 * - Habla con POST /api/asistente/chat y consume el stream SSE con fetch + ReadableStream.
 * - Renderiza todo con textContent/createElement: el texto del modelo nunca se inyecta como HTML.
 * - Markdown mínimo (negrita, itálica, resaltado ==texto==, listas y enlaces) con nodos seguros.
 * - El historial de chats vive en el servidor: al cargar siempre se empieza un chat nuevo y el
 *   botón "Mis chats" (izquierda) lista las conversaciones propias para abrir o borrar.
 * - Las entradas estructuradas (formulario de evento, calendario de fechas, bolsa y seguimiento
 *   del alquiler) se muestran en el panel lateral izquierdo del chat.
 * - Integra cotizaciones con la bolsa (`furent_bag`) y el checkout de la web.
 */
(function () {
    'use strict';

    var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
        'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    var BAG_KEY = 'furent_bag';

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
            historyToggle: document.getElementById('furent-assistant-history-toggle'),
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
        var avatarSrc = headerAvatar ? headerAvatar.getAttribute('src') : '/images/furent-logo.png';

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
        var pendingStart = null;       // inicio elegido pero aún sin enviar (ISO y-m-d)
        var pendingEnd = null;         // fin elegido pero aún sin enviar (ISO y-m-d)
        var lastProductIds = [];       // ids de los productos mostrados, para consultar disponibilidad
        var reservedCache = {};        // { "ids": [{from,to}] } caché por conjunto de productos
        var reservedRanges = [];       // rangos ocupados vigentes para el contexto actual
        var nativeDates = false;       // true si se degradó a <input type="date">

        els.launcher.addEventListener('click', openPanel);
        els.close.addEventListener('click', closePanel);
        els.send.addEventListener('click', function () { submitFromInput(); });
        els.input.addEventListener('keydown', function (event) {
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
        if (els.sideClose) {
            els.sideClose.addEventListener('click', function () { closeSidePanel(); collapseQuick(); });
        }

        els.chips.addEventListener('click', function (event) {
            var chip = event.target.closest('.fa-chip');
            if (chip && chip.getAttribute('data-prompt')) {
                collapseSuggestions();
                collapseQuick();
                sendUserMessage(chip.getAttribute('data-prompt'));
            }
        });

        if (els.historyToggle) {
            els.historyToggle.addEventListener('click', function () {
                if (els.history && !els.history.hidden) {
                    closeHistory();
                } else {
                    openHistory();
                }
            });
        }
        if (els.historyClose) {
            els.historyClose.addEventListener('click', closeHistory);
        }
        if (els.historyNew) {
            els.historyNew.addEventListener('click', newChat);
        }

        document.addEventListener('click', function (event) {
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
                if (els.history && !els.history.hidden) {
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
            closeSidePanel();
            updateHistoryActive();
            renderWelcome();
            scrollDown();
            loadChatList();
        }

        function renderWelcome() {
            appendAssistantBubble('Hola, soy Furi. ¿En qué puedo ayudarte?', true);
            appendNote('Este chat es temporal: se conserva 24 h. Soy un asistente con IA; '
                + 'confirma precios y disponibilidad antes de reservar.');
            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            row.style.flexWrap = 'wrap';
            row.appendChild(button('Organizar mi evento', 'fa-btn-primary', function () {
                openSidePanel('form', defaultFormData());
            }, ICONS.sparkles));
            row.appendChild(button('Elegir fechas', 'fa-btn-ghost', function () {
                openSidePanel('fechas');
            }, ICONS.calendar));
            els.messages.appendChild(row);
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
            if (lastFocused && typeof lastFocused.focus === 'function') {
                lastFocused.focus();
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
            els.messages.appendChild(built.row);
            currentBubble = built.bubble;
            currentBubble._textSpan = null;
            currentBubble._raw = '';
            scrollDown();
        }

        function textSpanOf(bubble) {
            if (!bubble._textSpan) {
                bubble.textContent = '';
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
            receipt: ['M6.75 3.75h10.5A1.5 1.5 0 0 1 18.75 5.25v13.9l-2.6-1.5-2.6 1.5-2.6-1.5-2.6 1.5V5.25A1.5 1.5 0 0 1 6.75 3.75Z',
                'M9.5 8.5h5M9.5 12h3.5'],
            sparkles: ['M12 3.5l1.7 4.55L18.25 9.75l-4.55 1.7L12 16l-1.7-4.55L5.75 9.75l4.55-1.7L12 3.5Z',
                'M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z'],
            trash: ['M4.5 6.75h15M9.75 6.75V5.25A1.5 1.5 0 0 1 11.25 3.75h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5M6.75 6.75l.75 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l.75-12']
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
                    { name: 'nota', label: 'Nota (opcional)', type: 'textarea', placeholder: 'Ej: colores, temática, requerimientos especiales' }
                ]
            };
        }

        function renderFormPanel(data) {
            var view = els.viewForm;
            if (!view) {
                return;
            }
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
            (data.fields || []).forEach(function (field) {
                var wrap = document.createElement('label');
                wrap.className = 'fa-field';
                var labelText = document.createElement('span');
                labelText.textContent = field.label || field.name;
                if (field.required) {
                    var req = document.createElement('span');
                    req.className = 'fa-field-req';
                    req.textContent = ' *';
                    labelText.appendChild(req);
                }
                wrap.appendChild(labelText);

                var input;
                if (field.type === 'select') {
                    input = document.createElement('select');
                    var placeholder = document.createElement('option');
                    placeholder.value = '';
                    placeholder.textContent = 'Selecciona...';
                    input.appendChild(placeholder);
                    (field.options || []).forEach(function (opt) {
                        var option = document.createElement('option');
                        option.value = opt.value != null ? opt.value : opt;
                        option.textContent = opt.label != null ? opt.label : opt;
                        input.appendChild(option);
                    });
                } else if (field.type === 'textarea') {
                    input = document.createElement('textarea');
                    input.rows = 3;
                    if (field.placeholder) {
                        input.placeholder = field.placeholder;
                    }
                } else {
                    input = document.createElement('input');
                    input.type = field.type === 'number' ? 'number' : (field.type === 'date' ? 'date' : 'text');
                    if (field.type === 'number') {
                        input.min = '0';
                    }
                    if (field.type === 'date') {
                        input.min = todayIso();
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
                wrap.appendChild(input);
                form.appendChild(wrap);
            });

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
                    deleteConversation(conversation.conversationId);
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

        function openConversation(id) {
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
                openPanel();
                updateHistoryActive();
                window.setTimeout(scrollDown, 40);
            }).catch(function () {
                toast('No se pudo abrir ese chat', 'error');
            });
        }

        function deleteConversation(id) {
            if (!id || !window.confirm('¿Eliminar este chat? Esta acción no se puede deshacer.')) {
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
            if (els.historyToggle) {
                els.historyToggle.setAttribute('aria-expanded', 'true');
            }
            loadChatList();
        }

        function closeHistory() {
            if (!els.history) {
                return;
            }
            els.history.hidden = true;
            if (els.historyToggle) {
                els.historyToggle.setAttribute('aria-expanded', 'false');
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
            readSavedDates();
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
            var dias = hasDates ? diasEntre(pendingStart, pendingEnd) : 0;
            var etiqueta = hasDates
                ? rangoCorto(pendingStart, pendingEnd) + ' · ' + dias + (dias === 1 ? ' día' : ' días')
                : '';

            els.calendarUse.disabled = !hasDates || isStreaming;
            if (els.calendarHint) {
                if (hasDates) {
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
                dias: diasEntre(pendingStart, pendingEnd)
            });
            closeSidePanel();
            sendUserMessage('Usa estas fechas para mi evento: ' + pendingStart + ' al ' + pendingEnd
                + '. Confirma la disponibilidad y cotiza lo que te pedí.');
        }

        function clearDates() {
            pendingStart = null;
            pendingEnd = null;
            if (fp && typeof fp.clear === 'function') {
                try { fp.clear(false); } catch (e) { /* opcional */ }
            }
            if (els._nativeStart) {
                els._nativeStart.value = '';
            }
            if (els._nativeEnd) {
                els._nativeEnd.value = '';
            }
            try { localStorage.removeItem('furent_selected_dates'); } catch (e) { /* opcional */ }
            updateDatesUI();
        }

        function rememberDates(start, end) {
            try {
                localStorage.setItem('furent_selected_dates', JSON.stringify({ start: start, end: end }));
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
        }

        function readSavedDates() {
            var saved = null;
            try {
                saved = JSON.parse(localStorage.getItem('furent_selected_dates') || 'null');
            } catch (e) {
                saved = null;
            }
            if (!saved || !/^\d{4}-\d{2}-\d{2}$/.test(String(saved.start || ''))
                    || !/^\d{4}-\d{2}-\d{2}$/.test(String(saved.end || ''))) {
                return;
            }
            var dias = diasEntre(saved.start, saved.end);
            if (dias < 1 || dias > 7 || saved.start < todayIso()) {
                return;
            }
            pendingStart = saved.start;
            pendingEnd = saved.end;
            if (fp && typeof fp.setDate === 'function') {
                try { fp.setDate([pendingStart, pendingEnd], false); } catch (e) { /* opcional */ }
            }
            if (els._nativeStart) {
                els._nativeStart.value = pendingStart;
            }
            if (els._nativeEnd) {
                els._nativeEnd.value = pendingEnd;
            }
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
        }

        function collapseSuggestions() {
            if (els.chips && !els.chips.hidden) {
                els.chips.hidden = true;
            }
            if (els.quickSuggest) {
                els.quickSuggest.setAttribute('aria-expanded', 'false');
            }
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
                        && !/^\s*#{1,6}\s+/.test(lines[i])) {
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
        initDatePicker();
        boot();
    }
})();
