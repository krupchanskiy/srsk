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
let draft = false;        // лист сохранён черновиком, но не начислен (ВГ, 02.10)
let tariff = null;
let rooms = [];           // цены номеров по услугам CRM (здание × вместимость), из «Тарифов»
let bookings = [];        // брони события: мест в брони / в шахматке
let advances = [];        // аванс группы: «Предоплата/Аванс» на событие без человека (ВГ, 02.10)
let payerKey = null;      // организатор выбран из строки списка — карточка заведётся при сохранении
const ПРИЧИНА = 'за счёт ашрама';

// Питание по умолчанию, когда в шахматке оно было выключено: как у кухни без времени
// приезда — в день заезда без завтрака, в день выезда без обеда (ранний/поздний — с ними)
function питаниеПоДатам(p) {
    const out = [];
    if (!p.check_out) return out;
    for (let d = DateUtils.parseDate(p.check_in); d <= DateUtils.parseDate(p.check_out); d.setDate(d.getDate() + 1)) {
        const iso = DateUtils.toISO(d);
        out.push({ d: iso, b: iso !== p.check_in || !!p.early_checkin, l: iso !== p.check_out || !!p.late_checkout });
    }
    return out;
}

// Имена из заметки брони («Devadeva\nKarunamayi…»): в шахматке места без имён
function именаБрони(notes) {
    return (notes || '').split(/\n|\s{2,}|,/).map(x => x.trim()).filter(Boolean);
}

// ==================== РАСЧЁТ ====================
// Сняты ПОСЛЕДНИЕ дни (ни завтрака, ни обеда до конца) — человек уехал раньше (ВГ, 29.09):
// выезд — последний день, когда он ещё ел; при сохранении уходит в шахматку, кухня
// поправится сама. Снятые дни в середине (экскурсия) — не отъезд, шахматку не трогаем.
// Снят один только завтрак в день выезда — уехал утром, ночь была: тоже не отъезд, только деньги.
// Возвращает новую дату выезда или null
function раннийВыезд(l) {
    if (!l.place?.check_out || !l.meals.length) return null;
    const последний = [...l.meals].reverse().find(m => m.b || m.l);
    if (!последний || последний.d < l.place.check_in || последний.d >= l.place.check_out) return null;
    // накануне выезда был обед, в день выезда ничего — уехал утром без завтрака, не раньше
    if (днейМежду(последний.d, l.place.check_out) === 1 && последний.l) return null;
    return последний.d;
}

// Ночи с учётом раннего выезда: больше, чем до новой даты выезда, не бывает
function ночей(l) {
    const выезд = раннийВыезд(l);
    return выезд ? Math.min(l.nights, днейМежду(l.place.check_in, выезд)) : l.nights;
}

// Доля номера за ночь — целыми рупиями, сумма долей = цена номера (ВГ, 02.10: без «хвостиков»
// вроде ₹5 499,99): ₹5 500 на троих = 1 834 + 1 833 + 1 833, лишняя рупия — первым в номере
function доля(l) {
    if (!(l.people > 0)) return 0;
    const база = Math.floor(l.roomPrice / l.people);
    const остаток = Math.round(l.roomPrice - база * l.people);
    if (!остаток) return база;
    if (l.roomPrice !== Math.round(l.roomPrice)) return round2(l.roomPrice / l.people);   // цена с пайсами — как раньше
    const соседи = lines.filter(x => x.place && !x.extraBed && ключКомнаты(x) === ключКомнаты(l)
        && x.roomPrice === l.roomPrice && x.people === l.people);
    const i = соседи.indexOf(l);
    return база + (i >= 0 && i < остаток ? 1 : 0);
}

function расчёт(l) {
    // на доп. кровати — цена доп. кровати за ночь, иначе номер ÷ жильцов
    const заНочь = l.extraBed ? round2(l.extraBedPrice) : доля(l);
    const завтраков = l.persons * l.meals.filter(m => m.b).length;
    const обедов = l.persons * l.meals.filter(m => m.l).length;
    const проживание = round2(ночей(l) * заНочь);
    const питание = round2(завтраков * l.bPrice + обедов * l.lPrice);
    const доп = round2(Number(l.extra) || 0);
    return { заНочь, завтраков, обедов, проживание, питание, доп, итого: round2(проживание + питание + доп) };
}

// Платит сам (ВГ, 02.10): место остаётся в группе, сумма — на его карточке, не организатору
const вСчётГруппы = l => l.included && !l.selfPay;
const сами = () => lines.filter(l => l.included && l.selfPay);
const авансИтого = () => round2(advances.reduce((a, x) => a + (Number(x.amount_inr) || 0), 0));

// Пропущенные приёмы строки: по шахматке был, в окне снят. База — питание из шахматки
// без прежних пропусков (они тоже отсюда); дни после раннего выезда — не пропуск
function пропущено(l, k) {
    const выезд = раннийВыезд(l);
    const база = l.base || l.fresh.meals;
    return l.meals.filter(m => !m[k] && база.find(x => x.d === m.d)?.[k] && !(выезд && m.d > выезд)).map(m => m.d);
}

function итоги(list = lines.filter(вСчётГруппы)) {
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
    rooms = trf?.rooms || [];
    if (!tariff) { Layout.showNotification('Сначала заведите тарифы (Гости без события → Тарифы)', 'warning'); modal.close(); return; }
    ret = data.retreat;
    payer = data.payer;
    advances = data.advances || [];
    payerKey = null;
    marked = new Set(); expanded = null; dirty = false; draft = !!data.sheet?.draft;
    document.getElementById('grTitle').textContent = ret.name;
    await buildLines(data);
    // организатор из строки списка, выбранный в черновике
    if (!payer) payerKey = (data.sheet?.lines || []).find(l => l.org && lines.some(x => x.key === l.key))?.key || null;
    fillPrices(data.sheet?.prices);
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
        // постранично: за длинный период у всех гостей больше 1000 строк
        const ed = [];
        for (let off = 0; ; off += 1000) {
            const { data } = await Layout.db.rpc('eating_detail', { p_from: дни[0], p_to: дни[дни.length - 1] })
                .order('d').order('ref_id').range(off, off + 999);
            ed.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        for (const r of ed) {
            if (!поДням.has(r.ref_id)) поДням.set(r.ref_id, []);
            поДням.get(r.ref_id).push({ d: r.d, b: !!r.breakfast, l: !!r.lunch });
        }
        поДням.forEach(a => a.sort((x, y) => x.d.localeCompare(y.d)));
    }
    const ключи = new Set();
    bookings = data.bookings || [];
    const именаПоБрони = new Map();
    lines = [];
    for (const p of places) {
        // имя из заметки брони — по порядку мест брони; правится в строке. Только если имён
        // ровно столько, сколько мест: иначе в заметке описание («Махарадж и двое слуг»)
        if (p.booking_id && !именаПоБрони.has(p.booking_id)) {
            const имена = именаБрони(p.booking_notes);
            const мест = places.filter(x => x.booking_id === p.booking_id).length;
            именаПоБрони.set(p.booking_id, имена.length === мест ? имена : []);
        }
        const изБрони = !p.name && p.booking_id ? именаПоБрони.get(p.booking_id).shift() : null;
        const key = 'r:' + p.resident_id;
        ключи.add(key);
        // Место без номера (живёт сам, ест с нами — ВГ, 29.09): только питание, без ночей и цены номера
        const тип = p.room_id ? FinGuests.типНомера(p, rooms) : null;
        const s = saved.get(key);
        // питание включили здесь и сохранили черновиком — в шахматке оно ещё выключено
        const mealsOn = !!s?.has_meals && p.has_meals === false;
        const fresh = {
            nights: p.room_id && p.check_out ? Math.max(днейМежду(p.check_in, p.check_out), 0) : 0,
            people: Math.max(Number(p.roommates) || 1, 1),
            meals: mealsOn ? питаниеПоДатам(p) : p.has_meals === false ? [] : (поДням.get(p.resident_id) || []).map(m => ({ ...m }))
        };
        // база для пропусков: шахматка без прежних пропусков этого места
        const base = fresh.meals.map(m => {
            const sk = (p.skips || []).find(x => x.d === m.d);
            return { d: m.d, b: m.b || !!sk?.b, l: m.l || !!sk?.l };
        });
        const тотЖе = s && s.check_in === p.check_in && s.check_out === p.check_out;
        lines.push({
            key, place: p, resident_id: p.resident_id, persons: 1, base,
            selfPay: !!s?.self_pay,
            label: s?.label || p.name || изБрони || '',
            included: s ? s.included !== false : true,
            excludeReason: s?.exclude_reason || '',
            mealsOn,          // питание включили здесь — уйдёт в шахматку
            // цена номера — по зданию и вместимости, как в прайсе ретритов (FinGuests.типНомера);
            // меньшая вместимость типа = доп. кровать; цена не задана — вписать вручную
            roomType: тип,
            roomPrice: s ? Number(s.room_price) : p.room_id ? Number(тип?.price) || 0 : 0,
            extraBed: !!s?.extra_bed,
            extraBedPrice: s?.extra_bed_price != null ? Number(s.extra_bed_price) : Number(tariff.extra_bed_price) || 0,
            bPrice: s ? Number(s.b_price) : Number(tariff.breakfast_price),
            lPrice: s ? Number(s.l_price) : Number(tariff.lunch_price),
            extra: s ? Number(s.extra) || 0 : 0,
            nights: тотЖе ? Number(s.nights) : fresh.nights,
            people: тотЖе ? Number(s.people) : fresh.people,
            meals: тотЖе && Array.isArray(s.meals) ? s.meals.map(m => ({ ...m })) : fresh.meals.map(m => ({ ...m })),
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
            included: s ? s.included !== false : true,
            excludeReason: s?.exclude_reason || '',
            roomPrice: 0, nights: 0, people: 1,
            bPrice: s ? Number(s.b_price) : Number(tariff.breakfast_price),
            lPrice: s ? Number(s.l_price) : Number(tariff.lunch_price),
            extra: s ? Number(s.extra) || 0 : 0,
            meals: тотЖе && Array.isArray(s.meals) ? s.meals.map(m => ({ ...m })) : fresh.meals.map(m => ({ ...m })),
            fresh,
            changed: !!s && !тотЖе
        });
    }
    removed = [...saved.keys()].filter(k => !ключи.has(k)).length;
    if (removed || lines.some(l => l.changed)) dirty = true;
}

// ==================== ОРГАНИЗАТОР ====================
// Организатор — строка списка: он живёт с группой (ВГ, 02.10)
const строкаОрганизатора = () => payerKey ? lines.find(l => l.key === payerKey)
    : payer ? lines.find(l => l.place?.vaishnava_id && l.place.vaishnava_id === payer.id) : null;

function renderPayer() {
    const el = document.getElementById('grPayer');
    if (payerKey) {
        const l = lines.find(x => x.key === payerKey);
        el.innerHTML = `<span class="opacity-60">Платит организатор:</span> <b>${e(l?.label || 'место без имени')}</b>
            <span class="text-xs opacity-60">(живёт с группой${l?.place?.vaishnava_id ? '' : ' — карточка заведётся при сохранении'})</span>
            <button type="button" class="btn btn-ghost btn-xs" data-gr-payer-change>сменить</button>`;
        return;
    }
    if (payer) {
        el.innerHTML = `<span class="opacity-60">Платит организатор:</span> <b>${e(payer.name)}</b>${payer.phone ? ` · ${e(payer.phone)}` : ''}
            <button type="button" class="btn btn-ghost btn-xs" data-gr-payer-change>сменить</button>`;
        return;
    }
    el.innerHTML = `<div class="border border-warning/40 bg-warning/5 rounded-lg p-2">
        <div class="text-xs font-semibold mb-1">Кто платит за группу? Организатор собирает со всех и платит одной суммой — начисления будут на его карточке.
            <span class="font-normal opacity-70">Живёт с группой — выберите «организатор» в колонке «Платит» его строки; иначе найдите карточку или впишите имя</span></div>
        <div class="flex flex-wrap items-center gap-2">
            <div class="relative"><input type="text" id="grPayerSearch" class="input input-bordered input-xs w-64" placeholder="Найти карточку по имени…"></div>
            <input type="hidden" id="grPayerId">
            <span class="text-xs opacity-60">или новая:</span>
            <input type="text" id="grNpName" class="input input-bordered input-xs w-44" placeholder="Имя">
            <input type="text" id="grNpPhone" class="input input-bordered input-xs w-36" placeholder="Телефон">
            <input type="email" id="grNpEmail" class="input input-bordered input-xs w-44" placeholder="Почта">
        </div>
    </div>`;
    FinUtils.attachPersonSearch(document.getElementById('grPayerSearch'), document.getElementById('grPayerId'));
}

// ==================== КУРС СОБЫТИЯ ====================
function renderRates() {
    const rates = FinParticipants.rates();
    const parts = Object.entries(rates).filter(([c]) => c !== 'INR')
        .map(([c, r]) => `1 ${FinUtils.symbol(c)} = ${Number(r).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₹ <span class="opacity-60">(${FinParticipants.rateIsOwn(c) ? 'свой' : 'общий'})</span>`);
    const валюты = FinUtils.refs.currencies.filter(c => c.is_active !== false && c.code !== 'INR');
    document.getElementById('grRates').innerHTML = `
        ${parts.length ? `<span class="opacity-60">Курс:</span> ${parts.join(' · ')}`
            : '<span class="text-warning">Курсов нет — оплата не в ₹ не пройдёт</span>'}
        <details class="dropdown" data-permission="fin_admin">
            <summary class="btn btn-ghost btn-xs" title="Договорной курс для этого события; без него действует общий">+ свой курс</summary>
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

// Комната + период — одна группа строк: у группы разные заезды по номерам (ВГ, 28.09)
// Без номера — по брони: места одной групповой брони вместе, разные брони не сливаются
const ключКомнаты = l => l.place ? `${l.place.room_id || 'b:' + (l.place.booking_id || l.key)}|${l.place.check_in}|${l.place.check_out}` : l.key;
// Название шапки: номер, место без номера или запись «Разового питания»
const имяГруппы = (p, label) => p?.room_id ? `${p.building || ''} №${p.room || '—'}`
    : p ? `Без номера: ${p.booking_name || label || 'питание'}` : `Разовое питание: ${label || 'группа'}`;

function render() {
    const body = document.getElementById('grBody');
    const группы = [];
    for (const l of lines) {
        const k = ключКомнаты(l);
        let g = группы.find(x => x.k === k);
        if (!g) { g = { k, lines: [] }; группы.push(g); }
        g.lines.push(l);
    }
    body.innerHTML = группы.map(g => headRow(g) + g.lines.map(l => placeRow(l, lines.indexOf(l))).join('')).join('')
        || `<tr><td colspan="13" class="text-center py-6 opacity-60">В шахматке нет мест этого события</td></tr>`;
    document.querySelectorAll('#grBody [data-mixed]').forEach(el => { el.indeterminate = true; });
    renderUnplaced();
    renderBulk();
    renderTotal();
}

// Шапка комнаты: отметить всю комнату, начислять/не начислять её, подытог
function headRow(g) {
    const l0 = g.lines[0], p = l0.place;
    const вкл = g.lines.filter(l => l.included).length;
    const отм = g.lines.filter(l => marked.has(l.key)).length;
    const сумма = g.lines.filter(вСчётГруппы).reduce((a, l) => a + расчёт(l).итого, 0);
    const tri = (n, all) => n === 0 ? '' : n === all ? 'checked' : 'data-mixed="1"';
    const имя = имяГруппы(p, l0.label);
    const даты = p ? `${дата(p.check_in)}–${дата(p.check_out)} · ${p.room_id ? `${Math.max(днейМежду(p.check_in, p.check_out || p.check_in), 0)} ноч.` : 'только питание'}`
        : `${дата(l0.eater.start_date)}–${дата(l0.eater.end_date)}`;
    return `<tr class="bg-base-200 border-t-2 border-base-300">
        <td><input type="checkbox" class="checkbox checkbox-xs" data-gr-markroom="${g.k}" ${tri(отм, g.lines.length)} title="Отметить комнату — для правок «сразу»"></td>
        <td><input type="checkbox" class="checkbox checkbox-xs checkbox-success" data-gr-incroom="${g.k}" ${tri(вкл, g.lines.length)} title="Начисляем за комнату"></td>
        <td colspan="9" class="font-semibold">${e(имя)}${p?.room_id ? ` <span class="font-normal opacity-60">${p.capacity}-мест.</span>` : ''}
            <span class="font-normal opacity-70">· ${даты} · ${p ? `мест ${g.lines.length}` : `${l0.persons} чел.`}${вкл < g.lines.length ? ` · начисляем ${вкл}` : ''}</span>
            ${p?.booking_name && p.room_id ? `<span class="font-normal text-xs opacity-50">· ${e(p.booking_name)}</span>` : ''}</td>
        <td class="text-right font-mono font-semibold whitespace-nowrap">${inr(сумма)}</td><td></td>
    </tr>`;
}

function placeRow(l, i) {
    const r = расчёт(l);
    const p = l.place;
    const h = !!p?.room_id;   // в номере; без номера — только питание
    const выкл = !l.included;
    const числа = (k, v, w, step = 1, title = '') => `<input type="number" min="0" step="${step}" class="input input-bordered input-xs ${w} px-1 text-right" data-gr-f="${i}" data-k="${k}" value="${v}" ${title ? `title="${title}"` : ''} ${выкл ? 'disabled' : ''}>`;
    const питаниеВыкл = p && p.has_meals === false && !l.mealsOn;
    return `<tr class="${marked.has(l.key) ? 'bg-primary/5' : ''} ${выкл ? 'opacity-50' : ''}">
        <td><input type="checkbox" class="checkbox checkbox-xs" data-gr-mark="${l.key}" ${marked.has(l.key) ? 'checked' : ''}></td>
        <td><input type="checkbox" class="checkbox checkbox-xs checkbox-success" data-gr-inc="${i}" ${l.included ? 'checked' : ''} title="Начисляем"></td>
        <td><input type="text" class="input input-ghost input-xs w-40 px-1" data-gr-f="${i}" data-k="label" value="${e(l.label)}" placeholder="${p ? 'имя / место' : ''}">
            ${выкл ? `<input type="text" class="input input-bordered input-xs w-40 px-1 mt-0.5" data-gr-f="${i}" data-k="excludeReason" value="${e(l.excludeReason)}" placeholder="почему не начисляем">` : ''}
            ${l.changed ? '<span class="badge badge-warning badge-xs" title="Даты в шахматке изменились — ночи и питание пересчитаны заново">шахматка</span>' : ''}
            ${l.selfPay ? '<span class="badge badge-warning badge-xs" title="Остаётся в группе, сумма — на его карточке">платит сам</span>' : ''}
            ${строкаОрганизатора() === l ? '<span class="badge badge-success badge-xs">организатор</span>' : ''}
            ${l.mealsOn ? '<span class="badge badge-info badge-xs" title="Питание включено здесь — при сохранении включится и в шахматке">питание вкл.</span>' : ''}</td>
        <td class="whitespace-nowrap text-xs">${p ? `${дата(p.check_in)}–${p.check_out ? дата(p.check_out) : '…'}` : `${дата(l.eater.start_date)}–${дата(l.eater.end_date)}`}</td>
        <td>${h ? числа('nights', l.nights, 'w-12') : p ? '<span class="text-[11px] opacity-60 whitespace-nowrap">без номера</span>' : ''}${p && раннийВыезд(l) ? `<div class="text-[11px] text-warning whitespace-nowrap"
            title="Последние дни сняты — при сохранении выезд уйдёт в шахматку, кухня поправится">выезд → ${дата(раннийВыезд(l))}${ночей(l) < l.nights ? `, ${ночей(l)} ноч.` : ''}</div>` : ''}</td>
        <td class="whitespace-nowrap">${!h ? '' : l.extraBed
            ? `<span class="text-xs">доп. кровать</span> ${числа('extraBedPrice', l.extraBedPrice, 'w-16', 50, 'Цена доп. кровати за сутки')}`
            : `${числа('roomPrice', l.roomPrice, 'w-16', 50, 'Цена номера за сутки')} ÷ ${числа('people', l.people, 'w-10', 1, 'Сколько человек делят номер')}`}
            ${h && l.roomType?.price == null && !l.extraBed ? `<div class="text-[11px] text-warning" title="Задайте цену в «Тарифах» или впишите здесь">цена не задана</div>` : ''}
            ${h && l.roomType && Number(p.capacity) > Number(l.roomType.capacity) ? `<label class="flex items-center gap-1 text-[11px] cursor-pointer opacity-80" title="${p?.capacity}-местный = ${l.roomType?.capacity}-местный + доп. кровать: галочка — это место на доп. кровати">
                <input type="checkbox" class="checkbox checkbox-xs" data-gr-extrabed="${i}" ${l.extraBed ? 'checked' : ''} ${выкл ? 'disabled' : ''}> доп. кровать</label>` : ''}</td>
        <td class="text-right font-mono gr-stay-end">${h ? inr(r.проживание) : ''}</td>
        ${питаниеВыкл
            ? `<td colspan="3" class="text-xs gr-meal-start"><span class="opacity-60">питание в шахматке выключено</span>
                <button type="button" class="btn btn-ghost btn-xs text-primary" data-gr-meals-on="${i}" ${выкл ? 'disabled' : ''}>включить</button></td>`
            : `<td class="whitespace-nowrap gr-meal-start">${приём(l, i, 'b', r.завтраков)}</td><td class="whitespace-nowrap">${приём(l, i, 'l', r.обедов)}</td>
               <td class="text-right font-mono">${inr(r.питание)}</td>`}
        <td>${числа('extra', l.extra || '', 'w-16', 10)}</td>
        <td class="text-right font-mono font-semibold whitespace-nowrap ${выкл ? 'line-through' : ''} ${l.selfPay ? 'opacity-60' : ''}">${inr(r.итого)}${l.selfPay
            ? '<div class="text-[11px] font-normal font-sans" title="Не входит в сумму организатора — начисляется на его карточку">на его карточке</div>' : ''}</td>
        <td>${l.place ? `<select class="select select-bordered select-xs w-28 ${l.selfPay ? 'select-warning' : строкаОрганизатора() === l ? 'select-success' : ''}" data-gr-who="${i}" ${выкл ? 'disabled' : ''}>
            <option value="group">в группе</option>
            <option value="org" ${строкаОрганизатора() === l ? 'selected' : ''}>организатор</option>
            <option value="self" ${l.selfPay ? 'selected' : ''}>платит сам</option></select>` : ''}</td>
    </tr>` + (expanded === l.key ? detailRow(l, i) : '');
}

// Завтраки/обеды в строке, как номер: число (нажать — дни этого человека) × цена;
// под ним — какие приёмы он пропустил (ВГ, 02.10)
function приём(l, i, k, n) {
    const нет = пропущено(l, k);
    const выкл = !l.included;
    return `<button type="button" class="btn btn-ghost btn-xs px-1 min-w-6 ${нет.length ? 'text-warning' : ''} ${expanded === l.key ? 'btn-active' : ''}"
            data-gr-expand="${l.key}" title="Питание по дням — снять пропущенные" ${выкл ? 'disabled' : ''}>${n}</button>×<input type="number" min="0" step="10"
            class="input input-bordered input-xs w-16 px-1 text-right" data-gr-f="${i}" data-k="${k === 'b' ? 'bPrice' : 'lPrice'}" value="${k === 'b' ? l.bPrice : l.lPrice}" ${выкл ? 'disabled' : ''}>
        ${нет.length ? `<div class="text-[11px] text-warning" title="${нет.map(дата).join(', ')}">без ${нет.length > 2 ? `${нет.length} дн.` : нет.map(дата).join(', ')}</div>` : ''}`;
}

// Брони события, у которых мест в шахматке меньше, чем в брони. Обычная бронь ставит в
// шахматку места без имён — кухня считает их «ожидаются»; у этих броней мест нет вовсе
// (удалены или бронь заведена без мест), их видно только в «Бронированиях» (ВГ, 29.09)
function renderUnplaced() {
    const el = document.getElementById('grUnplaced');
    const нехватка = bookings.filter(b => Number(b.placed) < Number(b.beds));
    const питание = lines.some(l => l.eater || (l.place && !l.place.room_id)) ? '' : `<div class="text-xs opacity-60 mb-1">Кто питается с группой, но живёт не у нас — заведите в
        <a class="link" href="../placement/timeline.html" target="_blank">шахматке</a> бронью без номера (блок «Самостоятельное проживание», событие «${e(ret.name)}»): места появятся здесь строками «только питание».</div>`;
    el.innerHTML = питание + (нехватка.length ? `<div class="alert alert-warning py-2 px-3 text-sm block">
        <b>⚠ Брони без мест в шахматке — ${нехватка.reduce((a, b) => a + b.beds - b.placed, 0)} мест(а) в ${нехватка.length} бронях.</b>
        Бронь есть, а мест под неё в шахматке нет — поэтому кухня этих людей не считает (даже как «ожидаются») и здесь их не начислить.
        Поставьте места в шахматку или отмените лишнюю бронь в «Бронированиях»:
        <ul class="list-disc ml-5 mt-1">${нехватка.map(b => `<li>${e(b.name || 'Бронь')} · ${дата(b.check_in)}–${дата(b.check_out)} · в брони ${b.beds}, в шахматке ${b.placed}${
            именаБрони(b.notes).length ? ` <span class="opacity-70">(${e(именаБрони(b.notes).join(', '))})</span>` : ''}</li>`).join('')}</ul>
    </div>` : '');
}

// Раскрытая строка: завтраки/обеды по дням и цены
function detailRow(l, i) {
    return `<tr class="bg-base-200/50"><td></td><td colspan="12">
        <div class="text-xs font-semibold mb-1">${e(l.label || 'Место')} · питание по дням — снимите приём, если человек предупредил, что не будет</div>
        <div class="flex flex-wrap gap-1 mb-1">
            ${l.meals.map((m, j) => `<div class="border border-base-300 rounded px-1.5 py-0.5 text-xs bg-base-100">
                <div class="font-medium">${дата(m.d)}</div>
                <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" data-gr-meal="${i}" data-j="${j}" data-m="b" ${m.b ? 'checked' : ''}> завтрак</label>
                <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" data-gr-meal="${i}" data-j="${j}" data-m="l" ${m.l ? 'checked' : ''}> обед</label>
            </div>`).join('') || `<span class="text-xs opacity-60">Питание в шахматке выключено</span>${l.place ? ` <button type="button" class="btn btn-ghost btn-xs text-primary" data-gr-meals-on="${i}">включить</button>` : ''}`}
        </div>
        <div class="flex flex-wrap items-center gap-1 text-xs">
            ${l.place ? `<span class="opacity-60">При сохранении кухня увидит: снятые дни — пропуски, завтрак в день заезда и обед в день выезда — ранний заезд / поздний выезд</span>` : ''}
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

// Договорные цены группы (ВГ, 02.10): сохранённые в листе, иначе — самые частые в строках
const ЦЕНЫ = { r2: 'grB2', r4: 'grB4', b: 'grBB', l: 'grBL' };
const типМест = x => Number(x.roomType?.capacity ?? x.place?.capacity) || 2;
function fillPrices(saved) {
    const частая = arr => {
        const n = new Map();
        arr.filter(v => v > 0).forEach(v => n.set(v, (n.get(v) || 0) + 1));
        return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    };
    const номера = lines.filter(x => x.place?.room_id && !x.extraBed);
    const p = saved || {
        r2: частая(номера.filter(x => типМест(x) <= 2).map(x => x.roomPrice)),
        r4: частая(номера.filter(x => типМест(x) > 2).map(x => x.roomPrice)),
        b: частая(lines.map(x => x.bPrice)), l: частая(lines.map(x => x.lPrice))
    };
    for (const [k, id] of Object.entries(ЦЕНЫ)) document.getElementById(id).value = p[k] ?? '';
}
function prices() {
    const out = {};
    for (const [k, id] of Object.entries(ЦЕНЫ)) { const v = document.getElementById(id).value; out[k] = v === '' ? null : Number(v); }
    return out;
}

function applyBulkPrices() {
    const { r2, r4, b, l } = prices();
    if ([r2, r4, b, l].every(x => x === null)) { Layout.showNotification('Впишите хотя бы одну цену', 'warning'); return; }
    for (const x of цели()) {
        // по типу номера (3-местный = 2-местный + доп. кровать), а не по числу мест в комнате
        const тип = типМест(x);
        if (x.place?.room_id && r2 !== null && тип <= 2) x.roomPrice = r2;
        if (x.place?.room_id && r4 !== null && тип > 2) x.roomPrice = r4;
        if (b !== null) x.bPrice = b;
        if (l !== null) x.lPrice = l;
    }
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
    const сам = сами();
    const сумСами = round2(сам.reduce((a, l) => a + расчёт(l).итого, 0));
    const аванс = авансИтого();
    document.getElementById('grTotal').innerHTML = `
        ${removed ? `<div class="text-warning text-xs">${removed} мест(а) из прошлого расчёта больше нет в шахматке — выпадут при пересчёте</div>` : ''}
        Проживание <b class="font-mono">${inr(s.проживание)}</b> · питание <b class="font-mono">${inr(s.питание)}</b>
        <span class="opacity-60">(завтраков ${s.завтраков}, обедов ${s.обедов})</span>${s.доп ? ` · доп. <b class="font-mono">${inr(s.доп)}</b>` : ''}
        · <b>итого <span class="font-mono">${inr(всего)}</span></b>
        ${dirty ? ' <span class="badge badge-warning badge-sm">не сохранено</span>'
            : draft ? ' <span class="badge badge-info badge-sm">черновик — не начислено</span>' : ''}
        ${сам.length ? `<div class="text-xs opacity-70">Платят сами: ${сам.length} чел. — <span class="font-mono">${inr(сумСами)}</span>, в сумму организатора не входит</div>` : ''}
        <div class="text-xs">${аванс
            ? `− аванс группы <b class="font-mono">${inr(аванс)}</b> <span class="opacity-60">(${advances.map(x => `${дата(x.date)}${x.currency !== 'INR' ? `, ${FinUtils.fmtMoney(x.amount, x.currency)}` : ''}${x.account ? `, ${e(x.account)}` : ''}`).join('; ')})</span>
               → <b>к оплате <span class="font-mono">${inr(Math.max(round2(всего - аванс), 0))}</span></b>${всего < аванс ? ` <span class="text-warning">переплата ${inr(round2(аванс - всего))}</span>` : ''}`
            : '<span class="opacity-60">Предоплаты/аванса по событию нет</span>'}</div>`;
    document.getElementById('grSave').textContent = payer || payerKey ? 'Пересчитать начисления' : 'Начислить организатору';
}

// ==================== СОХРАНЕНИЕ ====================
async function save() {
    const безПричины = lines.filter(l => !l.included && !(l.excludeReason || '').trim());
    if (безПричины.length) { Layout.showNotification(`Укажите, почему не начисляем: ${безПричины.map(l => l.label || 'место').join(', ')}`, 'warning'); return; }
    const уехали = lines.filter(l => раннийВыезд(l));
    if (уехали.length && !confirm(`Ранний выезд уйдёт в шахматку (кухня поправится):\n${уехали.map(l =>
        `• ${l.label || 'место'} · ${l.place.building || ''} №${l.place.room || '—'}: ${дата(l.place.check_out)} → ${дата(раннийВыезд(l))}`).join('\n')}\n\nСохранить?`)) return;
    const безИмени = lines.filter(l => (l.selfPay || l.key === payerKey) && !l.place?.vaishnava_id && !(l.label || '').trim());
    if (безИмени.length) { Layout.showNotification('Впишите имя тому, кто платит сам или организатору, — без имени карточку не завести', 'warning'); return; }
    const payload = { retreat_id: ret.id, lines: lines.map(toLine), prices: prices() };
    if (payerKey) payload.payer_resident_id = lines.find(l => l.key === payerKey).resident_id;
    else if (!payer) {
        const pid = document.getElementById('grPayerId')?.value;
        const имя = document.getElementById('grNpName')?.value.trim();
        if (pid) payload.payer_id = pid;
        // достаточно имени: кто придёт платить за группу — не важно (ВГ, 02.10)
        else if (имя) payload.new_person = { spiritual_name: имя,
                phone: document.getElementById('grNpPhone').value.trim(), email: document.getElementById('grNpEmail').value.trim() };
        else { Layout.showNotification('Выберите организатора — кто платит за группу', 'warning'); return; }
    }
    const res = await FinUtils.rpc('fin_group_save', payload);
    if (!res?.ok) { Layout.showNotification(res?.error?.message || 'Ошибка', 'error'); return; }
    const r = res.result;
    const названия = { accommodation: 'проживание', meals: 'питание', extra: 'доп.' };
    Layout.showNotification((r.changed.length
        ? `Начислено организатору: ${r.changed.map(k => названия[k]).join(', ')} обновлено`
        : 'Сохранено — суммы не изменились') + (r.self_pay ? ` · платят сами: ${r.self_pay} — на их карточках` : ''), 'success');
    dirty = false; draft = false;
    document.getElementById('groupChargeModal').close();
    await FinParticipants.reload();
    FinParticipants.openCardById(r.payer_id);
}

// Черновик (ВГ, 02.10): правки по ходу переговоров — только в лист. На карточку, в шахматку
// и кухне ничего не уходит, это делает «Начислить». Даты места — как в шахматке (ранний
// выезд пересчитается из питания), иначе при открытии лист собрался бы заново
async function saveDraft() {
    const draftLines = lines.map(l => {
        const o = toLine(l);
        if (l.place) { o.check_out = l.place.check_out; o.nights = l.nights; delete o.depart_on; }
        if (l.key === payerKey) o.org = true;
        return o;
    });
    const res = await FinUtils.rpc('fin_group_save_draft', { retreat_id: ret.id, lines: draftLines, prices: prices() });
    if (!res?.ok) { Layout.showNotification(res?.error?.message || 'Ошибка', 'error'); return; }
    dirty = false; draft = true;
    Layout.showNotification('Сохранено черновиком — начисления не менялись', 'success');
    renderTotal();
}

function toLine(l) {
    const r = расчёт(l);
    const o = {
        key: l.key, label: l.label || null, nights: l.nights, room_price: l.roomPrice, people: l.people,
        extra_bed: !!l.extraBed, extra_bed_price: l.extraBed ? l.extraBedPrice : null,
        night_price: r.заНочь,
        breakfasts: r.завтраков, lunches: r.обедов, b_price: l.bPrice, l_price: l.lPrice, extra: Number(l.extra) || 0,
        meals: l.meals, persons: l.persons,
        included: l.included, exclude_reason: l.included ? null : (l.excludeReason || '').trim() || null,
        self_pay: !!l.selfPay
    };
    if (l.mealsOn) o.has_meals = true;
    if (l.place) {
        Object.assign(o, { resident_id: l.resident_id, check_in: l.place.check_in, check_out: l.place.check_out });
        // пропущенные приёмы → кухня (края проживания сервер отбросит: это ранний заезд / поздний выезд)
        const дни = new Map();
        for (const k of ['b', 'l']) for (const d of пропущено(l, k)) дни.set(d, { ...(дни.get(d) || { d, b: false, l: false }), [k]: true });
        o.skips = [...дни.values()];
        // края питания → шахматка, только если дни заезда/выезда есть в расчёте
        const first = l.meals[0], last = l.meals[l.meals.length - 1];
        if (first && first.d === l.place.check_in) o.early_checkin = !!first.b;
        if (last && last.d === l.place.check_out) o.late_checkout = !!last.l;
        // уехал раньше: новый выезд — в шахматку; обед в последний день = поздний выезд
        const выезд = раннийВыезд(l);
        if (выезд) {
            const день = l.meals.find(m => m.d === выезд);
            Object.assign(o, { check_out: выезд, depart_on: выезд, nights: ночей(l), late_checkout: !!день?.l });
        }
    } else {
        Object.assign(o, { meal_group_id: l.meal_group_id, check_in: l.eater.start_date, check_out: l.eater.end_date });
    }
    return o;
}

// ==================== СВОДКА ОРГАНИЗАТОРУ ====================
// Лист для организатора (ВГ, 02.10): договорные цены, проживание по типам номеров, питание,
// итог, аванс, к оплате; затем гости по номерам с именами. Русский / English / हिन्दी, печать на А4
const СЛОВА = {
    ru: { org: 'Организатор', rates: 'Договорные цены', perNight: 'сутки', breakfast: 'Завтрак', lunch: 'Обед', extraBed: 'Доп. кровать',
          stay: 'Проживание', rooms: 'Номеров', guests: 'Гостей', nights: 'Ночей', amount: 'Сумма', meals: 'Питание', count: 'Кол-во', price: 'Цена',
          breakfasts: 'Завтраки', lunches: 'Обеды', noB: 'без завтрака', noL: 'без обеда', noBL: 'без питания', people: n => `${n} чел.`,
          extra: 'Дополнительно', total: 'Итого', totalGroup: 'Итого за группу', self: 'Оплачивают самостоятельно (в сумму не входит)',
          advance: 'Аванс (предоплата)', due: 'К оплате', overpaid: 'Переплата', paidFull: 'Оплачено полностью', charged: 'Начислено',
          paid: 'Оплачено', left: 'Осталось оплатить', currency: 'Валюта расчёта', rate: 'курс', notCharged: 'Не начисляем',
          byRoom: 'Гости по номерам', room: 'Номер', dates: 'Даты', noId: 'Гость (без документа)', mealsOnly: 'только питание',
          selfMark: 'платит сам', ashram: 'за счёт ашрама', roomType: n => `${n}-местный номер`, inCur: 'В валюте расчёта',
          unsaved: 'Внимание: в окне есть не начисленные правки — «начислено» и «осталось» по последнему начислению' },
    en: { org: 'Organizer', rates: 'Agreed rates', perNight: 'night', breakfast: 'Breakfast', lunch: 'Lunch', extraBed: 'Extra bed',
          stay: 'Accommodation', rooms: 'Rooms', guests: 'Guests', nights: 'Nights', amount: 'Amount', meals: 'Meals', count: 'Count', price: 'Price',
          breakfasts: 'Breakfasts', lunches: 'Lunches', noB: 'no breakfast', noL: 'no lunch', noBL: 'no meals', people: n => `${n} guest${n === 1 ? '' : 's'}`,
          extra: 'Additional', total: 'Total', totalGroup: 'Group total', self: 'Paying individually (not included)',
          advance: 'Advance paid', due: 'Amount due', overpaid: 'Overpaid', paidFull: 'Paid in full', charged: 'Charged',
          paid: 'Paid', left: 'Balance due', currency: 'Settlement currency', rate: 'rate', notCharged: 'Not charged',
          byRoom: 'Guests by room', room: 'Room', dates: 'Dates', noId: 'Guest (no ID provided)', mealsOnly: 'meals only',
          selfMark: 'pays individually', ashram: "at the ashram's expense",
          roomType: n => ({ 1: 'Single room', 2: 'Double room', 3: 'Triple room', 4: 'Quad room' })[n] || `${n}-bed room`, inCur: 'In settlement currency',
          unsaved: 'Note: there are changes not yet charged — “charged” and “balance” reflect the last charge' },
    hi: { org: 'आयोजक', rates: 'तय दरें', perNight: 'रात', breakfast: 'नाश्ता', lunch: 'दोपहर का भोजन', extraBed: 'अतिरिक्त बिस्तर',
          stay: 'आवास', rooms: 'कमरे', guests: 'मेहमान', nights: 'रातें', amount: 'राशि', meals: 'भोजन', count: 'संख्या', price: 'दर',
          breakfasts: 'नाश्ते', lunches: 'दोपहर के भोजन', noB: 'नाश्ता नहीं', noL: 'दोपहर का भोजन नहीं', noBL: 'भोजन नहीं', people: n => `${n} मेहमान`,
          extra: 'अतिरिक्त', total: 'कुल', totalGroup: 'समूह का कुल', self: 'व्यक्तिगत भुगतान (कुल में शामिल नहीं)',
          advance: 'अग्रिम भुगतान', due: 'देय राशि', overpaid: 'अधिक भुगतान', paidFull: 'पूर्ण भुगतान हो गया', charged: 'प्रभारित',
          paid: 'भुगतान किया', left: 'शेष देय', currency: 'भुगतान मुद्रा', rate: 'दर', notCharged: 'शुल्क नहीं लिया गया',
          byRoom: 'कमरेवार मेहमान', room: 'कमरा', dates: 'तिथियाँ', noId: 'अतिथि (पहचान पत्र नहीं दिया)', mealsOnly: 'केवल भोजन',
          selfMark: 'स्वयं भुगतान', ashram: 'आश्रम के खर्च पर', roomType: n => `${n} बिस्तर वाला कमरा`, inCur: 'भुगतान मुद्रा में',
          unsaved: 'ध्यान दें: कुछ बदलाव अभी प्रभारित नहीं हुए — «प्रभारित» और «शेष» पिछले शुल्क के अनुसार' }
};
const ЛОКАЛЬ = { ru: 'ru-RU', en: 'en-GB', hi: 'hi-IN' };
let язык = 'ru';
let названия = null;   // событие и здания на трёх языках — для сводки

// Дни, когда кто-то из списка не ел, и сколько человек: {d, b, l} — число пропустивших
function пропуски(list) {
    const без = new Map();
    for (const l of list) for (const f of l.base || l.fresh.meals) {
        // после раннего выезда дни не «пропущены» — человека уже нет
        if (раннийВыезд(l) && f.d > раннийВыезд(l)) continue;
        const m = l.meals.find(x => x.d === f.d);
        const x = без.get(f.d) || { d: f.d, b: 0, l: 0 };
        if (f.b && !m?.b) x.b += l.persons;
        if (f.l && !m?.l) x.l += l.persons;
        без.set(f.d, x);
    }
    return [...без.values()].filter(x => x.b || x.l).sort((a, b) => a.d.localeCompare(b.d));
}

async function загрузитьНазвания() {
    if (названия?.ret === ret.id) return;
    const зд = [...new Set(lines.map(l => l.place?.building_id).filter(Boolean))];
    const [{ data: r }, { data: b }] = await Promise.all([
        Layout.db.from('retreats').select('name_ru, name_en, name_hi').eq('id', ret.id),
        зд.length ? Layout.db.from('buildings').select('id, name_ru, name_en, name_hi').in('id', зд) : Promise.resolve({ data: [] })
    ]);
    названия = { ret: ret.id, событие: r?.[0] || {}, здания: new Map((b || []).map(x => [x.id, x])) };
}

async function summaryData() {
    await загрузитьНазвания();
    const группа = lines.filter(вСчётГруппы);
    // проживание по типам номеров: тип — по прайсу (3-местный = 2-местный + доп. кровать)
    const типы = new Map();
    for (const l of группа.filter(x => x.place?.room_id)) {
        const k = l.extraBed ? 'extra' : String(типМест(l));
        const t = типы.get(k) || { k, cap: l.extraBed ? null : типМест(l), номера: new Set(), гостей: 0, ночи: new Set(), сумма: 0, цены: new Set() };
        t.номера.add(l.place.room_id); t.гостей += 1; t.ночи.add(ночей(l)); t.сумма += расчёт(l).проживание;
        t.цены.add(l.extraBed ? l.extraBedPrice : l.roomPrice);
        типы.set(k, t);
    }
    const s = итоги();
    const цена = k => { const v = new Set(группа.filter(l => расчёт(l)[k === 'b' ? 'завтраков' : 'обедов']).map(l => k === 'b' ? l.bPrice : l.lPrice)); return v.size === 1 ? [...v][0] : null; };
    // гости по номерам — все места события, с пометками «платит сам» и «не начисляем»
    const комнаты = [];
    for (const l of lines) {
        const k = ключКомнаты(l);
        let g = комнаты.find(x => x.k === k);
        if (!g) { g = { k, l0: l, люди: [], сумма: 0 }; комнаты.push(g); }
        g.люди.push(l);
        if (вСчётГруппы(l)) g.сумма += расчёт(l).итого;
    }
    let bal = null;
    if (payer) {
        const { data } = await Layout.db.rpc('fin_get_participant_balance', { p_participant: payer.id, p_retreat: ret.id });
        bal = data;
    }
    const cur = bal?.system === 'settlement_currency' ? bal.currency : 'INR';
    const rate = cur === 'INR' ? 1 : Number(FinParticipants.rates()[cur]) || null;
    const сум = k => Object.values(bal?.blocks || {}).reduce((a, b) => a + (Number(b[k]) || 0), 0);
    return { типы: [...типы.values()].sort((a, b) => (a.cap ?? 99) - (b.cap ?? 99)), s, всего: round2(s.проживание + s.питание + s.доп),
             ценаЗ: цена('b'), ценаО: цена('l'), пропуски: пропуски(группа), комнаты,
             исключены: lines.filter(l => !l.included), сам: сами(),
             bal, cur, rate, начислено: сум('charged'), оплачено: сум('paid'), остаток: Number(bal?.net) || 0,
             аванс: авансИтого(), цены: prices() };
}

// Аванс события — в ₹, на карточке организатора его нет: вычитаем из остатка карточки
const вВалюте = (d, inrSum) => d.cur === 'INR' ? inrSum : d.rate ? round2(inrSum / d.rate) : 0;
const остаток = d => round2(d.остаток - вВалюте(d, d.аванс));

// Деньги и даты на языке сводки: по-русски как везде, en/hi — индийская запись (₹2,15,000)
const деньги = (v, cur = 'INR') => язык === 'ru' || cur !== 'INR' ? FinUtils.fmtMoney(v, cur)
    : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const датаЯз = s => DateUtils.parseDate(s).toLocaleDateString(ЛОКАЛЬ[язык], { day: 'numeric', month: 'short', year: 'numeric' });
const имяНаЯзыке = (o, ru) => (язык !== 'ru' && o?.['name_' + язык]) || ru;
function имяКомнаты(l) {
    const T = СЛОВА[язык], p = l.place;
    if (p?.room_id) return `${имяНаЯзыке(названия.здания.get(p.building_id), p.building || '')} №${p.room || '—'}`;
    return p ? `${p.booking_name || T.mealsOnly}` : (l.label || T.mealsOnly);
}
const имяГостя = l => l.label || (l.eater ? СЛОВА[язык].people(l.persons) : СЛОВА[язык].noId);
const причина = r => (r || '').trim() === ПРИЧИНА ? СЛОВА[язык].ashram : r || '';

function summaryHtml(d) {
    const T = СЛОВА[язык], m = v => деньги(v, d.cur);
    const R = 'class="r"';
    const пр = x => x.b && x.b === x.l ? `${T.noBL}: ${T.people(x.b)}`
        : [x.b ? `${T.noB}: ${T.people(x.b)}` : '', x.l ? `${T.noL}: ${T.people(x.l)}` : ''].filter(Boolean).join(', ');
    const ставки = [
        ...[['r2', 2], ['r4', 4]].filter(([k]) => d.цены[k]).map(([k, n]) => [T.roomType(n), `${деньги(d.цены[k])} / ${T.perNight}`]),
        ...(d.цены.b ? [[T.breakfast, деньги(d.цены.b)]] : []), ...(d.цены.l ? [[T.lunch, деньги(d.цены.l)]] : [])
    ];
    const строкиИтога = [];
    строкиИтога.push([`<b>${d.сам.length ? T.totalGroup : T.total}</b>`, `<b>${деньги(d.всего)}</b>`]);
    if (d.сам.length) строкиИтога.push([`<span class="mute">${T.self}: ${e(d.сам.map(l => `${имяГостя(l)} ${деньги(расчёт(l).итого)}`).join(', '))}</span>`, '']);
    if (d.cur !== 'INR') строкиИтога.push([`${T.currency}: ${d.cur}${d.rate ? `, ${T.rate} 1 ${FinUtils.symbol(d.cur)} = ${d.rate.toLocaleString(ЛОКАЛЬ[язык], { maximumFractionDigits: 4 })} ₹` : ''}`, d.rate ? m(round2(d.всего / d.rate)) : '—']);
    if (d.bal) {
        строкиИтога.push([T.charged, m(d.начислено)]);
        if (d.аванс) строкиИтога.push([T.advance, '− ' + m(вВалюте(d, d.аванс))]);
        if (d.оплачено) строкиИтога.push([T.paid, '− ' + m(d.оплачено)]);
        const o = остаток(d);
        строкиИтога.push([`<b>${o > 0 ? T.left : o < 0 ? T.overpaid : T.paidFull}</b>`, `<b>${o ? m(Math.abs(o)) : ''}</b>`]);
    } else if (d.аванс) {
        строкиИтога.push([T.advance, '− ' + деньги(d.аванс)]);
        const o = round2(d.всего - d.аванс);
        строкиИтога.push([`<b>${o > 0 ? T.due : o < 0 ? T.overpaid : T.paidFull}</b>`, `<b>${o ? деньги(Math.abs(o)) : ''}</b>`]);
    }
    const событие = имяНаЯзыке(названия.событие, ret.name);
    return `<div class="sheet">
        <h2>${e(событие)}</h2>
        <div class="mute">${датаЯз(ret.start_date)} – ${датаЯз(ret.end_date)}${payer || payerKey ? ` · ${T.org}: ${e(payer?.name || lines.find(l => l.key === payerKey)?.label || '')}` : ''}</div>
        ${ставки.length ? `<h3>${T.rates}</h3><table class="t narrow">${ставки.map(([a, b]) => `<tr><td>${a}</td><td ${R}>${b}</td></tr>`).join('')}</table>` : ''}
        ${d.типы.length ? `<h3>${T.stay}</h3><table class="t">
            <tr><th></th><th ${R}>${T.rooms}</th><th ${R}>${T.guests}</th><th ${R}>${T.nights}</th><th ${R}>${T.amount}</th></tr>
            ${d.типы.map(t => `<tr><td>${t.cap ? T.roomType(t.cap) : T.extraBed}</td><td ${R}>${t.cap ? t.номера.size : ''}</td><td ${R}>${t.гостей}</td>
                <td ${R}>${[...t.ночи].sort((a, b) => a - b).join('/')}</td><td ${R}>${деньги(round2(t.сумма))}</td></tr>`).join('')}
            <tr class="sub"><td>${T.total}</td><td></td><td></td><td></td><td ${R}>${деньги(d.s.проживание)}</td></tr></table>` : ''}
        ${d.s.завтраков || d.s.обедов ? `<h3>${T.meals}</h3><table class="t">
            <tr><th></th><th ${R}>${T.count}</th><th ${R}>${T.price}</th><th ${R}>${T.amount}</th></tr>
            ${d.s.завтраков ? `<tr><td>${T.breakfasts}</td><td ${R}>${d.s.завтраков}</td><td ${R}>${d.ценаЗ != null ? деньги(d.ценаЗ) : ''}</td><td ${R}>${деньги(round2(сумПриёма('b')))}</td></tr>` : ''}
            ${d.s.обедов ? `<tr><td>${T.lunches}</td><td ${R}>${d.s.обедов}</td><td ${R}>${d.ценаО != null ? деньги(d.ценаО) : ''}</td><td ${R}>${деньги(round2(сумПриёма('l')))}</td></tr>` : ''}
            <tr class="sub"><td>${T.total}</td><td></td><td></td><td ${R}>${деньги(d.s.питание)}</td></tr></table>
            ${d.пропуски.length ? `<div class="small mute">${d.пропуски.map(x => `${дата(x.d)} — ${пр(x)}`).join('; ')}</div>` : ''}` : ''}
        ${d.s.доп ? `<table class="t narrow"><tr><td>${T.extra}</td><td ${R}>${деньги(d.s.доп)}</td></tr></table>` : ''}
        <table class="t narrow total">${строкиИтога.map(([a, b]) => `<tr><td>${a}</td><td ${R}>${b}</td></tr>`).join('')}</table>
        ${d.исключены.length ? `<div class="small"><b>${T.notCharged}:</b> ${d.исключены.map(l => `${e(имяГостя(l))} — ${e(причина(l.excludeReason))}`).join('; ')}</div>` : ''}
        <h3>${T.byRoom}</h3>
        <table class="t rooms"><tr><th>${T.room}</th><th>${T.dates}</th><th>${T.guests}</th><th ${R}>${T.amount}</th></tr>
            ${d.комнаты.map(g => { const p = g.l0.place;
                return `<tr><td>${e(имяКомнаты(g.l0))}</td>
                <td class="nw">${p ? `${дата(p.check_in)}–${дата(p.check_out)}` : `${дата(g.l0.eater.start_date)}–${дата(g.l0.eater.end_date)}`}</td>
                <td>${g.люди.map(l => `${e(имяГостя(l))}${l.selfPay ? ` <i class="mute">(${T.selfMark})</i>` : ''}${!l.included ? ` <i class="mute">(${e(причина(l.excludeReason))})</i>` : ''}`).join(', ')}</td>
                <td ${R}>${g.сумма ? деньги(round2(g.сумма)) : ''}</td></tr>`; }).join('')}
        </table>
        ${dirty || draft ? `<div class="warn no-print">${T.unsaved}</div>` : ''}
    </div>`;
}
// сумма завтраков или обедов по группе
const сумПриёма = k => lines.filter(вСчётГруппы).reduce((a, l) => { const r = расчёт(l); return a + (k === 'b' ? r.завтраков * l.bPrice : r.обедов * l.lPrice); }, 0);

// Те же стили — в окне и при печати: на А4 помещается лист, гости по номерам — следом
const СТИЛЬ = `.sheet{font:12px/1.4 system-ui,'Noto Sans','Noto Sans Devanagari',sans-serif;color:#111}
    .sheet h2{font-size:18px;margin:0 0 2px}.sheet h3{font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 4px;opacity:.75}
    .sheet .t{border-collapse:collapse;width:100%}.sheet .t.narrow{max-width:420px}.sheet .t td,.sheet .t th{border-bottom:1px solid #e5e5e5;padding:3px 6px;text-align:left;vertical-align:top}
    .sheet .t th{font-size:10px;text-transform:uppercase;opacity:.7;font-weight:600}.sheet .r{text-align:right!important;white-space:nowrap}.sheet .nw{white-space:nowrap}
    .sheet .sub td{font-weight:600}.sheet .total{margin-top:12px}.sheet .total td{font-size:13px}.sheet .mute{opacity:.65}.sheet .small{font-size:11px;margin-top:4px}
    .sheet .rooms td{font-size:11px}.sheet .rooms tr{break-inside:avoid}.sheet .warn{color:#b45309;margin-top:8px}`;

async function openSummary() {
    const d = await summaryData();
    document.getElementById('grSummaryBody').innerHTML = `<style>${СТИЛЬ}</style>
        <div class="join mb-3 no-print">${Object.entries({ ru: 'Русский', en: 'English', hi: 'हिन्दी' }).map(([k, v]) =>
            `<button type="button" class="btn btn-xs join-item ${язык === k ? 'btn-active' : ''}" data-gr-lang="${k}">${v}</button>`).join('')}</div>
        <div id="grSummarySheet">${summaryHtml(d)}</div>`;
    document.getElementById('grSummaryText').value = summaryText(d);
    const modal = document.getElementById('groupSummaryModal');
    if (!modal.open) modal.showModal();
}

// Текстом — то же самое для мессенджера
function summaryText(d) {
    const T = СЛОВА[язык], m = v => деньги(v, d.cur);
    const out = [`${имяНаЯзыке(названия.событие, ret.name)} · ${датаЯз(ret.start_date)} – ${датаЯз(ret.end_date)}`];
    if (payer || payerKey) out.push(`${T.org}: ${payer?.name || lines.find(l => l.key === payerKey)?.label || ''}`);
    const ставки = [...[['r2', 2], ['r4', 4]].filter(([k]) => d.цены[k]).map(([k, n]) => `${T.roomType(n)} ${деньги(d.цены[k])}/${T.perNight}`),
        ...(d.цены.b ? [`${T.breakfast} ${деньги(d.цены.b)}`] : []), ...(d.цены.l ? [`${T.lunch} ${деньги(d.цены.l)}`] : [])];
    if (ставки.length) out.push('', `${T.rates}: ${ставки.join(' · ')}`);
    if (d.типы.length) {
        out.push('', `${T.stay}:`);
        d.типы.forEach(t => out.push(`• ${t.cap ? `${T.roomType(t.cap)} × ${t.номера.size}` : T.extraBed} — ${T.people(t.гостей)}, ${T.nights.toLowerCase()}: ${[...t.ночи].join('/')} — ${деньги(round2(t.сумма))}`));
    }
    if (d.s.завтраков || d.s.обедов) {
        out.push('', `${T.meals}:`);
        if (d.s.завтраков) out.push(`• ${T.breakfasts}: ${d.s.завтраков}${d.ценаЗ != null ? ` × ${деньги(d.ценаЗ)}` : ''} = ${деньги(round2(сумПриёма('b')))}`);
        if (d.s.обедов) out.push(`• ${T.lunches}: ${d.s.обедов}${d.ценаО != null ? ` × ${деньги(d.ценаО)}` : ''} = ${деньги(round2(сумПриёма('l')))}`);
        d.пропуски.forEach(x => out.push(`  ${дата(x.d)}: ${x.b ? `${T.noB} ${T.people(x.b)}` : ''}${x.b && x.l ? ', ' : ''}${x.l ? `${T.noL} ${T.people(x.l)}` : ''}`));
    }
    if (d.s.доп) out.push(`${T.extra}: ${деньги(d.s.доп)}`);
    out.push('', `${d.сам.length ? T.totalGroup : T.total}: ${деньги(d.всего)}`);
    if (d.сам.length) out.push(`${T.self}: ${d.сам.map(l => `${имяГостя(l)} ${деньги(расчёт(l).итого)}`).join(', ')}`);
    if (d.cur !== 'INR' && d.rate) out.push(`${T.inCur} (1 ${FinUtils.symbol(d.cur)} = ${d.rate.toLocaleString(ЛОКАЛЬ[язык])} ₹): ${m(round2(d.всего / d.rate))}`);
    if (d.bal) {
        if (d.аванс) out.push(`${T.advance}: ${m(вВалюте(d, d.аванс))}`);
        out.push(`${T.paid}: ${m(d.оплачено)}`);
        const o = остаток(d);
        out.push(o > 0 ? `${T.left}: ${m(o)}` : o < 0 ? `${T.overpaid}: ${m(-o)}` : T.paidFull);
    } else if (d.аванс) {
        const o = round2(d.всего - d.аванс);
        out.push(`${T.advance}: − ${деньги(d.аванс)}`, o > 0 ? `${T.due}: ${деньги(o)}` : o < 0 ? `${T.overpaid}: ${деньги(-o)}` : T.paidFull);
    }
    if (d.исключены.length) out.push('', `${T.notCharged}: ${d.исключены.map(l => `${имяГостя(l)} — ${причина(l.excludeReason)}`).join('; ')}`);
    out.push('', `${T.byRoom}:`);
    d.комнаты.forEach(g => out.push(`• ${имяКомнаты(g.l0)}: ${g.люди.map(l => имяГостя(l) + (l.selfPay ? ` (${T.selfMark})` : '')).join(', ')}`));
    return out.join('\n');
}

async function copySummary() {
    const ok = await FinUtils.copyText(document.getElementById('grSummaryText').value);
    Layout.showNotification(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error');
}

// PDF — через печать браузера («Сохранить как PDF»), лист А4
function printSummary() {
    const w = window.open('', '_blank');
    if (!w) { Layout.showNotification('Браузер не дал открыть окно печати', 'error'); return; }
    const имя = имяНаЯзыке(названия?.событие, ret.name);
    w.document.write(`<!doctype html><html lang="${язык}"><head><meta charset="utf-8"><title>${e(имя)}</title>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap" rel="stylesheet">
        <style>@page{size:A4;margin:12mm}body{margin:0}.no-print{display:none}${СТИЛЬ}</style></head>
        <body>${document.getElementById('grSummarySheet').innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    // шрифт хинди — дождаться загрузки, иначе печать уйдёт квадратиками
    (w.document.fonts?.ready || Promise.resolve()).then(() => w.print());
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
    const draftBtn = document.getElementById('grDraft');
    draftBtn.addEventListener('click', async () => {
        if (draftBtn.disabled) return;
        draftBtn.disabled = true;
        try { await saveDraft(); } finally { draftBtn.disabled = false; }
    });
    // закрыть с несохранёнными правками — только осознанно
    modal.addEventListener('cancel', ev => { if (dirty && !confirm('Правки не сохранены. Закрыть?')) ev.preventDefault(); });

    modal.addEventListener('click', ev => {
        const t = ev.target;
        if (t.closest('[data-gr-payer-change]')) { payer = null; payerKey = null; renderPayer(); render(); return; }
        if (t.closest('[data-gr-rate-save]')) { saveRate(); return; }
        const exp = t.closest('[data-gr-expand]');
        if (exp) { expanded = expanded === exp.dataset.grExpand ? null : exp.dataset.grExpand; render(); return; }
        const mo = t.closest('[data-gr-meals-on]');
        if (mo) {
            const l = lines[Number(mo.dataset.grMealsOn)];
            l.mealsOn = true;
            l.meals = питаниеПоДатам(l.place);
            l.fresh.meals = l.meals.map(m => ({ ...m }));
            dirty = true; render(); return;
        }
        const fr = t.closest('[data-gr-fresh]');
        if (fr) { freshAll([lines[Number(fr.dataset.grFresh)]]); return; }
    });
    modal.addEventListener('change', ev => {
        const el = ev.target;
        if (el.dataset.grExtrabed !== undefined) {
            // место на доп. кровати платит цену доп. кровати, остальные делят номер между собой
            const l = lines[Number(el.dataset.grExtrabed)];
            l.extraBed = el.checked;
            for (const x of lines.filter(x => x !== l && x.place && ключКомнаты(x) === ключКомнаты(l) && !x.extraBed)) {
                x.people = Math.max(1, x.people + (el.checked ? -1 : 1));
            }
            dirty = true; render();
        } else if (el.dataset.grWho !== undefined) {
            // кто платит за строку: в группе / организатор (живёт с группой) / сам (ВГ, 02.10)
            const l = lines[Number(el.dataset.grWho)];
            if (el.value === 'org') { payerKey = l.key; l.selfPay = false; }
            else {
                if (строкаОрганизатора() === l) { payerKey = null; if (payer) payer = null; }
                l.selfPay = el.value === 'self';
            }
            dirty = true; renderPayer(); render();
        } else if (el.dataset.grInc !== undefined) {
            const l = lines[Number(el.dataset.grInc)];
            l.included = el.checked;
            if (!l.included && !l.excludeReason) l.excludeReason = ПРИЧИНА;
            dirty = true; render();
        } else if (el.dataset.grIncroom) {
            for (const l of lines.filter(x => ключКомнаты(x) === el.dataset.grIncroom)) {
                l.included = el.checked;
                if (!l.included && !l.excludeReason) l.excludeReason = ПРИЧИНА;
            }
            dirty = true; render();
        } else if (el.dataset.grMarkroom) {
            for (const l of lines.filter(x => ключКомнаты(x) === el.dataset.grMarkroom)) el.checked ? marked.add(l.key) : marked.delete(l.key);
            render();
        } else if (el.dataset.grMark !== undefined) {
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
            l[k] = k === 'label' || k === 'excludeReason' ? el.value : Math.max(Number(el.value) || 0, k === 'people' ? 1 : 0);
            dirty = true; render();
        }
    });
    document.getElementById('grBulkApply').addEventListener('click', applyBulkPrices);
    // язык сводки: Русский / English / हिन्दी
    document.getElementById('groupSummaryModal')?.addEventListener('click', ev => {
        const b = ev.target.closest('[data-gr-lang]');
        if (b) { язык = b.dataset.grLang; openSummary(); }
    });
    document.getElementById('grBulkFresh').addEventListener('click', () => freshAll(цели()));
}

function close() {
    if (dirty && !confirm('Правки не сохранены. Закрыть?')) return;
    document.getElementById('groupChargeModal').close();
}

window.FinGroup = { open, close, openSummary, copySummary, printSummary };
init();
})();
