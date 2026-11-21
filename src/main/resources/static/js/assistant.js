/**
 * Widget del asistente virtual de Furent.
 *
 * - Habla con POST /api/asistente/chat y consume el stream SSE con fetch + ReadableStream.
 * - Renderiza todo con textContent/createElement: el texto del modelo nunca se inyecta como HTML.
 * - Un Markdown mínimo (negrita, itálica, listas y enlaces) se renderiza con nodos seguros al
 *   terminar cada respuesta; durante el streaming se ve el texto plano con el cursor.
 * - Guarda el conversationId y el texto de la conversación en localStorage para restaurar el hilo.
 * - Integra cotizaciones con la bolsa (`furent_bag`) y el checkout de la web, y ofrece una ruta
 *   de conversión según el usuario: invitado → WhatsApp; autenticado → checkout.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'furent_assistant_state_v1';
    var MAX_RESTORE = 60;
    var MAX_STORED_MESSAGES = 40;
    var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
        'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

    // Tokens de Markdown inline. Vive en el ámbito del módulo porque `renderRestored()` (que se
    // ejecuta al iniciar) también renderiza Markdown, antes de que se declaren los `var` de `init`.
    var INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

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
            chips: document.getElementById('furent-assistant-chips'),
            badge: document.getElementById('furent-assistant-badge'),
            datesPill: document.getElementById('furent-assistant-dates-pill'),
            datesLabel: document.getElementById('furent-assistant-dates-label'),
            calendar: document.getElementById('furent-assistant-calendar'),
            calendarHost: document.getElementById('furent-assistant-calendar-host'),
            datesInput: document.getElementById('furent-assistant-dates-input'),
            calendarClear: document.getElementById('furent-assistant-calendar-clear'),
            calendarUse: document.getElementById('furent-assistant-calendar-use'),
            calendarHint: document.getElementById('furent-assistant-calendar-hint')
        };

        var chatUrl = panel.getAttribute('data-chat-url') || '/api/asistente/chat';
        var authenticated = panel.getAttribute('data-authenticated') === 'true';
        var state = loadState();
        var isOpen = false;
        var isStreaming = false;
        var currentBubble = null;
        var lastFocused = null;
        var lastUserText = '';
        var DEFAULT_WHATSAPP = '573105782442';

        // Estado del calendario de fechas.
        var fp = null;                 // instancia de flatpickr (null si no está disponible)
        var pendingStart = null;       // inicio elegido pero aún sin enviar (ISO y-m-d)
        var pendingEnd = null;         // fin elegido pero aún sin enviar (ISO y-m-d)
        var lastProductIds = [];       // ids de los productos mostrados, para consultar disponibilidad
        var reservedCache = {};        // { "ids": [{from,to}] } caché por conjunto de productos
        var reservedRanges = [];       // rangos ocupados vigentes para el contexto actual
        var nativeDates = false;       // true si se degradó a <input type="date">

        initDatePicker();

        renderRestored();

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
        els.chips.addEventListener('click', function (event) {
            var chip = event.target.closest('.fa-chip');
            if (chip && chip.getAttribute('data-prompt')) {
                els.input.value = chip.getAttribute('data-prompt');
                submitFromInput();
            }
        });

        document.addEventListener('keydown', function (event) {
            if (!isOpen) {
                return;
            }
            if (event.key === 'Escape') {
                closePanel();
            } else if (event.key === 'Tab') {
                trapFocus(event);
            }
        });

        // ───────────────────────── Panel ─────────────────────────

        function openPanel() {
            if (isOpen) {
                return;
            }
            lastFocused = document.activeElement;
            els.panel.hidden = false;
            els.launcher.hidden = true;
            els.launcher.setAttribute('aria-expanded', 'true');
            hideBadge();
            isOpen = true;
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
            if (lastFocused && typeof lastFocused.focus === 'function') {
                lastFocused.focus();
            }
        }

        function trapFocus(event) {
            var focusable = els.panel.querySelectorAll(
                'button, [href], textarea, input, [tabindex]:not([tabindex="-1"])');
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
            hideChips();
            appendUserBubble(text, true);
            rememberMessage('USER', text);
            lastUserText = text;
            streamChat(text);
        }

        function streamChat(text) {
            isStreaming = true;
            els.send.disabled = true;
            beginAssistantReply();

            var payload = { message: text, pageContext: window.location.pathname };
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
                        saveState();
                    }
                    if (data && data.whatsapp) {
                        state.whatsapp = String(data.whatsapp);
                        saveState();
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

        function beginAssistantReply() {
            var row = document.createElement('div');
            row.className = 'fa-row fa-enter';
            row.setAttribute('data-pending', 'true');
            var bubble = document.createElement('div');
            bubble.className = 'fa-bubble assistant';
            var typing = document.createElement('span');
            typing.className = 'fa-typing';
            typing.appendChild(document.createElement('span'));
            typing.appendChild(document.createElement('span'));
            typing.appendChild(document.createElement('span'));
            bubble.appendChild(typing);
            row.appendChild(bubble);
            els.messages.appendChild(row);
            currentBubble = bubble;
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
                // Las burbujas de error se conservan: su texto va en un nodo suelto, no en el
                // span incremental, así que no deben tratarse como una respuesta vacía.
                if (currentBubble.classList.contains('error')) {
                    currentBubble.parentNode.removeAttribute('data-pending');
                    currentBubble = null;
                    return;
                }
                var raw = currentBubble._raw || '';
                if (!raw) {
                    var row = currentBubble.parentNode;
                    if (row) {
                        row.remove();
                    }
                } else {
                    // El Markdown solo se compone al cerrar la burbuja: así no se muestran
                    // etiquetas a medias mientras llegan los tokens.
                    renderMarkdown(currentBubble, raw);
                    currentBubble.parentNode.removeAttribute('data-pending');
                    rememberMessage('ASSISTANT', raw);
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
                    }], { silentTotal: true });
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
                'M9.5 8.5h5M9.5 12h3.5']
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

        // ───────────────────────── Fechas / calendario ─────────────────────────
        //
        // El compositor ofrece un calendario de rango (flatpickr inline). Al elegir un rango de
        // 1 a 7 días se guarda en `furent_selected_dates` y se envía al asistente como un mensaje
        // con las fechas ISO, para que confirme disponibilidad y cotice. Para usuarios
        // autenticados se marcan los días ocupados reutilizando /api/productos/availability.

        function initDatePicker() {
            if (!els.calendar || !els.datesPill || !els.datesInput) {
                return;
            }
            els.datesPill.addEventListener('click', toggleCalendar);
            if (els.calendarClear) {
                els.calendarClear.addEventListener('click', clearDates);
            }
            if (els.calendarUse) {
                els.calendarUse.addEventListener('click', useDates);
            }

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

        function toggleCalendar() {
            if (!els.calendar) {
                return;
            }
            if (els.calendar.hidden) {
                openCalendar();
            } else {
                closeCalendar();
            }
        }

        function openCalendar() {
            els.calendar.hidden = false;
            els.datesPill.setAttribute('aria-expanded', 'true');
            if (authenticated) {
                loadReservedDays();
            }
        }

        function closeCalendar() {
            if (!els.calendar) {
                return;
            }
            els.calendar.hidden = true;
            els.datesPill.setAttribute('aria-expanded', 'false');
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
            var hasDates = !!(pendingStart && pendingEnd);
            var dias = hasDates ? diasEntre(pendingStart, pendingEnd) : 0;
            var etiqueta = hasDates
                ? rangoCorto(pendingStart, pendingEnd) + ' · ' + dias + (dias === 1 ? ' día' : ' días')
                : 'Elegir fechas';

            if (els.datesLabel) {
                els.datesLabel.textContent = etiqueta;
            }
            if (els.datesPill) {
                els.datesPill.setAttribute('data-active', hasDates ? 'true' : 'false');
            }
            if (els.calendarUse) {
                els.calendarUse.disabled = !hasDates || isStreaming;
            }
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
            closeCalendar();
            trackAssistantEvent('assistant_dates_use', {
                dias: diasEntre(pendingStart, pendingEnd)
            });
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

        function addLinesToBag(items) {
            if (!items || items.length === 0) {
                return;
            }
            var bag;
            try {
                bag = JSON.parse(localStorage.getItem('furent_bag') || '[]');
            } catch (e) {
                bag = [];
            }
            if (!Array.isArray(bag)) {
                bag = [];
            }
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
            localStorage.setItem('furent_bag', JSON.stringify(bag));
            notifyBagChanged();
            toast('Productos agregados a tu bolsa', 'success');
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
            var bag;
            try {
                bag = JSON.parse(localStorage.getItem('furent_bag') || '[]');
            } catch (e) {
                bag = [];
            }
            if (!Array.isArray(bag)) {
                bag = [];
            }
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
                localStorage.setItem('furent_bag', JSON.stringify(bag));
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

        function hideChips() {
            if (els.chips) {
                els.chips.style.display = 'none';
            }
        }

        function hideBadge() {
            if (els.badge) {
                els.badge.style.display = 'none';
            }
        }

        function showBadge() {
            if (els.badge) {
                els.badge.style.display = 'inline-flex';
            }
        }

        function scrollDown() {
            els.messages.scrollTop = els.messages.scrollHeight;
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
        // como HTML. Soporta negrita, itálica, código en línea, listas y encabezados, con enlaces
        // limitados a http(s), mailto, rutas relativas y anclas.

        function renderMarkdown(container, text) {
            container.textContent = '';
            var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
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
            // Instancia local: la recursión (negrita/itálica/enlaces) no debe compartir el
            // lastIndex del regex global, o se reinicia el escaneo y entra en bucle.
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

        // ───────────────────────── Persistencia ─────────────────────────

        function loadState() {
            try {
                var raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) {
                    return { conversationId: null, messages: [] };
                }
                var parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object') {
                    return { conversationId: null, messages: [] };
                }
                if (!Array.isArray(parsed.messages)) {
                    parsed.messages = [];
                }
                return parsed;
            } catch (e) {
                return { conversationId: null, messages: [] };
            }
        }

        function saveState() {
            try {
                if (state.messages && state.messages.length > MAX_STORED_MESSAGES) {
                    state.messages = state.messages.slice(-MAX_STORED_MESSAGES);
                }
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (e) { /* almacenamiento lleno o bloqueado */ }
        }

        function rememberMessage(rol, texto) {
            if (!texto) {
                return;
            }
            state.messages.push({ rol: rol, texto: texto });
            saveState();
        }

        function renderRestored() {
            var restored = (state.messages || []).slice(-MAX_RESTORE);
            if (restored.length === 0) {
                // Mensaje de bienvenida efímero.
                var welcome = document.createElement('div');
                welcome.className = 'fa-row fa-enter';
                var bubble = document.createElement('div');
                bubble.className = 'fa-bubble assistant';
                bubble.textContent = '¡Hola! Soy el asistente de Furent. Cuéntame qué evento estás '
                    + 'organizando y te ayudo a encontrar mobiliario y a cotizar.';
                welcome.appendChild(bubble);
                els.messages.appendChild(welcome);
                showBadge();
                return;
            }
            restored.forEach(function (message) {
                if (message.rol === 'USER') {
                    appendUserBubble(message.texto, false);
                } else {
                    var row = document.createElement('div');
                    row.className = 'fa-row';
                    var bubble = document.createElement('div');
                    bubble.className = 'fa-bubble assistant';
                    renderMarkdown(bubble, message.texto);
                    row.appendChild(bubble);
                    els.messages.appendChild(row);
                }
            });
        }
    }
})();
