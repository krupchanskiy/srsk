// ==================== ПЕРСОНАЛЬНАЯ ДОГОВОРЁННОСТЬ (миграция 731) ====================
// Окна оплаты «Начислить гостю» и «Начислить группе» (ВГ 08–22.10.2026):
// • Поздний выезд: до 14:00 — без доплаты, 14:00–19:00 — ½ суток, после 19:00 — сутки;
//   цена суток = доля ночи человека. Считается всегда, ВГ на месте снимает или меняет.
// • Любое ручное отличие от расчёта (доплата, делитель, цена номера) — только через окно
//   подтверждения; хранится по месту шахматки (fin_stay_agreements) и переживает «Пересчитать».
//   У строки — замок «Договорённость дд.мм, кто», при наведении — расчётное значение и комментарий.
const FinAgreement = (() => {
    const esc = s => Layout.escapeHtml(s);
    const LOCK = '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 inline -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>';

    // Доля суток доплаты по времени выезда «HH:MM»
    function lateFactor(t) {
        if (!t) return 0;
        const h = parseInt(t.slice(0, 2), 10);
        return h >= 19 ? 1 : h >= 14 ? 0.5 : 0;
    }
    const lateLabel = k => k === 1 ? 'сутки' : k === 0.5 ? '½ суток' : 'без доплаты';

    async function load(ids) {
        const list = [...new Set((ids || []).filter(Boolean))];
        if (!list.length) return {};
        const { data, error } = await Layout.db.rpc('fin_stay_agreements_get', { p_ids: list });
        if (error) { Layout.handleError(error, 'Договорённости'); return {}; }
        return data || {};
    }

    // Окно подтверждения. Возвращает комментарий ('' — без него) или null — отмена
    function ask({ who, what, calcText, valueText }) {
        let dlg = document.getElementById('finAgreementModal');
        if (!dlg) {
            dlg = document.createElement('dialog');
            dlg.id = 'finAgreementModal';
            dlg.className = 'modal';
            document.body.appendChild(dlg);
        }
        dlg.innerHTML = `<div class="modal-box max-w-md">
            <h3 class="font-bold text-lg mb-2">Персональная договорённость</h3>
            <div class="text-sm mb-1"><b>${esc(who)}</b></div>
            <div class="text-sm mb-3">${esc(what)}: <b>${esc(valueText)}</b> вместо <span class="line-through">${esc(calcText)}</span> по расчёту</div>
            <div class="text-xs mb-3">Сохранится при любых пересчётах, пока сами не поменяете.</div>
            <input type="text" class="input input-bordered input-sm w-full" data-fa="comment" placeholder="Комментарий (необязательно): о чём договорились">
            <div class="modal-action">
                <button type="button" class="btn btn-ghost btn-sm" data-fa="no">Отмена</button>
                <button type="button" class="btn btn-primary btn-sm" data-fa="yes">Да, это договорённость</button>
            </div></div>`;
        return new Promise(resolve => {
            const done = v => { dlg.close(); resolve(v); };
            dlg.querySelector('[data-fa="yes"]').onclick = () => done(dlg.querySelector('[data-fa="comment"]').value.trim());
            dlg.querySelector('[data-fa="no"]').onclick = () => done(null);
            dlg.oncancel = ev => { ev.preventDefault(); done(null); };
            dlg.showModal();
            dlg.querySelector('[data-fa="comment"]').focus();
        });
    }

    async function save(rid, field, calc, value, comment) {
        const res = await FinUtils.rpc('fin_stay_agreement_set', { resident_id: rid, field, calc_value: calc, value, comment: comment || null });
        if (!res?.ok) { Layout.showNotification(res?.error?.message || 'Ошибка', 'error'); return null; }
        return res.result?.[rid] || {};
    }

    async function clear(rid, field, { who, what, calcText }) {
        if (!confirm(`${who}\n${what}: вернуть по расчёту — ${calcText}?\nДоговорённость будет снята.`)) return null;
        const res = await FinUtils.rpc('fin_stay_agreement_set', { resident_id: rid, field, value: null });
        if (!res?.ok) { Layout.showNotification(res?.error?.message || 'Ошибка', 'error'); return null; }
        return res.result?.[rid] || {};
    }

    // Отметка у строки: замок, дата, кто; подсказка — расчётное значение и комментарий
    function badge(ag, calcText, attrs) {
        if (!ag) return '';
        const когда = ag.at ? DateUtils.formatShort(new Date(ag.at)) : '';
        const title = `По расчёту: ${calcText}${ag.comment ? `\n${ag.comment}` : ''}`;
        return `<span class="badge badge-warning badge-sm gap-1 whitespace-nowrap" title="${esc(title)}">${LOCK} Договорённость ${esc(когда)}, ${esc(ag.by || '')}</span>
            <button type="button" class="link link-primary text-xs whitespace-nowrap" ${attrs}>вернуть по расчёту</button>`;
    }

    // Коротко для таблицы группы: только замок; нажать — вернуть по расчёту
    function lock(ag, calcText, attrs) {
        if (!ag) return '';
        const когда = ag.at ? DateUtils.formatShort(new Date(ag.at)) : '';
        const title = `Договорённость ${когда}, ${ag.by || ''}. По расчёту: ${calcText}${ag.comment ? `. ${ag.comment}` : ''}. Нажмите — вернуть по расчёту`;
        return `<button type="button" class="text-warning align-middle" title="${esc(title)}" ${attrs}>${LOCK}</button>`;
    }

    // ==================== КАК ПОСЧИТАНО ПРОЖИВАНИЕ (ВГ 22.10) ====================
    // Цветные пометки под суммой проживания и формула словами при наведении — одинаково
    // в «Начислить гостю» и «Начислить группе». Сводку и печать организатору не трогают
    const ВИД = {
        share: 'bg-gray-100 text-gray-700', whole: 'bg-blue-100 text-blue-800', extra: 'bg-purple-100 text-purple-800',
        late: 'bg-orange-100 text-orange-800', night: 'bg-sky-100 text-sky-800', agreed: 'bg-yellow-100 text-yellow-800'
    };
    const чип = (вид, текст, title = '') => `<span class="inline-block rounded px-1 text-[10px] leading-4 whitespace-nowrap ${ВИД[вид]}"${title ? ` title="${esc(title)}"` : ''}>${esc(текст)}</span>`;

    // s: { extraBed, whole, people, late, night, agreed: [названия полей] }
    function chips(s) {
        const out = [];
        if (s.extraBed) out.push(чип('extra', 'доп. кровать', 'Цена доп. кровати за ночь вместо доли номера'));
        else if (s.whole) out.push(чип('whole', s.people > 1 ? `номер целиком ÷ ${s.people}` : 'номер целиком', 'Без подселения: номер делится только на людей этой брони'));
        else if (s.people) out.push(чип('share', `место ÷ ${s.people}`, 'Цена номера делится на число мест / жильцов'));
        if (s.late) out.push(чип('late', `поздний выезд ${s.late === 1 ? 'сутки' : '½'}`, 'Выезд 14:00–19:00 — ½ суток, после 19:00 — сутки'));
        if (s.night) out.push(чип('night', 'ночной приезд', 'Приезд до 6:00 — заезд накануне, ночь обычная, без доплаты'));
        if (s.agreed?.length) out.push(чип('agreed', `договорённость: ${s.agreed.join(', ')}`, 'Своё значение вместо расчёта — 🔒 у поля'));
        return out.length ? `<div class="flex flex-wrap gap-0.5 mt-0.5">${out.join('')}</div>` : '';
    }

    // Формула словами: «4 ноч. × (₹3 500 ÷ 2 = ₹1 750) + сутки за выезд в 21:00 ₹1 750 = ₹8 750»
    function formula({ nights, roomPrice, people, nightPrice, extraBed, late, depTime, lateFee, total }) {
        const м = v => FinUtils.fmtMoney(v, 'INR');
        let s = `${nights} ноч. × ` + (extraBed ? `доп. кровать ${м(nightPrice)}` : people > 1 ? `(${м(roomPrice)} ÷ ${people} = ${м(nightPrice)})` : м(nightPrice));
        if (lateFee > 0) s += ` + ${late === 1 ? 'сутки' : late === 0.5 ? '½ суток' : 'доплата'} за выезд${depTime ? ` в ${depTime}` : ''} ${м(lateFee)}`;
        return `${s} = ${м(total)}`;
    }

    return { lateFactor, lateLabel, load, ask, save, clear, badge, lock, chips, formula };
})();
