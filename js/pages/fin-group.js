// ==================== ФИНАНСЫ: ОПЛАТА ГРУППОЙ ====================
// Группа — стороннее мероприятие с бронью в шахматке (ВГ, 28.09.2026). Платит
// организатор: он собирает со всех и платит одной суммой. Окно — таблица всех мест
// (комната, даты, ночи, номер ÷ жильцов, завтраки, обеды) по тарифам и формуле кухни
// (eating_detail); правка строки или сразу всем. Лист хранится (fin_group_sheets),
// на карточку организатора идут итоги по блокам — fin_group_save пересчитывает
// только изменившиеся. Сводка организатору — копия текстом или PDF.
(function() {
'use strict';

const e = str => Layout.escapeHtml(str);
const round2 = v => Math.round(v * 100) / 100;
const inr = v => FinUtils.fmtMoney(v, 'INR');
// в таблице и сводке — коротко «01.10», год — только в заголовке сводки
const дата = s => s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : '…';
const датаГод = s => DateUtils.formatShort(DateUtils.parseDate(s));
const днейМежду = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / 864e5);

let ret = null;           // событие
let payer = null;         // {id, name} — организатор, если уже выбран
let lines = [];           // строки листа
let removed = 0;          // мест из прошлого листа больше нет в шахматке
let marked = new Set();   // отмеченные строки — для «сразу всем»
let expanded = null;      // строка, раскрытая по дням
let dirty = false;        // есть несохранённые правки
let tariff = null;

// ==================== РАСЧЁТ ====================
function расчёт(l) {
    const заНочь = l.people > 0 ? round2(l.roomPrice / l.people) : 0;
    const завтраков = l.persons * l.meals.filter(m => m.b).length;
    const обедов = l.persons * l.meals.filter(m => m.l).length;
    const проживание = round2(l.nights * заНочь);
    const питание = round2(завтраков * l.bPrice + обедов * l.lPrice);
    const доп = round2(Number(l.extra) || 0);
    return { заНочь, завтраков, обедов, проживание, питание, доп, итого: round2(проживание + питание + доп) };
}

function итоги(list = lines) {
    return list.reduce((a, l) => {
        const r = расчёт(l);
        a.проживание += r.проживание; a.питание += r.питание; a.доп += r.доп;
        a.завтраков += r.завтраков; a.обедов += r.обедов;
        return a;
    }, { проживание: 0, питание: 0, доп: 0, завтраков: 0, обедов: 0 });
}

// ==================== ЗАГРУЗКА ====================
async function open() {
    const retreatId = FinParticipants.currentRetreat();
    if (!retreatId) return;
    const modal = document.getElementById('groupChargeModal');
    document.getElementById('grBody').innerHTML = `<tr><td colspan="13" class="text-center py-6"><span class="loading loading-spinner loading-md"></span></td></tr>`;
    modal.showModal();
    const [{ data: trf }, { data, error }] = await Promise.all([
        Layout.db.rpc('fin_get_stay_tariffs', { p_on: DateUtils.toISO(new Date()) }),
        Layout.db.rpc('fin_group_get', { p_retreat: retreatId })
    ]);
    if (error) { Layout.handleError(error, 'Группа'); modal.close(); return; }
    tariff = trf?.current;
    if (!tariff) { Layout.showNotification('Сначала заведите тарифы (Гости без события → Тарифы)', 'warning'); modal.close(); return; }
    ret = data.retreat;
    payer = data.payer;
    marked = new Set(); expanded = null; dirty = false;
    document.getElementById('grTitle').textContent = ret.name;
    await buildLines(data);
    renderPayer();
    renderRates();
    render();
}

// Строки из шахматки + сохранённые правки. Если даты места в шахматке поменялись
// (уехал раньше) — ночи и питание заново из шахматки, цены и имя остаются
async function buildLines(data) {
    const saved = new Map((data.sheet?.lines || []).map(l => [l.key, l]));
    const places = data.places || [];
    const eaters = data.eaters || [];
    const дни = [...places.map(p => p.check_in), ...places.map(p => p.check_out), ...eaters.map(g => g.start_date), ...eaters.map(g => g.end_date)]
        .filter(Boolean).sort();
    const поДням = new Map();
    if (дни.length) {
        const { data: ed } = await Layout.db.rpc('eating_detail', { p_from: дни[0], p_to: дни[дни.length - 1] });
        for (const r of ed || []) {
            if (!поДням.has(r.ref_id)) поДням.set(r.ref_id, []);
            поДням.get(r.ref_id).push({ d: r.d, b: !!r.breakfast, l: !!r.lunch });
        }
        поДням.forEach(a => a.sort((x, y) => x.d.localeCompare(y.d)));
    }
    const ключи = new Set();
    lines = [];
    for (const p of places) {
        const key = 'r:' + p.resident_id;
        ключи.add(key);
        const cap = Number(p.capacity) || 2;
        const fresh = {
            nights: p.check_out ? Math.max(днейМежду(p.check_in, p.check_out), 0) : 0,
            people: Math.max(Number(p.roommates) || 1, 1),
            meals: p.has_meals === false ? [] : (поДням.get(p.resident_id) || []).map(m => ({ ...m }))
        };
        const s = saved.get(key);
        const тотЖе = s && s.check_in === p.check_in && s.check_out === p.check_out;
        lines.push({
            key, place: p, resident_id: p.resident_id, persons: 1,
            label: s?.label || p.name || '',
            roomPrice: s ? Number(s.room_price) : Number(cap <= 2 ? tariff.room2_price : tariff.room4_price),
            bPrice: s ? Number(s.b_price) : Number(tariff.breakfast_price),
            lPrice: s ? Number(s.l_price) : Number(tariff.lunch_price),
            extra: s ? Number(s.extra) || 0 : 0,
            nights: тотЖе ? Number(s.nights) : fresh.nights,
            people: тотЖе ? Number(s.people) : fresh.people,
            meals: тотЖе && Array.isArray(s.meals) ? s.meals.map(m => ({ ...m })) : fresh.meals,
            fresh,
            changed: !!s && !тотЖе
        });
    }
    for (const g of eaters) {
        const key = 'g:' + g.meal_group_id;
        ключи.add(key);
        const s = saved.get(key);
        const fresh = { nights: 0, people: 1, meals: (поДням.get(g.meal_group_id) || []).map(m => ({ ...m })) };
        const тотЖе = s && s.check_in === g.start_date && s.check_out === g.end_date;
        lines.push({
            key, eater: g, meal_group_id: g.meal_group_id, persons: Number(g.people_count) || 1,
            label: s?.label || g.name || '',
            roomPrice: 0, nights: 0, people: 1,
            bPrice: s ? Number(s.b_price) : Number(tariff.breakfast_price),
            lPrice: s ? Number(s.l_price) : Number(tariff.lunch_price),
            extra: s ? Number(s.extra) || 0 : 0,
            meals: тотЖе && Array.isArray(s.meals) ? s.meals.map(m => ({ ...m })) : fresh.meals,
            fresh,
            changed: !!s && !тотЖе
        });
    }
    removed = [...saved.keys()].filter(k => !ключи.has(k)).length;
    if (removed || lines.some(l => l.changed)) dirty = true;
}

// ==================== ОРГАНИЗАТОР ====================
function renderPayer() {
    const el = document.getElementById('grPayer');
    if (payer) {
        el.innerHTML = `<span class="opacity-60">Платит организатор:</span> <b>${e(payer.name)}</b>${payer.phone ? ` · ${e(payer.phone)}` : ''}
            <button type="button" class="btn btn-ghost btn-xs" data-gr-payer-change>сменить</button>`;
        return;
    }
    el.innerHTML = `<div class="border border-warning/40 bg-warning/5 rounded-lg p-2">
        <div class="text-xs font-semibold mb-1">Кто платит за группу? Организатор собирает со всех и платит одной суммой — начисления будут на его карточке</div>
        <div class="flex flex-wrap items-center gap-2">
            <div class="relative"><input type="text" id="grPayerSearch" class="input input-bordered input-xs w-64" placeholder="Найти карточку по имени…"></div>
            <input type="hidden" id="grPayerId">
            <span class="text-xs opacity-60">или новая:</span>
            <input type="text" id="grNpName" class="input input-bordered input-xs w-44" placeholder="Имя">
            <input type="text" id="grNpPhone" class="input input-bordered input-xs w-36" placeholder="Телефон *">
            <input type="email" id="grNpEmail" class="input input-bordered input-xs w-44" placeholder="Почта *">
        </div>
    </div>`;
    FinUtils.attachPersonSearch(document.getElementById('grPayerSearch'), document.getElementById('grPayerId'));
}

// ==================== КУРС СОБЫТИЯ ====================
function renderRates() {
    const rates = FinParticipants.rates();
    const parts = Object.entries(rates).filter(([c]) => c !== 'INR')
        .map(([c, r]) => `1 ${FinUtils.symbol(c)} = ${Number(r).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₹`);
    const валюты = FinUtils.refs.currencies.filter(c => c.is_active !== false && c.code !== 'INR');
    document.getElementById('grRates').innerHTML = `
        ${parts.length ? `<span class="opacity-60">Курс события:</span> ${parts.join(' · ')}`
            : '<span class="text-warning">Курса события нет — оплата не в ₹ не пройдёт</span>'}
        <details class="dropdown" data-permission="fin_admin">
            <summary class="btn btn-ghost btn-xs">+ курс</summary>
            <div class="dropdown-content z-50 bg-base-100 shadow-lg rounded-lg p-2 flex items-center gap-1 w-72">
                1 <select id="grRateCur" class="select select-bordered select-xs">${валюты.map(c => `<option value="${c.code}">${e(c.symbol)} ${c.code}</option>`).join('')}</select>
                = <input type="number" id="grRateVal" min="0.0001" step="0.0001" class="input input-bordered input-xs w-20"> ₹
                <button type="button" class="btn btn-primary btn-xs" data-gr-rate-save>OK</button>
            </div>
        </details>`;
}

async function saveRate() {
    const rate = Number(document.getElementById('grRateVal').value);
    if (!(rate > 0)) { Layout.showNotification('Введите курс', 'warning'); return; }
    const objectId = await FinParticipants.ensureObjectId();
    if (!objectId) return;
    const res = await FinUtils.rpc('fin_save_exchange_rate', {
        object_id: objectId, effective_date: DateUtils.toISO(new Date()),
        from_currency: document.getElementById('grRateCur').value, rate
    });
    if (!FinUtils.handleResult(res)) return;
    await FinParticipants.reloadRates();
    renderRates();
}

// ==================== ТАБЛИЦА ====================
const цели = () => marked.size ? lines.filter(l => marked.has(l.key)) : lines;

function render() {
    const body = document.getElementById('grBody');
    let прежняяКомната = null;
    body.innerHTML = lines.map((l, i) => {
        const r = расчёт(l);
        const p = l.place;
        const комната = p ? `${p.building || ''} №${p.room || '—'}` : 'Питание';
        const первая = комната !== прежняяКомната;
        прежняяКомната = комната;
        const даты = p ? `${дата(p.check_in)}–${p.check_out ? дата(p.check_out) : '…'}` : `${дата(l.eater.start_date)}–${дата(l.eater.end_date)}`;
        const числа = (k, v, w, step = 1, title = '') => `<input type="number" min="0" step="${step}" class="input input-bordered input-xs ${w} px-1 text-right" data-gr-f="${i}" data-k="${k}" value="${v}" ${title ? `title="${title}"` : ''}>`;
        const row = `<tr class="${marked.has(l.key) ? 'bg-primary/5' : ''} ${первая && i ? 'border-t-2 border-base-300' : ''}">
            <td><input type="checkbox" class="checkbox checkbox-xs" data-gr-mark="${l.key}" ${marked.has(l.key) ? 'checked' : ''}></td>
            <td class="whitespace-nowrap ${первая ? 'font-medium' : 'opacity-30'}">${e(комната)}${p && первая ? ` <span class="opacity-50 text-[10px]">${p.capacity}-м.</span>` : ''}</td>
            <td><input type="text" class="input input-ghost input-xs w-36 px-1" data-gr-f="${i}" data-k="label" value="${e(l.label)}" placeholder="${p ? 'место' : ''}">
                ${l.changed ? '<span class="badge badge-warning badge-xs" title="Даты в шахматке изменились — ночи и питание пересчитаны заново">шахматка</span>' : ''}
                ${l.eater ? `<span class="badge badge-ghost badge-xs">${l.persons} чел.</span>` : ''}</td>
            <td class="whitespace-nowrap text-xs">${даты}</td>
            <td>${p ? числа('nights', l.nights, 'w-12') : ''}</td>
            <td class="whitespace-nowrap">${p ? `${числа('roomPrice', l.roomPrice, 'w-16', 50, 'Цена номера за сутки')} ÷ ${числа('people', l.people, 'w-10', 1, 'Сколько человек делят номер')}` : ''}</td>
            <td class="text-right font-mono">${p ? inr(r.проживание) : ''}</td>
            <td class="text-right">${r.завтраков}</td>
            <td class="text-right">${r.обедов}</td>
            <td class="text-right font-mono">${inr(r.питание)}</td>
            <td>${числа('extra', l.extra || '', 'w-16', 10)}</td>
            <td class="text-right font-mono font-semibold">${inr(r.итого)}</td>
            <td><button type="button" class="btn btn-ghost btn-xs" data-gr-expand="${l.key}" title="Питание по дням, цены">${expanded === l.key ? '▾' : '▸'}</button></td>
        </tr>`;
        return row + (expanded === l.key ? detailRow(l, i) : '');
    }).join('') || `<tr><td colspan="13" class="text-center py-6 opacity-60">В шахматке нет мест этого события</td></tr>`;
    renderBulk();
    renderTotal();
}

// Раскрытая строка: завтраки/обеды по дням и цены
function detailRow(l, i) {
    return `<tr class="bg-base-200/50"><td></td><td colspan="12">
        <div class="flex flex-wrap gap-1 mb-1">
            ${l.meals.map((m, j) => `<div class="border border-base-300 rounded px-1.5 py-0.5 text-xs bg-base-100">
                <div class="font-medium">${дата(m.d)}</div>
                <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" data-gr-meal="${i}" data-j="${j}" data-m="b" ${m.b ? 'checked' : ''}> завтрак</label>
                <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" data-gr-meal="${i}" data-j="${j}" data-m="l" ${m.l ? 'checked' : ''}> обед</label>
            </div>`).join('') || '<span class="text-xs opacity-60">Питание в шахматке выключено</span>'}
        </div>
        <div class="flex flex-wrap items-center gap-1 text-xs">
            завтрак <input type="number" min="0" step="10" class="input input-bordered input-xs w-20" data-gr-f="${i}" data-k="bPrice" value="${l.bPrice}">
            обед <input type="number" min="0" step="10" class="input input-bordered input-xs w-20" data-gr-f="${i}" data-k="lPrice" value="${l.lPrice}">
            ${l.place ? `<span class="opacity-60 ml-2">Завтрак в день заезда и обед в день выезда уйдут в шахматку (ранний заезд / поздний выезд)</span>` : ''}
            <button type="button" class="btn btn-ghost btn-xs ml-auto" data-gr-fresh="${i}">вернуть по шахматке</button>
        </div>
    </td></tr>`;
}

// «Сразу всем»: к отмеченным строкам, а если не отмечено ничего — ко всем
function renderBulk() {
    const t = цели();
    const днис = [...new Set(t.flatMap(l => l.meals.map(m => m.d)))].sort();
    const состояние = (d, k) => {
        const есть = t.filter(l => l.meals.some(m => m.d === d));
        const вкл = есть.filter(l => l.meals.find(m => m.d === d)[k]).length;
        return вкл === 0 ? '' : вкл === есть.length ? 'checked' : 'data-mixed="1"';
    };
    document.getElementById('grBulkWho').textContent = marked.size ? `отмеченным (${marked.size})` : `всем (${lines.length})`;
    document.getElementById('grBulkDays').innerHTML = днис.map(d => `<div class="border border-base-300 rounded px-1.5 py-0.5 text-xs">
        <div class="font-medium">${дата(d)}</div>
        <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" data-gr-day="${d}" data-m="b" ${состояние(d, 'b')}> завтрак</label>
        <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" data-gr-day="${d}" data-m="l" ${состояние(d, 'l')}> обед</label>
    </div>`).join('');
    document.querySelectorAll('#grBulkDays [data-mixed]').forEach(el => { el.indeterminate = true; });
}

function applyBulkPrices() {
    const val = id => { const v = document.getElementById(id).value; return v === '' ? null : Number(v); };
    const r2 = val('grB2'), r4 = val('grB4'), b = val('grBB'), l = val('grBL');
    if ([r2, r4, b, l].every(x => x === null)) { Layout.showNotification('Впишите хотя бы одну цену', 'warning'); return; }
    for (const x of цели()) {
        if (x.place && r2 !== null && (Number(x.place.capacity) || 2) <= 2) x.roomPrice = r2;
        if (x.place && r4 !== null && (Number(x.place.capacity) || 2) > 2) x.roomPrice = r4;
        if (b !== null) x.bPrice = b;
        if (l !== null) x.lPrice = l;
    }
    ['grB2', 'grB4', 'grBB', 'grBL'].forEach(id => { document.getElementById(id).value = ''; });
    dirty = true;
    render();
}

function freshAll(list) {
    for (const l of list) {
        l.nights = l.fresh.nights;
        l.people = l.fresh.people;
        l.meals = l.fresh.meals.map(m => ({ ...m }));
        l.changed = false;
    }
    dirty = true;
    render();
}

function renderTotal() {
    const s = итоги();
    const всего = round2(s.проживание + s.питание + s.доп);
    document.getElementById('grTotal').innerHTML = `
        ${removed ? `<div class="text-warning text-xs">${removed} мест(а) из прошлого расчёта больше нет в шахматке — выпадут при пересчёте</div>` : ''}
        Проживание <b class="font-mono">${inr(s.проживание)}</b> · питание <b class="font-mono">${inr(s.питание)}</b>
        <span class="opacity-60">(завтраков ${s.завтраков}, обедов ${s.обедов})</span>${s.доп ? ` · доп. <b class="font-mono">${inr(s.доп)}</b>` : ''}
        · <b>итого <span class="font-mono">${inr(всего)}</span></b>
        ${dirty ? ' <span class="badge badge-warning badge-sm">не сохранено</span>' : ''}`;
    document.getElementById('grSave').textContent = payer ? 'Пересчитать начисления' : 'Начислить организатору';
}

// ==================== СОХРАНЕНИЕ ====================
async function save() {
    const payload = { retreat_id: ret.id, lines: lines.map(toLine) };
    if (!payer) {
        const pid = document.getElementById('grPayerId')?.value;
        const имя = document.getElementById('grNpName')?.value.trim();
        if (pid) payload.payer_id = pid;
        else if (имя) {
            payload.new_person = { spiritual_name: имя,
                phone: document.getElementById('grNpPhone').value.trim(), email: document.getElementById('grNpEmail').value.trim() };
            if (!payload.new_person.phone && !payload.new_person.email) { Layout.showNotification('Нужен телефон или почта организатора', 'warning'); return; }
        } else { Layout.showNotification('Выберите организатора — кто платит за группу', 'warning'); return; }
    }
    const res = await FinUtils.rpc('fin_group_save', payload);
    if (!res?.ok) { Layout.showNotification(res?.error?.message || 'Ошибка', 'error'); return; }
    const r = res.result;
    const названия = { accommodation: 'проживание', meals: 'питание', extra: 'доп.' };
    Layout.showNotification(r.changed.length
        ? `Начислено организатору: ${r.changed.map(k => названия[k]).join(', ')} обновлено`
        : 'Сохранено — суммы не изменились', 'success');
    dirty = false;
    document.getElementById('groupChargeModal').close();
    await FinParticipants.reload();
    FinParticipants.openCardById(r.payer_id);
}

function toLine(l) {
    const r = расчёт(l);
    const o = {
        key: l.key, label: l.label || null, nights: l.nights, room_price: l.roomPrice, people: l.people,
        breakfasts: r.завтраков, lunches: r.обедов, b_price: l.bPrice, l_price: l.lPrice, extra: Number(l.extra) || 0,
        meals: l.meals, persons: l.persons
    };
    if (l.place) {
        Object.assign(o, { resident_id: l.resident_id, check_in: l.place.check_in, check_out: l.place.check_out });
        // края питания → шахматка, только если дни заезда/выезда есть в расчёте
        const first = l.meals[0], last = l.meals[l.meals.length - 1];
        if (first && first.d === l.place.check_in) o.early_checkin = !!first.b;
        if (last && last.d === l.place.check_out) o.late_checkout = !!last.l;
    } else {
        Object.assign(o, { meal_group_id: l.meal_group_id, check_in: l.eater.start_date, check_out: l.eater.end_date });
    }
    return o;
}

// ==================== СВОДКА ОРГАНИЗАТОРУ ====================
// По комнатам: места, даты, ночи, проживание, питание; итог, валюта, курс, оплачено, остаток
async function summaryData() {
    const комнаты = [];
    for (const l of lines) {
        const r = расчёт(l);
        const имя = l.place ? `${l.place.building || ''} №${l.place.room || '—'}` : `Питание: ${l.label || 'группа'}`;
        let k = комнаты.find(x => x.имя === имя && x.place === !!l.place);
        if (!k) { k = { имя, place: !!l.place, cap: l.place?.capacity, мест: 0, имена: [], ночи: new Set(), даты: new Set(), проживание: 0, завтраков: 0, обедов: 0, питание: 0, доп: 0 }; комнаты.push(k); }
        k.мест += l.place ? 1 : l.persons;
        if (l.place && l.label) k.имена.push(l.label);
        if (l.place) { k.ночи.add(l.nights); k.даты.add(`${дата(l.place.check_in)}–${l.place.check_out ? дата(l.place.check_out) : '…'}`); }
        else k.даты.add(`${дата(l.eater.start_date)}–${дата(l.eater.end_date)}`);
        k.проживание += r.проживание; k.завтраков += r.завтраков; k.обедов += r.обедов; k.питание += r.питание; k.доп += r.доп;
    }
    let bal = null;
    if (payer) {
        const { data } = await Layout.db.rpc('fin_get_participant_balance', { p_participant: payer.id, p_retreat: ret.id });
        bal = data;
    }
    const cur = bal?.system === 'settlement_currency' ? bal.currency : 'INR';
    const rate = cur === 'INR' ? 1 : Number(FinParticipants.rates()[cur]) || null;
    const сум = k => Object.values(bal?.blocks || {}).reduce((a, b) => a + (Number(b[k]) || 0), 0);
    return { комнаты, s: итоги(), bal, cur, rate, начислено: сум('charged'), оплачено: сум('paid'), остаток: Number(bal?.net) || 0 };
}

async function openSummary() {
    const d = await summaryData();
    const всего = round2(d.s.проживание + d.s.питание + d.s.доп);
    const m = v => FinUtils.fmtMoney(v, d.cur);
    const курс = d.cur !== 'INR' && d.rate ? `1 ${FinUtils.symbol(d.cur)} = ${d.rate.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ₹` : '';
    const строки = d.комнаты.map(k => `<tr>
        <td>${e(k.имя)}${k.cap ? ` <span style="opacity:.6">(${k.cap}-мест.)</span>` : ''}${k.имена.length ? `<br><span style="opacity:.6;font-size:11px">${e(k.имена.join(', '))}</span>` : ''}</td>
        <td style="text-align:right">${k.мест}</td>
        <td>${[...k.даты].join(', ')}</td>
        <td style="text-align:right">${k.place ? [...k.ночи].join('/') : ''}</td>
        <td style="text-align:right">${k.place ? inr(k.проживание) : ''}</td>
        <td style="text-align:right">${k.завтраков} / ${k.обедов}</td>
        <td style="text-align:right">${inr(k.питание)}</td>
        <td style="text-align:right"><b>${inr(k.проживание + k.питание + k.доп)}</b></td>
    </tr>`).join('');
    const html = `<h2 style="margin:0 0 4px">${e(ret.name)}</h2>
        <div style="opacity:.7;margin-bottom:10px">${датаГод(ret.start_date)} – ${датаГод(ret.end_date)}${payer ? ` · организатор: ${e(payer.name)}` : ''}</div>
        <table class="gr-sum">
            <thead><tr><th>Комната</th><th style="text-align:right">Мест</th><th>Даты</th><th style="text-align:right">Ночей</th><th style="text-align:right">Проживание</th><th style="text-align:right">Завтр. / обеды</th><th style="text-align:right">Питание</th><th style="text-align:right">Итого</th></tr></thead>
            <tbody>${строки}</tbody>
        </table>
        <table class="gr-sum" style="margin-top:12px;max-width:420px">
            <tr><td>Проживание</td><td style="text-align:right">${inr(d.s.проживание)}</td></tr>
            <tr><td>Питание (завтраков ${d.s.завтраков}, обедов ${d.s.обедов})</td><td style="text-align:right">${inr(d.s.питание)}</td></tr>
            ${d.s.доп ? `<tr><td>Дополнительно</td><td style="text-align:right">${inr(d.s.доп)}</td></tr>` : ''}
            <tr><td><b>Итого</b></td><td style="text-align:right"><b>${inr(всего)}</b></td></tr>
            ${d.cur !== 'INR' ? `<tr><td>Валюта расчёта: ${d.cur}${курс ? `, курс ${курс}` : ''}</td><td style="text-align:right">${d.rate ? m(round2(всего / d.rate)) : '—'}</td></tr>` : ''}
            ${d.bal ? `<tr><td>Начислено</td><td style="text-align:right">${m(d.начислено)}</td></tr>
            <tr><td>Оплачено</td><td style="text-align:right">${m(d.оплачено)}</td></tr>
            <tr><td><b>${d.остаток > 0 ? 'Осталось оплатить' : d.остаток < 0 ? 'Переплата' : 'Оплачено полностью'}</b></td><td style="text-align:right"><b>${d.остаток ? m(Math.abs(d.остаток)) : ''}</b></td></tr>` : ''}
        </table>
        ${dirty ? '<div style="color:#b45309;margin-top:8px">Внимание: в окне есть несохранённые правки — «начислено» и «осталось» по сохранённому</div>' : ''}`;
    document.getElementById('grSummaryBody').innerHTML = html;
    document.getElementById('grSummaryText').value = summaryText(d);
    document.getElementById('groupSummaryModal').showModal();
}

function summaryText(d) {
    const всего = round2(d.s.проживание + d.s.питание + d.s.доп);
    const m = v => FinUtils.fmtMoney(v, d.cur);
    const out = [`${ret.name} · ${датаГод(ret.start_date)} – ${датаГод(ret.end_date)}`];
    if (payer) out.push(`Организатор: ${payer.name}`);
    out.push('');
    for (const k of d.комнаты) {
        const части = [`${k.имя}: ${k.place ? `мест ${k.мест}` : `${k.мест} чел.`}`, [...k.даты].join(', ')];
        if (k.place) части.push(`${[...k.ночи].join('/')} ноч., проживание ${inr(k.проживание)}`);
        if (k.питание) части.push(`завтраков ${k.завтраков}, обедов ${k.обедов} — ${inr(k.питание)}`);
        части.push(`итого ${inr(k.проживание + k.питание + k.доп)}`);
        out.push('• ' + части.join(' · ') + (k.имена.length ? ` (${k.имена.join(', ')})` : ''));
    }
    out.push('', `Проживание: ${inr(d.s.проживание)}`, `Питание: ${inr(d.s.питание)}`);
    if (d.s.доп) out.push(`Дополнительно: ${inr(d.s.доп)}`);
    out.push(`Итого: ${inr(всего)}`);
    if (d.cur !== 'INR' && d.rate) out.push(`В ${d.cur} по курсу 1 ${FinUtils.symbol(d.cur)} = ${d.rate.toLocaleString('ru-RU')} ₹: ${m(round2(всего / d.rate))}`);
    if (d.bal) {
        out.push(`Оплачено: ${m(d.оплачено)}`);
        out.push(d.остаток > 0 ? `Осталось оплатить: ${m(d.остаток)}` : d.остаток < 0 ? `Переплата: ${m(-d.остаток)}` : 'Оплачено полностью');
    }
    return out.join('\n');
}

async function copySummary() {
    const ok = await FinUtils.copyText(document.getElementById('grSummaryText').value);
    Layout.showNotification(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error');
}

// PDF — через печать браузера («Сохранить как PDF»)
function printSummary() {
    const w = window.open('', '_blank');
    if (!w) { Layout.showNotification('Браузер не дал открыть окно печати', 'error'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${e(ret.name)}</title>
        <style>body{font:13px/1.4 system-ui,sans-serif;margin:24px;color:#111}
        .gr-sum{border-collapse:collapse;width:100%}.gr-sum td,.gr-sum th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
        .gr-sum th{font-size:11px;text-transform:uppercase;opacity:.7}</style></head>
        <body>${document.getElementById('grSummaryBody').innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
}

// ==================== СОБЫТИЯ ====================
function init() {
    const modal = document.getElementById('groupChargeModal');
    if (!modal) return;
    const saveBtn = document.getElementById('grSave');
    saveBtn.addEventListener('click', async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        try { await save(); } finally { saveBtn.disabled = false; }
    });
    // закрыть с несохранёнными правками — только осознанно
    modal.addEventListener('cancel', ev => { if (dirty && !confirm('Правки не сохранены. Закрыть?')) ev.preventDefault(); });

    modal.addEventListener('click', ev => {
        const t = ev.target;
        if (t.closest('[data-gr-payer-change]')) { payer = null; renderPayer(); renderTotal(); return; }
        if (t.closest('[data-gr-rate-save]')) { saveRate(); return; }
        const exp = t.closest('[data-gr-expand]');
        if (exp) { expanded = expanded === exp.dataset.grExpand ? null : exp.dataset.grExpand; render(); return; }
        const fr = t.closest('[data-gr-fresh]');
        if (fr) { freshAll([lines[Number(fr.dataset.grFresh)]]); return; }
    });
    modal.addEventListener('change', ev => {
        const el = ev.target;
        if (el.dataset.grMark !== undefined) {
            el.checked ? marked.add(el.dataset.grMark) : marked.delete(el.dataset.grMark);
            render();
        } else if (el.id === 'grMarkAll') {
            marked = el.checked ? new Set(lines.map(l => l.key)) : new Set();
            render();
        } else if (el.dataset.grMeal !== undefined) {
            lines[Number(el.dataset.grMeal)].meals[Number(el.dataset.j)][el.dataset.m] = el.checked;
            dirty = true; render();
        } else if (el.dataset.grDay) {
            // «группа не ела 02.10» — снять/поставить у всех целевых строк сразу
            for (const l of цели()) { const m = l.meals.find(x => x.d === el.dataset.grDay); if (m) m[el.dataset.m] = el.checked; }
            dirty = true; render();
        } else if (el.dataset.grF !== undefined) {
            const l = lines[Number(el.dataset.grF)];
            const k = el.dataset.k;
            l[k] = k === 'label' ? el.value : Math.max(Number(el.value) || 0, k === 'people' ? 1 : 0);
            dirty = true; render();
        }
    });
    document.getElementById('grBulkApply').addEventListener('click', applyBulkPrices);
    document.getElementById('grBulkFresh').addEventListener('click', () => freshAll(цели()));
}

function close() {
    if (dirty && !confirm('Правки не сохранены. Закрыть?')) return;
    document.getElementById('groupChargeModal').close();
}

window.FinGroup = { open, close, openSummary, copySummary, printSummary };
init();
})();
