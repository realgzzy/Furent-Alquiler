/*
 * Furent RangeCalendar / DateRangePicker
 * --------------------------------------
 * Réplica ligera del RangeCalendar de HeroUI (sin dependencias). Es la misma
 * implementación que usa el asistente Furi, extraída a un módulo reutilizable
 * para poder montarla también en el checkout (/cotizacion).
 *
 * API:
 *   FurentRangeCalendar.create(opts) -> {
 *     el, getStart(), getEnd(), setRange(start, end), clear(), refresh(), focus(), destroy()
 *   }
 *
 * opts:
 *   start, end   ISO (YYYY-MM-DD) con los que arranca la selección.
 *   single       true para fecha única (sin rango).
 *   maxSpan      días máximos del rango (por defecto 7).
 *   getReserved  función que devuelve [{ from, to, products }] con los días ocupados.
 *   onReservedClick(info, iso)  si se pasa, los días ocupados se pueden tocar para ver
 *                el detalle en vez de quedar deshabilitados.
 *   onChange(start, end)  se dispara al cambiar la selección (puede venir end vacío).
 *
 * La apariencia se controla con las variables CSS --fa-* (que el widget ya define).
 * En el checkout, el bloque `.frc` de range-calendar.css define esos tokens.
 */
(function (global) {
    'use strict';

    var MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    var DIAS_CORTOS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
    var DIAS_LARGO = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    var DEFAULT_MAX_SPAN = 7;

    var ICON_CHEVRON_LEFT = ['m14.5 6-6 6 6 6'];
    var ICON_CHEVRON_RIGHT = ['m9.5 6 6 6-6 6'];

    // ── Utilidades de fecha ──
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function toIso(date) {
        if (!date) { return null; }
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function parseIso(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        if (!m) { return null; }
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
        if (!a || !b) { return 0; }
        return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
    }

    function todayIso() {
        var now = new Date();
        return toIso(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    }

    function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
    function monthIndex(date) { return date.getFullYear() * 12 + date.getMonth(); }
    function addMonths(date, n) { return new Date(date.getFullYear(), date.getMonth() + n, 1); }

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

    function create(opts) {
        opts = opts || {};
        var maxSpan = opts.maxSpan || DEFAULT_MAX_SPAN;
        var single = !!opts.single;
        var onChange = opts.onChange || function () {};
        var getReserved = opts.getReserved || function () { return []; };
        var onReservedClick = opts.onReservedClick || null;

        var root = document.createElement('div');
        root.className = 'fa-rcal';
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', single ? 'Calendario' : 'Rango de fechas');

        var initial = opts.start ? parseIso(opts.start) : null;
        var view = startOfMonth(initial || new Date());
        var start = opts.start || null;
        var end = opts.end || null;
        var hoverIso = null;

        function reservedList() {
            var list = getReserved();
            return Array.isArray(list) ? list : [];
        }

        function findReserved(iso) {
            var list = reservedList();
            for (var i = 0; i < list.length; i++) {
                var r = list[i];
                if (r && r.from && r.to && iso >= r.from && iso <= r.to) {
                    return r;
                }
            }
            return null;
        }

        /** Mientras se elige el segundo extremo, la ventana se limita a `maxSpan` días. */
        function inAllowedWindow(iso) {
            if (single || !start || end) { return true; }
            return iso >= addDaysIso(start, -(maxSpan - 1)) && iso <= addDaysIso(start, maxSpan - 1);
        }

        function dayDisabled(iso) {
            if (iso < todayIso()) { return true; }
            if (findReserved(iso) && !onReservedClick) { return true; }
            return !inAllowedWindow(iso);
        }

        /** ¿Hay algún día ocupado dentro del rango [lo, hi]? */
        function rangeHasReserved(lo, hi) {
            var list = reservedList();
            for (var i = 0; i < list.length; i++) {
                var r = list[i];
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
            prev.appendChild(svgIcon(ICON_CHEVRON_LEFT, 17));
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
            next.appendChild(svgIcon(ICON_CHEVRON_RIGHT, 17));

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
            if (!d) { return; }
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
            if (!cell) { return; }
            if (cell.disabled) { return; }
            event.preventDefault();
            var iso = cell.getAttribute('data-iso');
            if (cell.hasAttribute('data-unavailable') && onReservedClick) {
                onReservedClick(findReserved(iso), iso);
                return;
            }
            selectIso(iso);
        });

        root.addEventListener('mouseover', function (event) {
            if (single || !start || end) { return; }
            var cell = event.target.closest ? event.target.closest('.fa-rcal-day') : null;
            if (!cell || cell.disabled || cell.hasAttribute('data-unavailable')) { return; }
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

    global.FurentRangeCalendar = {
        create: create,
        toIso: toIso,
        parseIso: parseIso,
        addDaysIso: addDaysIso,
        diasEntre: diasEntre,
        todayIso: todayIso,
        MESES_LARGO: MESES_LARGO,
        DIAS_CORTOS: DIAS_CORTOS,
        DIAS_LARGO: DIAS_LARGO
    };
})(typeof window !== 'undefined' ? window : this);
