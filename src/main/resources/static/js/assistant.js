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
            badge: document.getElementById('furent-assistant-badge')
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
            var text = (els.input.value || '').trim();
            if (!text || isStreaming) {
                return;
            }
            els.input.value = '';
            els.input.style.height = 'auto';
            hideChips();
            appendUserBubble(text);
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

        function appendUserBubble(text) {
            var row = document.createElement('div');
            row.className = 'fa-row user';
            var bubble = document.createElement('div');
            bubble.className = 'fa-bubble user';
            bubble.textContent = text;
            row.appendChild(bubble);
            els.messages.appendChild(row);
            scrollDown();
        }

        function beginAssistantReply() {
            var row = document.createElement('div');
            row.className = 'fa-row';
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
            row.className = 'fa-row';
            var wa = button('Continuar por WhatsApp', 'fa-btn-wa', function () {
                abrirWhatsApp('Hola Furent, vengo del asistente virtual.', 'error');
            });
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
            row.className = 'fa-row';
            var retry = button('Reintentar', 'fa-btn-ghost', function () {
                row.remove();
                if (!isStreaming) {
                    streamChat(text);
                }
            });
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
                var add = document.createElement('button');
                add.type = 'button';
                add.className = 'fa-btn fa-btn-ghost';
                add.textContent = 'Agregar a la bolsa';
                add.addEventListener('click', function () {
                    addLinesToBag([{
                        id: data.id,
                        nombre: data.nombre,
                        imagen: data.imagen,
                        precioDia: data.precioDia,
                        cantidad: 1,
                        stock: data.stock
                    }], { silentTotal: true });
                });
                actions.appendChild(add);
                card.appendChild(actions);
            }

            var row = document.createElement('div');
            row.className = 'fa-row';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
        }

        function appendQuoteCard(data) {
            if (!data) {
                return;
            }
            var card = document.createElement('div');
            card.className = 'fa-quote';

            var title = document.createElement('h4');
            title.textContent = 'Cotización estimada';
            card.appendChild(title);

            var rango = rangoFechas(data);
            if (rango) {
                var dates = document.createElement('p');
                dates.className = 'fa-quote-dates';
                dates.textContent = rango;
                card.appendChild(dates);
            }

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
                }));
                actions.appendChild(button('Hablar con un asesor', 'fa-btn-wa', function () {
                    abrirWhatsApp('Hola Furent, necesito ayuda con una cotización sin stock suficiente.', 'quote-stock');
                }));
            } else if (authenticated) {
                actions.appendChild(button('Reservar ahora', 'fa-btn-primary', function () {
                    trackAssistantEvent('assistant_checkout_click', { total: data.total });
                    prepararReserva(data);
                    goToCheckout(data.checkoutUrl);
                }));
                actions.appendChild(button('Enviar por WhatsApp', 'fa-btn-wa', function () {
                    abrirWhatsApp(cotizacionTexto(data), 'quote');
                }));
            } else {
                actions.appendChild(button('Continuar por WhatsApp', 'fa-btn-wa', function () {
                    abrirWhatsApp(cotizacionTexto(data), 'quote');
                }));
                actions.appendChild(button('Crear cuenta y reservar', 'fa-btn-ghost', function () {
                    trackAssistantEvent('assistant_checkout_click', { total: data.total, via: 'login' });
                    prepararReserva(data);
                    goToCheckout(data.checkoutUrl);
                }));
            }

            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
            trackAssistantEvent('assistant_quote_view', { total: data.total, dias: data.dias });
        }

        function button(label, className, onClick) {
            var element = document.createElement('button');
            element.type = 'button';
            element.className = 'fa-btn ' + className;
            element.textContent = label;
            element.addEventListener('click', onClick);
            return element;
        }

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
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'fa-btn fa-btn-wa';
            button.textContent = 'Abrir WhatsApp';
            var url = (data && data.whatsappUrl) || whatsappUrl('Hola Furent, vengo del asistente virtual.');
            button.addEventListener('click', function () {
                trackAssistantEvent('assistant_whatsapp_click', { origen: 'escalation' });
                window.open(url, '_blank');
            });
            actions.appendChild(button);
            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
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

        var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
            'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

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

        var INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

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
                welcome.className = 'fa-row';
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
                    appendUserBubble(message.texto);
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
