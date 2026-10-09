// Время у места вместо галочек «ранний заезд / поздний выезд» (миграция 670, ВГ 09.10.2026).
// «Ожидается в ~» / «Уезжает в ~» — примерно; пусто — как раньше. Пороги прасада: завтрак до 9:00,
// обед до 14:00. «Оставить» — только к приезду и только когда человек пропускает приём.
// Старые галочки early_checkin / late_checkout видны, лишь если уже стоят: их можно снять, новых не ставим.
//
//   <div data-arrival-time="in"></div>   ArrivalTime.set(el, { time, keep, legacy })
//   <div data-arrival-time="out"></div>  ArrivalTime.get(el) → { time, keep, legacy }
//   ArrivalTime.toPlace(inEl, outEl) → поля residents для сохранения
const ArrivalTime = (() => {
    const BH = 9, LH = 14;
    const tr = (key, fallback) => {
        const v = typeof Layout !== 'undefined' ? Layout.t(key) : key;
        return v && v !== key ? v : fallback;
    };
    const esc = s => typeof Layout !== 'undefined' ? Layout.escapeHtml(s) : String(s);
    const hour = t => t ? parseInt(t.slice(0, 2), 10) : null;

    // Какой приём человек пропускает, приехав в t: null | 'breakfast' | 'lunch'
    function missedOnArrival(t) {
        const h = hour(t);
        if (h === null) return null;
        return h >= LH ? 'lunch' : h >= BH ? 'breakfast' : null;
    }

    function hintFor(side, t) {
        const h = hour(t);
        if (h === null) return '';
        if (side === 'in') {
            if (h < BH) return tr('arrival_hint_all', 'успевает на завтрак и обед');
            return h < LH ? tr('arrival_hint_no_breakfast', 'опоздает на завтрак')
                          : tr('arrival_hint_no_lunch', 'опоздает на обед');
        }
        if (h < BH) return tr('departure_hint_no_meals', 'уедет до завтрака — в этот день не ест');
        return h < LH ? tr('departure_hint_breakfast', 'позавтракает, обед не считается')
                      : tr('departure_hint_lunch', 'пообедает перед отъездом');
    }

    function set(el, { time = null, keep = false, legacy = false } = {}) {
        if (!el) return;
        const side = el.dataset.arrivalTime === 'out' ? 'out' : 'in';
        const label = side === 'in' ? tr('arrival_expected_at', 'Ожидается в ~') : tr('departure_leaves_at', 'Уезжает в ~');
        const legacyLabel = side === 'in' ? tr('timeline_early_checkin', 'Ранний заезд') : tr('timeline_late_checkout', 'Поздний выезд');
        el.innerHTML = `
            <label class="flex items-center gap-2 py-1 cursor-pointer">
                <span class="label-text text-sm whitespace-nowrap">${esc(label)}</span>
                <input type="time" step="900" class="input input-bordered input-xs w-24" data-at="time" value="${esc((time || '').slice(0, 5))}">
            </label>
            <div class="text-xs text-gray-600 hidden" data-at="hint"></div>
            ${side === 'in' ? `<div class="hidden" data-at="keepRow"><label class="label cursor-pointer justify-start gap-2 py-0.5">
                <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-at="keep"${keep ? ' checked' : ''}>
                <span class="label-text text-sm" data-at="keepText"></span>
            </label></div>` : ''}
            <div class="${legacy ? '' : 'hidden'}" data-at="legacyRow"><label class="label cursor-pointer justify-start gap-2 py-0.5"
                   title="${esc(tr('arrival_legacy_hint', 'Старая отметка — считается как раньше. Снимите и укажите время.'))}">
                <input type="checkbox" class="checkbox checkbox-xs" data-at="legacy"${legacy ? ' checked' : ''}>
                <span class="label-text text-sm">${esc(legacyLabel)}</span>
            </label></div>`;
        el.dataset.legacyShown = legacy ? '1' : '';
        const input = el.querySelector('[data-at="time"]');
        input.addEventListener('input', () => refresh(el));
        refresh(el);
    }

    function refresh(el) {
        const side = el.dataset.arrivalTime === 'out' ? 'out' : 'in';
        const t = el.querySelector('[data-at="time"]')?.value || '';
        const hint = el.querySelector('[data-at="hint"]');
        hint.textContent = hintFor(side, t);
        hint.classList.toggle('hidden', !t);
        if (side !== 'in') return;
        const missed = missedOnArrival(t);
        const row = el.querySelector('[data-at="keepRow"]');
        row.classList.toggle('hidden', !missed);
        if (!missed) row.querySelector('[data-at="keep"]').checked = false;
        else el.querySelector('[data-at="keepText"]').textContent = missed === 'lunch'
            ? tr('arrival_keep_lunch', 'Оставить обед') : tr('arrival_keep_breakfast', 'Оставить завтрак');
    }

    function get(el) {
        if (!el || !el.querySelector('[data-at="time"]')) return { time: null, keep: false, legacy: false };
        const time = el.querySelector('[data-at="time"]').value || null;
        const keepEl = el.querySelector('[data-at="keep"]');
        return {
            time,
            keep: !!(keepEl && keepEl.checked && missedOnArrival(time)),
            legacy: !!el.querySelector('[data-at="legacy"]')?.checked
        };
    }

    // Поля места: время, «оставить», старые галочки (только снять)
    function toPlace(inEl, outEl) {
        const a = get(inEl), d = get(outEl);
        return {
            arrival_time: a.time, keep_arrival_meal: a.keep, early_checkin: a.legacy,
            departure_time: d.time, late_checkout: d.legacy
        };
    }

    // Из записи residents — в оба поля
    function fromPlace(inEl, outEl, res = {}) {
        set(inEl, { time: res.arrival_time, keep: !!res.keep_arrival_meal, legacy: !!res.early_checkin });
        set(outEl, { time: res.departure_time, legacy: !!res.late_checkout });
    }

    // Подпись к дате в карточке: «~16:00», «оставить обед»
    function label(res, side) {
        const t = side === 'in' ? res?.arrival_time : res?.departure_time;
        if (!t) return '';
        let s = '~' + t.slice(0, 5);
        if (side === 'in' && res.keep_arrival_meal && missedOnArrival(t)) {
            s += ', ' + (missedOnArrival(t) === 'lunch' ? tr('arrival_keep_lunch', 'Оставить обед') : tr('arrival_keep_breakfast', 'Оставить завтрак')).toLowerCase();
        }
        return s;
    }

    return { BH, LH, missedOnArrival, set, get, toPlace, fromPlace, label };
})();
