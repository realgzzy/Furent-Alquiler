/**
 * Widget del asistente virtual de Furent.
 *
 * - Habla con POST /api/asistente/chat y consume el stream SSE con fetch + ReadableStream.
 * - Renderiza todo con textContent/createElement: el texto del modelo nunca se inyecta como HTML.
 * - Guarda el conversationId y el texto de la conversación en localStorage para restaurar el hilo.
 * - Integra cotizaciones con la bolsa (`furent_bag`) y el checkout de la web.
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
            textSpanOf(currentBubble).appendChild(document.createTextNode(text));
            scrollDown();
        }

        function closePendingBubble() {
            if (currentBubble) {
                var hasText = currentBubble._textSpan && currentBubble._textSpan.textContent.length > 0;
                if (!hasText) {
                    var row = currentBubble.parentNode;
                    if (row) {
                        row.remove();
                    }
                } else {
                    var remembered = currentBubble._textSpan.textContent;
                    currentBubble.parentNode.removeAttribute('data-pending');
                    rememberMessage('ASSISTANT', remembered);
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
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'fa-btn fa-btn-wa';
            button.style.maxWidth = '85%';
            button.textContent = 'Continuar por WhatsApp';
            button.addEventListener('click', function () {
                window.open('https://wa.me/573105782442?text=' +
                    encodeURIComponent('Hola Furent, vengo del asistente virtual.'), '_blank');
            });
            row.appendChild(button);
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

            (data.items || []).forEach(function (item) {
                card.appendChild(quoteLine(
                    (item.nombre || 'Producto') + '  ×' + (item.cantidad || 0),
                    formatCOP(item.subtotal)));
            });

            if (typeof data.dias === 'number') {
                card.appendChild(quoteLine('Días', String(data.dias)));
            }

            var discount = Number(data.descuento || 0);
            if (discount > 0) {
                card.appendChild(quoteLine('Descuento', '-' + formatCOP(discount)));
            }

            var total = document.createElement('div');
            total.className = 'fa-quote-total';
            var totalLabel = document.createElement('span');
            totalLabel.textContent = 'Total';
            var totalValue = document.createElement('span');
            totalValue.textContent = formatCOP(data.total);
            total.appendChild(totalLabel);
            total.appendChild(totalValue);
            card.appendChild(total);

            var note = document.createElement('p');
            note.className = 'fa-quote-note';
            note.textContent = 'La disponibilidad no bloquea el inventario hasta confirmar y pagar. '
                + 'Máximo 7 días por alquiler.';
            card.appendChild(note);

            var actions = document.createElement('div');
            actions.className = 'fa-quote-actions';

            var addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'fa-btn fa-btn-ghost';
            addBtn.textContent = 'Agregar a la bolsa';
            addBtn.addEventListener('click', function () {
                addLinesToBag(data.items || []);
            });
            actions.appendChild(addBtn);

            var checkout = document.createElement('button');
            checkout.type = 'button';
            checkout.className = 'fa-btn fa-btn-primary';
            checkout.textContent = 'Ir al checkout';
            checkout.addEventListener('click', function () {
                goToCheckout(data.checkoutUrl);
            });
            actions.appendChild(checkout);

            card.appendChild(actions);

            var row = document.createElement('div');
            row.className = 'fa-row';
            row.style.width = '100%';
            row.appendChild(card);
            els.messages.appendChild(row);
            scrollDown();
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
            var url = (data && data.whatsappUrl) || 'https://wa.me/573105782442';
            button.addEventListener('click', function () { window.open(url, '_blank'); });
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
                    bubble.textContent = message.texto;
                    row.appendChild(bubble);
                    els.messages.appendChild(row);
                }
            });
        }
    }
})();
