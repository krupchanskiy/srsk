// ==================== ФИНАНСЫ: ГОСТИ БЕЗ СОБЫТИЯ ====================
// Начисление гостям, приехавшим не на ретрит (ВГ, 28.09.2026). Всё считается
// по визиту — записи шахматки: ночи из дат, цена номера по вместимости делится
// на живущих, питание — по той же формуле, что у кухни (eating_detail). Долг
// ведётся в служебном контейнере «Гости без события» (fin_get_no_event_retreat),
// приём оплаты — обычная карточка участника.
(function() {
'use strict';

const e = str => Layout.escapeHtml(str);
const tr = (k, fb) => { const v = Layout.t(k); return v && v !== k ? v : fb; };
const round2 = v => Math.round(v * 100) / 100;
const inr = v => FinUtils.fmtMoney(v, 'INR');
const дата = s => DateUtils.formatShort(DateUtils.parseDate(s));
const днейМежду = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / 864e5);

// FinUtils.rpc отдаёт {ok, result, error}; здесь — результат или null с сообщением
async function call(name, payload) {
    const res = await FinUtils.rpc(name, payload);
    if (!res?.ok) { Layout.showNotification(res?.error?.message || 'Ошибка', 'error'); return null; }
    return res.result;
}

let tariff = null;        // действующий тариф
let visits = [];          // визиты периода из шахматки
let selected = new Set(); // resident_id выбранных визитов
let forms = {};           // resident_id → состояние расчёта

// ==================== ТАРИФЫ ====================
async function loadTariff() {
    const { data, error } = await Layout.db.rpc('fin_get_stay_tariffs', { p_on: DateUtils.toISO(new Date()) });
    if (error) { Layout.handleError(error, tr('fin_stay_tariffs', 'Тарифы')); return null; }
    tariff = data?.current || null;
    return data;
}

async function openTariffs() {
    const data = await loadTariff();
    if (!data) return;
    const c = data.current || {};
    document.getElementById('trfDate').value = DateUtils.toISO(new Date());
    document.getElementById('trfRoom2').value = c.room2_price ?? '';
    document.getElementById('trfRoom4').value = c.room4_price ?? '';
    document.getElementById('trfBreakfast').value = c.breakfast_price ?? '';
    document.getElementById('trfLunch').value = c.lunch_price ?? '';
    document.getElementById('trfHistory').innerHTML = (data.history || []).map(h => `<tr>
        <td>${дата(h.effective_date)}</td>
        <td class="text-right font-mono">${inr(h.room2_price)}</td>
        <td class="text-right font-mono">${inr(h.room4_price)}</td>
        <td class="text-right font-mono">${inr(h.breakfast_price)}</td>
        <td class="text-right font-mono">${inr(h.lunch_price)}</td>
    </tr>`).join('');
    document.getElementById('tariffsModal').showModal();
}

async function submitTariffs(ev) {
    ev.preventDefault();
    const res = await call('fin_set_stay_tariffs', {
        effective_date: document.getElementById('trfDate').value,
        room2_price: Number(document.getElementById('trfRoom2').value),
        room4_price: Number(document.getElementById('trfRoom4').value),
        breakfast_price: Number(document.getElementById('trfBreakfast').value),
        lunch_price: Number(document.getElementById('trfLunch').value)
    });
    if (!res) return;
    Layout.showNotification(tr('fin_saved', 'Сохранено'), 'success');
    document.getElementById('tariffsModal').close();
    await loadTariff();
}

// ==================== ОКНО НАЧИСЛЕНИЯ ====================
async function open(opts = {}) {
    if (!await loadTariff()) return;
    if (!tariff) { Layout.showNotification('Сначала заведите тарифы', 'warning'); openTariffs(); return; }
    selected = new Set();
    forms = {};
    const сегодня = new Date();
    const с = new Date(сегодня); с.setDate(с.getDate() - 21);
    const по = new Date(сегодня); по.setDate(по.getDate() + 7);
    document.getElementById('gcFrom').value = DateUtils.toISO(с);
    document.getElementById('gcTo').value = DateUtils.toISO(по);
    document.getElementById('gcForms').innerHTML = '';
    renderTotal();
    document.getElementById('guestChargeModal').showModal();
    await loadVisits();
    // Из карточки гостя — сразу его визиты без начислений
    if (opts.pid) {
        const свои = visits.filter(v => v.vaishnava_id === opts.pid);
        const новые = свои.filter(v => Number(v.charged) === 0);
        for (const v of (новые.length ? новые : свои.slice(0, 1))) await toggleVisit(v.resident_id, true, false);
        renderVisits();
    }
}

async function loadVisits() {
    const body = document.getElementById('gcVisits');
    body.innerHTML = `<tr><td colspan="6" class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></td></tr>`;
    const { data, error } = await Layout.db.rpc('fin_list_no_event_visits', {
        p_from: document.getElementById('gcFrom').value, p_to: document.getElementById('gcTo').value });
    if (error) { Layout.handleError(error, 'Визиты'); return; }
    visits = data || [];
    renderVisits();
}

function renderVisits() {
    const body = document.getElementById('gcVisits');
    const q = (document.getElementById('gcSearch').value || '').trim().toLowerCase();
    const list = visits.filter(v => !q || (v.name || '').toLowerCase().includes(q) || selected.has(v.resident_id));
    body.innerHTML = list.map(v => {
        const ночей = v.check_out ? днейМежду(v.check_in, v.check_out) : '—';
        const начислено = Number(v.charged) > 0
            ? `<span class="badge badge-ghost badge-sm whitespace-nowrap" title="Уже есть начисления по этому визиту">начислено ${FinUtils.fmtMoney(v.charged, v.charge_currency || 'INR')}</span>` : '';
        return `<tr class="cursor-pointer hover:bg-base-200 ${selected.has(v.resident_id) ? 'bg-primary/5' : ''}" data-gc-visit="${v.resident_id}">
            <td><input type="checkbox" class="checkbox checkbox-sm" ${selected.has(v.resident_id) ? 'checked' : ''} tabindex="-1"></td>
            <td class="font-medium">${e(v.name)}${v.vaishnava_id ? '' : ' <span class="badge badge-warning badge-xs" title="В шахматке только имя — при начислении привяжем к карточке">без карточки</span>'}</td>
            <td class="whitespace-nowrap">${v.room ? `${e(v.building || '')} №${e(String(v.room))}` : '<span class="opacity-50">без номера</span>'}</td>
            <td class="whitespace-nowrap">${дата(v.check_in)} — ${v.check_out ? дата(v.check_out) : '…'}</td>
            <td class="text-right">${ночей}</td>
            <td class="text-right">${начислено}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="6" class="text-center py-4 opacity-60">Гостей без события за период нет</td></tr>`;
}

// Выбор визита. Соседи по номеру с теми же датами отмечаются вместе — обычно
// платит пара или семья; лишних можно снять (ВГ, 28.09)
async function toggleVisit(rid, on, withMates = true) {
    const v = visits.find(x => x.resident_id === rid);
    if (!v) return;
    if (on === undefined) on = !selected.has(rid);
    if (!on) {
        selected.delete(rid);
        delete forms[rid];
    } else {
        selected.add(rid);
        await initForm(v);
        if (withMates && v.room_id) {
            for (const m of visits.filter(x => x.resident_id !== rid && x.room_id === v.room_id
                && x.check_in === v.check_in && x.check_out === v.check_out && !selected.has(x.resident_id))) {
                selected.add(m.resident_id);
                await initForm(m);
            }
        }
    }
    renderVisits();
    renderForms();
}

async function initForm(v) {
    if (forms[v.resident_id]) return;
    const cap = Number(v.capacity) || 2;
    const f = {
        v,
        nights: v.check_out ? Math.max(днейМежду(v.check_in, v.check_out), 0) : 1,
        roomPrice: Number(cap <= 2 ? tariff.room2_price : tariff.room4_price),
        people: Math.max(Number(v.roommates) || 1, 1),
        bPrice: Number(tariff.breakfast_price),
        lPrice: Number(tariff.lunch_price),
        meals: [],
        extraAmt: 0, extraDesc: '', comment: '',
        person: v.vaishnava_id ? { mode: 'linked', id: v.vaishnava_id } : { mode: 'new', candidates: null,
            np: { spiritual_name: v.guest_name || '', first_name: '', last_name: '', phone: v.guest_phone || '', email: v.guest_email || '' } }
    };
    forms[v.resident_id] = f;
    // Питание — ровно то, что считает кухня: день заезда, выезда, ранний/поздний
    if (v.has_meals !== false && v.check_out) {
        const { data } = await Layout.db.rpc('eating_detail', { p_from: v.check_in, p_to: v.check_out });
        const дни = (data || []).filter(r => r.ref_id === v.resident_id).sort((a, b) => a.d.localeCompare(b.d));
        f.meals = дни.map(r => ({ d: r.d, b: !!r.breakfast, l: !!r.lunch }));
    }
    if (!v.vaishnava_id) {
        const { data } = await Layout.db.rpc('fin_guest_person_candidates',
            { p_name: v.guest_name || '', p_phone: v.guest_phone || null, p_email: v.guest_email || null });
        f.person.candidates = data || [];
    }
}

function расчёт(f) {
    const заНочь = f.people > 0 ? round2(f.roomPrice / f.people) : 0;
    const завтраков = f.meals.filter(m => m.b).length;
    const обедов = f.meals.filter(m => m.l).length;
    const проживание = round2(f.nights * заНочь);
    const питание = round2(завтраков * f.bPrice + обедов * f.lPrice);
    const доп = round2(Number(f.extraAmt) || 0);
    return { заНочь, завтраков, обедов, проживание, питание, доп, итого: round2(проживание + питание + доп) };
}

function personHtml(rid, f) {
    if (f.person.mode === 'linked') {
        return `<div class="text-xs opacity-70 mb-2">Карточка: <b>${e(f.v.name)}</b></div>`;
    }
    const cands = f.person.candidates || [];
    const событ = c => (c.events || []).slice(0, 4).map(x => `${e(x.name)} ${x.from ? DateUtils.formatShort(DateUtils.parseDate(x.from)) : ''}`).join(', ');
    return `<div class="border border-warning/40 bg-warning/5 rounded-lg p-2 mb-2">
        <div class="text-xs font-semibold mb-1">Кто это? В шахматке только имя — выберите карточку или заведите новую</div>
        ${cands.map(c => `<label class="flex items-start gap-2 text-xs py-0.5 cursor-pointer">
            <input type="radio" class="radio radio-xs mt-0.5" name="gcp_${rid}" value="${c.id}" data-gc-person="${rid}" ${f.person.mode === 'existing' && f.person.id === c.id ? 'checked' : ''}>
            <span><b>${e(c.name)}</b>${c.phone ? ' · ' + e(c.phone) : ''}${c.email ? ' · ' + e(c.email) : ''}
                ${c.events?.length ? `<br><span class="opacity-60">Был: ${событ(c)}</span>` : '<br><span class="opacity-60">Приездов в базе нет</span>'}</span>
        </label>`).join('')}
        <label class="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
            <input type="radio" class="radio radio-xs" name="gcp_${rid}" value="new" data-gc-person="${rid}" ${f.person.mode === 'new' ? 'checked' : ''}>
            <span><b>Новая карточка</b>${cands.length ? ' — это другой человек' : ''}</span>
        </label>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-1 mt-1 ${f.person.mode === 'new' ? '' : 'hidden'}">
            ${[['spiritual_name', 'Духовное имя'], ['first_name', 'Имя'], ['last_name', 'Фамилия'], ['phone', 'Телефон'], ['email', 'Почта']]
                .map(([k, ph]) => `<input type="${k === 'email' ? 'email' : 'text'}" class="input input-bordered input-xs" placeholder="${ph}${k === 'phone' || k === 'email' ? ' *' : ''}"
                    data-gc-np="${rid}" data-k="${k}" value="${e(f.person.np?.[k] || '')}">`).join('')}
            <div class="col-span-2 md:col-span-5 text-[11px] opacity-60">* нужен телефон или почта — иначе тёзку не отличить</div>
        </div>
    </div>`;
}

function renderForms() {
    const wrap = document.getElementById('gcForms');
    wrap.innerHTML = [...selected].map(rid => {
        const f = forms[rid];
        if (!f) return '';
        const r = расчёт(f);
        const v = f.v;
        const уже = Number(v.charged) > 0
            ? `<div class="alert alert-warning py-1 px-2 text-xs mb-2">По этому визиту уже начислено ${FinUtils.fmtMoney(v.charged, v.charge_currency || 'INR')}. Новое начисление добавится к нему.</div>` : '';
        const последний = f.meals.length - 1;
        return `<div class="border border-base-300 rounded-xl p-3 mb-3" data-gc-form="${rid}">
            <div class="flex flex-wrap justify-between gap-2 mb-2">
                <div class="font-semibold">${e(v.name)} <span class="font-normal text-sm opacity-60">· ${v.room ? `${e(v.building || '')} №${e(String(v.room))} (${v.capacity}-мест.)` : 'без номера'} · ${дата(v.check_in)} — ${v.check_out ? дата(v.check_out) : '…'}</span></div>
                <div class="font-mono font-semibold">${inr(r.итого)}</div>
            </div>
            ${уже}
            ${personHtml(rid, f)}
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">Проживание</div>
            <div class="flex flex-wrap items-center gap-1 text-sm mb-3">
                <input type="number" min="0" step="1" class="input input-bordered input-xs w-16" data-gc-f="${rid}" data-k="nights" value="${f.nights}"> ноч. ×
                (<input type="number" min="0" step="50" class="input input-bordered input-xs w-24" data-gc-f="${rid}" data-k="roomPrice" value="${f.roomPrice}" title="Цена номера за сутки">
                ÷ <input type="number" min="1" step="1" class="input input-bordered input-xs w-14" data-gc-f="${rid}" data-k="people" value="${f.people}" title="Сколько человек делят номер"> чел.
                = <span class="font-mono">${inr(r.заНочь)}</span>)
                = <b class="font-mono">${inr(r.проживание)}</b>
            </div>
            ${v.has_meals === false ? '<div class="text-xs opacity-60 mb-3">Питание в шахматке выключено</div>' : `
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">Питание</div>
            <div class="flex flex-wrap gap-1 mb-1">
                ${f.meals.map((m, i) => `<div class="border border-base-300 rounded-lg px-2 py-1 text-xs">
                    <div class="font-medium">${дата(m.d)}</div>
                    <label class="flex items-center gap-1 cursor-pointer" ${i === 0 ? 'title="Завтрак в день заезда = ранний заезд в шахматке"' : ''}>
                        <input type="checkbox" class="checkbox checkbox-xs" data-gc-meal="${rid}" data-i="${i}" data-m="b" ${m.b ? 'checked' : ''}> завтрак</label>
                    <label class="flex items-center gap-1 cursor-pointer" ${i === последний ? 'title="Обед в день выезда = поздний выезд в шахматке"' : ''}>
                        <input type="checkbox" class="checkbox checkbox-xs" data-gc-meal="${rid}" data-i="${i}" data-m="l" ${m.l ? 'checked' : ''}> обед</label>
                </div>`).join('') || '<span class="text-xs opacity-60">Дней питания нет</span>'}
            </div>
            <div class="flex flex-wrap items-center gap-1 text-sm mb-1">
                ${r.завтраков} × <input type="number" min="0" step="10" class="input input-bordered input-xs w-20" data-gc-f="${rid}" data-k="bPrice" value="${f.bPrice}"> завтрак
                + ${r.обедов} × <input type="number" min="0" step="10" class="input input-bordered input-xs w-20" data-gc-f="${rid}" data-k="lPrice" value="${f.lPrice}"> обед
                = <b class="font-mono">${inr(r.питание)}</b>
            </div>
            <div class="text-[11px] opacity-60 mb-3">Завтрак в день заезда и обед в день выезда уходят в шахматку (ранний заезд / поздний выезд) — кухня посчитает так же</div>`}
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">Дополнительно</div>
            <div class="flex flex-wrap items-center gap-1 mb-2">
                <input type="number" min="0" step="10" class="input input-bordered input-xs w-24" placeholder="₹" data-gc-f="${rid}" data-k="extraAmt" value="${f.extraAmt || ''}">
                <input type="text" class="input input-bordered input-xs flex-1 min-w-40" placeholder="За что (такси, стирка…)" data-gc-f="${rid}" data-k="extraDesc" value="${e(f.extraDesc)}">
            </div>
            <input type="text" class="input input-bordered input-xs w-full" placeholder="Комментарий (необязательно)" data-gc-f="${rid}" data-k="comment" value="${e(f.comment)}">
        </div>`;
    }).join('');
    renderTotal();
}

function renderTotal() {
    const сумма = [...selected].reduce((a, rid) => a + (forms[rid] ? расчёт(forms[rid]).итого : 0), 0);
    document.getElementById('gcTotal').innerHTML = selected.size
        ? `Итого: <b class="font-mono">${inr(сумма)}</b> · гостей: ${selected.size}` : 'Отметьте гостей в списке';
    document.getElementById('gcSave').disabled = !selected.size;
}

// ==================== СОХРАНЕНИЕ ====================
async function save() {
    const retreatId = await FinParticipants.noEventRetreatId();
    // проверка до первой записи: всё или ничего по понятным ошибкам
    for (const rid of selected) {
        const f = forms[rid];
        if (f.person.mode === 'existing' && !f.person.id) { Layout.showNotification(`${f.v.name}: выберите карточку`, 'warning'); return; }
        if (f.person.mode === 'new') {
            const np = f.person.np;
            if (!(np.spiritual_name || np.first_name).trim()) { Layout.showNotification(`${f.v.name}: нужно имя`, 'warning'); return; }
            if (!(np.phone || np.email).trim()) { Layout.showNotification(`${f.v.name}: нужен телефон или почта`, 'warning'); return; }
        }
        if (расчёт(f).итого <= 0) { Layout.showNotification(`${f.v.name}: нечего начислять`, 'warning'); return; }
    }
    const повтор = [...selected].map(rid => forms[rid].v).filter(v => Number(v.charged) > 0);
    if (повтор.length && !confirm(`Уже есть начисления: ${повтор.map(v => v.name).join(', ')}. Добавить ещё?`)) return;

    let первый = null;
    for (const rid of selected) {
        const f = forms[rid];
        const v = f.v;
        const payload = { resident_id: rid };
        if (f.person.mode === 'linked' || f.person.mode === 'existing') payload.vaishnava_id = f.person.id;
        else payload.new_person = Object.fromEntries(Object.entries(f.person.np).map(([k, x]) => [k, (x || '').trim()]));
        // края питания → шахматка, чтобы цифра кухни совпала с начислением
        if (f.meals.length) {
            const ранний = f.meals[0].b, поздний = f.meals[f.meals.length - 1].l;
            if (ранний !== !!v.early_checkin) payload.early_checkin = ранний;
            if (поздний !== !!v.late_checkout) payload.late_checkout = поздний;
        }
        const prep = await call('fin_guest_prepare_visit', payload);
        if (!prep) return;
        const pid = prep.vaishnava_id;
        f.person = { mode: 'linked', id: pid };
        v.vaishnava_id = pid;

        // Начисление — в валюте расчёта гостя: если ему уже выбрали не ₹,
        // тариф переводится по общему курсу и дальше не пересчитывается
        const { data: bal } = await Layout.db.rpc('fin_get_participant_balance', { p_participant: pid, p_retreat: retreatId });
        const cur = bal?.currency || 'INR';
        const rate = cur === 'INR' ? 1 : Number(FinParticipants.rates()[cur]);
        if (!rate) { Layout.showNotification(`Нет общего курса ${cur}`, 'error'); return; }
        const вВалюту = x => round2(x / rate);

        const r = расчёт(f);
        const где = v.room ? ` · ${v.building || ''} №${v.room}` : '';
        const хвост = f.comment.trim() ? ` · ${f.comment.trim()}` : '';
        const дни = arr => arr.map(m => DateUtils.formatShort(DateUtils.parseDate(m.d))).join(', ');
        const base = { retreat_id: retreatId, participant_id: pid, resident_id: rid, occurred_on: v.check_in };
        const rows = [];
        if (f.nights > 0 && r.заНочь > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'accommodation',
            description: `Проживание ${дата(v.check_in)}–${v.check_out ? дата(v.check_out) : '…'}${где}${f.people > 1 ? ` (номер ${inr(f.roomPrice)} ÷ ${f.people})` : ''}${хвост}`,
            quantity: f.nights, unit_price: вВалюту(r.заНочь) });
        if (r.завтраков && f.bPrice > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'meals',
            description: `Завтраки: ${дни(f.meals.filter(m => m.b))}`, quantity: r.завтраков, unit_price: вВалюту(f.bPrice) });
        if (r.обедов && f.lPrice > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'meals',
            description: `Обеды: ${дни(f.meals.filter(m => m.l))}`, quantity: r.обедов, unit_price: вВалюту(f.lPrice) });
        if (r.доп > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'extra',
            description: f.extraDesc.trim() || 'Дополнительно', quantity: 1, unit_price: вВалюту(r.доп) });
        const res = await call('fin_create_charge', { rows });
        if (!res) return;
        selected.delete(rid);
        if (!первый) первый = pid;
    }
    document.getElementById('guestChargeModal').close();
    Layout.showNotification('Начислено — можно принимать оплату', 'success');
    await FinParticipants.reload();
    if (первый) FinParticipants.openCardById(первый);
}

// ==================== СОБЫТИЯ ====================
function init() {
    document.getElementById('tariffsForm')?.addEventListener('submit', FinUtils.lockedSubmit(submitTariffs));
    // кнопка вне формы — блокировка от двойного нажатия вручную
    const saveBtn = document.getElementById('gcSave');
    saveBtn?.addEventListener('click', async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        try { await save(); } finally { saveBtn.disabled = !selected.size; }
    });
    document.getElementById('gcReload')?.addEventListener('click', loadVisits);
    document.getElementById('gcSearch')?.addEventListener('input', Layout.debounce(renderVisits, 200));
    document.getElementById('gcVisits')?.addEventListener('click', ev => {
        const row = ev.target.closest('[data-gc-visit]');
        if (row) toggleVisit(row.dataset.gcVisit);
    });
    const forms_ = document.getElementById('gcForms');
    forms_?.addEventListener('change', ev => {
        const el = ev.target;
        if (el.dataset.gcMeal) {
            const f = forms[el.dataset.gcMeal];
            f.meals[Number(el.dataset.i)][el.dataset.m] = el.checked;
            renderForms();
        } else if (el.dataset.gcPerson) {
            const f = forms[el.dataset.gcPerson];
            f.person = el.value === 'new'
                ? { ...f.person, mode: 'new' }
                : { ...f.person, mode: 'existing', id: el.value };
            renderForms();
        } else if (el.dataset.gcF) {
            const f = forms[el.dataset.gcF];
            const k = el.dataset.k;
            f[k] = ['extraDesc', 'comment'].includes(k) ? el.value : Number(el.value) || 0;
            renderForms();
        }
    });
    // текстовые поля карточки — без перерисовки, чтобы не терять курсор
    forms_?.addEventListener('input', ev => {
        const el = ev.target;
        if (el.dataset.gcNp) forms[el.dataset.gcNp].person.np[el.dataset.k] = el.value;
    });
}

window.FinGuests = { open, openTariffs };
init();
})();
