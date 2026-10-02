// ==================== ФИНАНСЫ: ГОСТИ БЕЗ СОБЫТИЯ ====================
// Начисление гостям, приехавшим не на ретрит (ВГ, 28.09.2026). Всё считается
// по визиту — записи шахматки: ночи из дат, цена номера по вместимости делится
// на койки (семья, занявшая номер, — на живущих), питание — по той же формуле, что у кухни (eating_detail). Долг
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

let tariff = null;        // действующий тариф: питание, доп. кровать
let rooms = [];           // цены номеров по услугам CRM (здание × вместимость)
let visits = [];          // визиты периода из шахматки
let selected = new Set(); // resident_id выбранных визитов
let forms = {};           // resident_id → состояние расчёта
let pickerOpen = true;    // список визитов развёрнут; после выбора сворачивается

// ==================== ТАРИФЫ ====================
async function loadTariff() {
    const { data, error } = await Layout.db.rpc('fin_get_stay_tariffs', { p_on: DateUtils.toISO(new Date()) });
    if (error) { Layout.handleError(error, tr('fin_stay_tariffs', 'Тарифы')); return null; }
    tariff = data?.current || null;
    rooms = data?.rooms || [];
    return data;
}

// Тип номера для места — как в прайсе ретритов (crm_calc_participation): номера этого здания
// вместимостью не больше комнаты; сначала шаблон номера, потом точная вместимость, потом
// ближайшая меньшая. Меньшая вместимость = доп. кровать (3-местный = 2-местный + доп. кровать).
// Возвращает {name, price|null, capacity} или null — у здания нет номеров в тарифах
function типНомера(place, список = rooms) {
    const cap = Number(place.capacity) || 2;
    const подходит = r => !r.pattern || new RegExp('^' + r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(place.room || ''));
    const кандидаты = список.filter(r => r.building_id === place.building_id && Number(r.capacity) <= cap && подходит(r))
        .sort((a, b) => (!!b.pattern - !!a.pattern) || ((Number(b.capacity) === cap) - (Number(a.capacity) === cap)) || (Number(b.capacity) - Number(a.capacity)));
    return кандидаты[0] || null;
}

async function openTariffs() {
    const data = await loadTariff();
    if (!data) return;
    const c = data.current || {};
    document.getElementById('trfDate').value = DateUtils.toISO(new Date());
    document.getElementById('trfBreakfast').value = c.breakfast_price ?? '';
    document.getElementById('trfLunch').value = c.lunch_price ?? '';
    document.getElementById('trfExtraBed').value = c.extra_bed_price ?? '';
    let здание = null;
    document.getElementById('trfRooms').innerHTML = rooms.map(r => {
        const шапка = r.building !== здание ? `<tr class="bg-base-200"><td colspan="3" class="font-semibold">${e(r.building)}</td></tr>` : '';
        здание = r.building;
        return шапка + `<tr>
            <td class="pl-4">${e(r.name)} <span class="opacity-50">· ${r.capacity}-мест.</span></td>
            <td><input type="number" min="0" step="50" class="input input-bordered input-xs w-28 text-right" data-trf-room="${r.service_id}" value="${r.price ?? ''}" placeholder="не задана"></td>
            <td class="text-right text-xs opacity-60">${r.from && r.price != null ? дата(r.from) : ''}</td>
        </tr>`;
    }).join('');
    document.getElementById('trfHistory').innerHTML = (data.history || []).map(h => `<tr>
        <td>${дата(h.effective_date)}</td>
        <td class="text-right font-mono">${inr(h.breakfast_price)}</td>
        <td class="text-right font-mono">${inr(h.lunch_price)}</td>
        <td class="text-right font-mono">${h.extra_bed_price != null ? inr(h.extra_bed_price) : '—'}</td>
    </tr>`).join('');
    document.getElementById('tariffsModal').showModal();
}

async function submitTariffs(ev) {
    ev.preventDefault();
    const res = await call('fin_set_stay_tariffs', {
        effective_date: document.getElementById('trfDate').value,
        breakfast_price: Number(document.getElementById('trfBreakfast').value),
        lunch_price: Number(document.getElementById('trfLunch').value),
        extra_bed_price: Number(document.getElementById('trfExtraBed').value) || null,
        room_prices: [...document.querySelectorAll('[data-trf-room]')].map(el => ({
            service_id: el.dataset.trfRoom, price: el.value === '' ? null : Number(el.value) }))
    });
    if (!res) return;
    Layout.showNotification(tr('fin_saved', 'Сохранено'), 'success');
    document.getElementById('tariffsModal').close();
    await showTariffLine();
}

// Действующие тарифы — строкой в шапке режима, менять — кнопкой «Тарифы» (ВГ, 28.09)
async function showTariffLine() {
    const el = document.getElementById('noEventTariffLine');
    if (!el) return;
    await loadTariff();
    el.innerHTML = tariff
        ? `Тарифы: ${rooms.filter(r => r.price != null).map(r => `${e(r.name)} <b>${inr(r.price)}</b>`).join(' · ') || 'цены номеров не заданы'} · завтрак <b>${inr(tariff.breakfast_price)}</b> · обед <b>${inr(tariff.lunch_price)}</b> · доп. кровать <b>${tariff.extra_bed_price != null ? inr(tariff.extra_bed_price) : '—'}</b> <span class="opacity-60">за сутки</span>`
        : '<span class="text-warning">Тарифы не заведены — нажмите «Тарифы»</span>';
}

// ==================== СПИСОК ВИЗИТОВ ЗА ПЕРИОД ====================
// Визиты из шахматки за месяц / квартал / год: начислено ли и итог по гостю.
// Должники из любых периодов — в таблице над списком (fin-participants.js), ВГ 28.09
const gv = { step: 'month', from: null, to: null, filter: 'all', list: [], запрос: 0 };

function границы(step, iso) {
    const d = DateUtils.parseDate(iso);
    const y = d.getFullYear();
    if (step === 'year') return [`${y}-01-01`, `${y}-12-31`];
    const m = step === 'quarter' ? Math.floor(d.getMonth() / 3) * 3 : d.getMonth();
    const n = step === 'quarter' ? 3 : 1;
    return [DateUtils.toISO(new Date(y, m, 1)), DateUtils.toISO(new Date(y, m + n, 0))];
}

function setStep(step, iso) {
    gv.step = step;
    [gv.from, gv.to] = границы(step, iso || gv.from || DateUtils.toISO(new Date()));
    try { localStorage.setItem('fin_guests_step', step); } catch { /* нет хранилища */ }
    document.querySelectorAll('[data-gv-step]').forEach(b => b.classList.toggle('btn-active', b.dataset.gvStep === step));
    const sel = document.getElementById('gvPeriod');
    const опции = [];
    // визиты гостей без события ведутся с 2026 года
    for (let y = new Date().getFullYear() + 1; y >= 2026; y--) {
        if (step === 'year') { опции.push([`${y}-01-01`, String(y)]); continue; }
        const n = step === 'quarter' ? 4 : 12;
        for (let i = n - 1; i >= 0; i--) {
            const m = step === 'quarter' ? i * 3 : i;
            const имя = step === 'quarter' ? `${i + 1} кв. ${y}`
                : (l => l.charAt(0).toUpperCase() + l.slice(1))(new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', ''));
            опции.push([DateUtils.toISO(new Date(y, m, 1)), имя]);
        }
    }
    sel.innerHTML = опции.map(([v, l]) => `<option value="${v}" ${v === gv.from ? 'selected' : ''}>${e(l)}</option>`).join('');
}

async function loadVisitList() {
    const body = document.getElementById('gvBody');
    if (!body) return;
    if (!gv.from) {
        let step = 'month';
        try { step = localStorage.getItem('fin_guests_step') || 'month'; } catch { /* нет хранилища */ }
        setStep(['month', 'quarter', 'year'].includes(step) ? step : 'month');
    }
    const n = ++gv.запрос;
    if (!gv.list.length) body.innerHTML = `<tr><td colspan="6" class="text-center py-6"><span class="loading loading-spinner loading-sm"></span></td></tr>`;
    const { data, error } = await Layout.db.rpc('fin_list_no_event_visits', { p_from: gv.from, p_to: gv.to });
    if (n !== gv.запрос) return;   // период успели сменить
    if (error) { Layout.handleError(error, 'Визиты'); return; }
    gv.list = data || [];
    renderVisitList();
}

// Состояние визита: не начислено (приехал, а денег не спросили) / предстоит / долг / аванс / оплачено.
// Долг и аванс — по гостю в целом, не по визиту: платежи не привязаны к визиту
function состояние(v) {
    if (v.no_charge_reason && !(Number(v.charged) > 0)) return 'free';
    if (!(Number(v.charged) > 0)) return v.check_in > DateUtils.toISO(new Date()) ? 'upcoming' : 'uncharged';
    const net = Number(v.balance?.net) || 0;
    return net > 0.005 ? 'debt' : net < -0.005 ? 'advance' : 'paid';
}

function renderVisitList() {
    const body = document.getElementById('gvBody');
    const q = (document.getElementById('gvSearch')?.value || '').trim().toLowerCase();
    const все = gv.list.map(v => ({ v, st: состояние(v) }));
    const пропущено = все.filter(x => x.st === 'uncharged').length;
    const должников = new Set(все.filter(x => x.st === 'debt').map(x => x.v.vaishnava_id)).size;
    // О каждом пропуске — предупреждение сверху, клик ведёт к списку (ВГ)
    document.getElementById('gvSummary').innerHTML = [
        `визитов: ${все.length}`,
        пропущено ? `<button type="button" class="link text-warning font-medium" data-gv-filter="uncharged">⚠ не начислено: ${пропущено}</button>` : '',
        должников ? `<button type="button" class="link text-error" data-gv-filter="debt">с долгом: ${должников}</button>` : ''
    ].filter(Boolean).join(' · ');
    document.querySelectorAll('.join [data-gv-filter]').forEach(b => b.classList.toggle('btn-active', b.dataset.gvFilter === gv.filter));
    const list = все.filter(({ v, st }) => (gv.filter === 'all' || st === gv.filter || (gv.filter === 'paid' && (st === 'advance' || st === 'free')))
        && (!q || (v.name || '').toLowerCase().includes(q)))
        .sort((a, b) => b.v.check_in.localeCompare(a.v.check_in) || (a.v.name || '').localeCompare(b.v.name || '', 'ru'));
    const итог = ({ v, st }) => {
        const cur = v.balance?.currency || 'INR';
        const net = Math.abs(Number(v.balance?.net) || 0);
        if (st === 'uncharged') return `<span class="badge badge-warning badge-sm whitespace-nowrap">⚠ не начислено</span>`;
        if (st === 'upcoming') return `<span class="badge badge-ghost badge-sm">предстоит</span>`;
        if (st === 'free') return `<span class="badge badge-ghost badge-sm whitespace-nowrap" title="${e(v.no_charge_reason)}">без оплаты · ${e(v.no_charge_reason)}</span>`;
        if (st === 'debt') return `<span class="badge badge-error badge-outline whitespace-nowrap font-mono">Долг ${FinUtils.fmtMoney(net, cur)}</span>`;
        if (st === 'advance') return `<span class="badge badge-success badge-outline whitespace-nowrap font-mono">Аванс ${FinUtils.fmtMoney(net, cur)}</span>`;
        return `<span class="badge badge-success badge-outline whitespace-nowrap gap-1">${FinUtils.ICONS.check} Оплачено</span>`;
    };
    body.innerHTML = list.map(x => {
        const v = x.v;
        return `<tr class="cursor-pointer hover:bg-base-200" data-gv-visit="${v.resident_id}" tabindex="0">
            <td class="font-medium">${e(v.name)}${v.vaishnava_id ? '' : ' <span class="badge badge-ghost badge-xs" title="В шахматке только имя — карточку привяжем при начислении">без карточки</span>'}</td>
            <td class="whitespace-nowrap">${v.room ? `${e(v.building || '')} №${e(String(v.room))}` : '<span class="opacity-50">без номера</span>'}</td>
            <td class="whitespace-nowrap">${дата(v.check_in)} — ${v.check_out ? дата(v.check_out) : '…'}</td>
            <td class="text-right">${v.check_out ? днейМежду(v.check_in, v.check_out) : '—'}</td>
            <td class="text-right font-mono">${Number(v.charged) > 0 ? FinUtils.fmtMoney(v.charged, v.charge_currency || 'INR') : '<span class="opacity-40">—</span>'}</td>
            <td class="text-right">${итог(x)}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="6" class="text-center py-6 opacity-60">${gv.list.length ? 'Ничего не найдено' : 'Гостей без события за период нет'}</td></tr>`;
}

// Визит: уже начислено — карточка гостя (приём оплаты), иначе — окно начисления с этим визитом
async function openVisit(rid, known) {
    let v = known || gv.list.find(x => x.resident_id === rid);
    if (!v) {
        const { data } = await Layout.db.from('residents').select('check_in, check_out').eq('id', rid).maybeSingle();
        if (!data) { Layout.showNotification('Визит не найден', 'error'); return; }
        const { data: список } = await Layout.db.rpc('fin_list_no_event_visits',
            { p_from: data.check_in, p_to: data.check_out || data.check_in });
        v = (список || []).find(x => x.resident_id === rid);
        if (!v) { Layout.showNotification('Это не гость без события — оплата через его ретрит', 'warning'); return; }
    }
    if (Number(v.charged) > 0 && v.vaishnava_id) { FinParticipants.openCardById(v.vaishnava_id); return; }
    if (!window.hasPermission?.('fin_admin')) { Layout.showNotification('Начисляет администратор финансов', 'warning'); return; }
    open({ rid: v.resident_id, from: v.check_in, to: v.check_out || v.check_in });
}

// ==================== ОКНО НАЧИСЛЕНИЯ ====================
async function open(opts = {}) {
    if (!await loadTariff()) return;
    if (!tariff) { Layout.showNotification('Сначала заведите тарифы', 'warning'); openTariffs(); return; }
    selected = new Set();
    forms = {};
    pickerOpen = true;
    const сегодня = new Date();
    const с = new Date(сегодня); с.setDate(с.getDate() - 21);
    const по = new Date(сегодня); по.setDate(по.getDate() + 7);
    document.getElementById('gcFrom').value = opts.from || DateUtils.toISO(с);
    document.getElementById('gcTo').value = opts.to || DateUtils.toISO(по);
    document.getElementById('gcForms').innerHTML = '';
    renderTotal();
    document.getElementById('guestChargeModal').showModal();
    await loadVisits();
    // Из карточки гостя — сразу его визиты без начислений
    if (opts.pid) {
        const свои = visits.filter(v => v.vaishnava_id === opts.pid);
        const новые = свои.filter(v => Number(v.charged) === 0);
        for (const v of (новые.length ? новые : свои.slice(0, 1))) await toggleVisit(v.resident_id, true, false);
        if (selected.size) pickerOpen = false;
        renderVisits();
        renderForms();
    }
    // Из списка визитов или шахматки — сразу этот визит (соседи по номеру отметятся сами)
    if (opts.rid && visits.some(v => v.resident_id === opts.rid)) {
        await toggleVisit(opts.rid, true);
        pickerOpen = false;
        renderPicker();
    }
}

async function loadVisits() {
    const body = document.getElementById('gcVisits');
    body.innerHTML = `<tr><td colspan="6" class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></td></tr>`;
    const { data, error } = await Layout.db.rpc('fin_list_no_event_visits', {
        p_from: document.getElementById('gcFrom').value, p_to: document.getElementById('gcTo').value });
    if (error) { Layout.handleError(error, 'Визиты'); return; }
    visits = data || [];
    // Корпуса из визитов периода; «Гостевой дом» первым — гости без события живут в основном там
    const sel = document.getElementById('gcBuilding');
    const был = sel.value;
    const корпуса = [...new Map(visits.filter(v => v.building_id).map(v => [v.building_id, v.building])).entries()]
        .sort((a, b) => (b[1] === 'Гостевой дом') - (a[1] === 'Гостевой дом') || (a[1] || '').localeCompare(b[1] || '', 'ru'));
    sel.innerHTML = `<option value="">Все корпуса</option>` + корпуса.map(([id, n]) => `<option value="${id}">${e(n || '—')}</option>`).join('');
    sel.value = корпуса.some(([id]) => id === был) ? был : '';
    renderVisits();
}

// Свёрнутый выбор: кто отмечен + «изменить»
function renderPicker() {
    const picked = document.getElementById('gcPicked');
    const свернуть = !pickerOpen && selected.size > 0;
    document.getElementById('gcPicker').classList.toggle('hidden', свернуть);
    document.getElementById('gcPickerDone').classList.toggle('hidden', !selected.size);
    picked.classList.toggle('hidden', !свернуть);
    if (свернуть) {
        const имена = [...selected].map(rid => forms[rid]?.v).filter(Boolean)
            .map(v => `<span class="badge badge-ghost">${e(v.name)} · №${e(String(v.room || '—'))}</span>`).join(' ');
        picked.innerHTML = `<span class="opacity-60">Выбрано:</span> ${имена}
            <button type="button" class="btn btn-ghost btn-xs" onclick="FinGuests.expandPicker()">изменить / добавить</button>`;
    }
}

function collapsePicker() { pickerOpen = false; renderPicker(); }
function expandPicker() { pickerOpen = true; renderPicker(); }

function renderVisits() {
    renderPicker();
    const body = document.getElementById('gcVisits');
    const q = (document.getElementById('gcSearch').value || '').trim().toLowerCase();
    const корпус = document.getElementById('gcBuilding').value;
    const комн = (document.getElementById('gcRoom').value || '').trim().toLowerCase();
    // отмеченные видны всегда, даже если не подходят под фильтр
    const list = visits.filter(v => selected.has(v.resident_id) || (
        (!q || (v.name || '').toLowerCase().includes(q))
        && (!корпус || v.building_id === корпус)
        && (!комн || String(v.room || '').toLowerCase() === комн)))
        .sort((a, b) => (b.building === 'Гостевой дом') - (a.building === 'Гостевой дом')
            || (a.building || '').localeCompare(b.building || '', 'ru')
            || (parseInt(a.room) || 0) - (parseInt(b.room) || 0)
            || b.check_in.localeCompare(a.check_in));
    body.innerHTML = list.map(v => {
        const ночей = v.check_out ? днейМежду(v.check_in, v.check_out) : '—';
        const начислено = Number(v.charged) > 0
            ? `<span class="badge badge-ghost badge-sm whitespace-nowrap" title="Уже есть начисления по этому визиту">начислено ${FinUtils.fmtMoney(v.charged, v.charge_currency || 'INR')}</span>`
            : v.no_charge_reason ? `<span class="badge badge-ghost badge-sm whitespace-nowrap" title="${e(v.no_charge_reason)}">без оплаты</span>` : '';
        return `<tr class="cursor-pointer hover:bg-base-200 ${selected.has(v.resident_id) ? 'bg-primary/5' : ''}" data-gc-visit="${v.resident_id}">
            <td><input type="checkbox" class="checkbox checkbox-sm" ${selected.has(v.resident_id) ? 'checked' : ''} tabindex="-1"></td>
            <td class="font-medium">${e(v.name)}${v.vaishnava_id ? '' : !v.guest_name && v.booking_name
                ? ' <span class="badge badge-info badge-xs" title="Место из брони группы — имя человека впишете при начислении">место брони</span>'
                : ' <span class="badge badge-warning badge-xs" title="В шахматке только имя — при начислении привяжем к карточке">без карточки</span>'}</td>
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
    const тип = типНомера(v);
    const f = {
        v,
        // самостоятельное проживание (без номера) — за жильё не начисляем, только питание
        nights: !v.room_id ? 0 : v.check_out ? Math.max(днейМежду(v.check_in, v.check_out), 0) : 1,
        // цена номера — по зданию и вместимости, как в прайсе ретритов; не задана — вписать вручную
        roomType: тип,
        roomPrice: Number(тип?.price) || 0,
        extraBed: false,
        extraBedPrice: Number(tariff.extra_bed_price) || 0,
        // по умолчанию — койко-место: цена номера ÷ койки, к одиночкам можно подселить (ВГ, 01.10);
        // семья заняла номер целиком — ÷ число жильцов, подсказка рядом с делителем
        people: Math.max(Number(тип?.capacity) || Number(v.capacity) || 1, 1),
        bPrice: Number(tariff.breakfast_price),
        lPrice: Number(tariff.lunch_price),
        meals: [],
        extraAmt: 0, extraDesc: '', comment: '',
        // «Без оплаты» (гость ашрама, за счёт ашрама, пожертвование) — визит не висит «не начислено»
        freeOn: !!v.no_charge_reason, freeReason: v.no_charge_reason || '',
        person: v.vaishnava_id ? { mode: 'linked', id: v.vaishnava_id } : { mode: 'new', candidates: null,
            np: { spiritual_name: v.guest_name || '', first_name: '', last_name: '', phone: v.guest_phone || '', email: v.guest_email || '' } }
    };
    forms[v.resident_id] = f;
    // Питание — ровно то, что считает кухня: день заезда, выезда, ранний/поздний
    if (v.has_meals !== false && v.check_out) {
        // фильтр на сервере: за месяц у всех гостей больше 1000 строк — без него строки гостя обрезались
        const { data } = await Layout.db.rpc('eating_detail', { p_from: v.check_in, p_to: v.check_out })
            .eq('ref_id', v.resident_id);
        const дни = (data || []).sort((a, b) => a.d.localeCompare(b.d));
        f.meals = дни.map(r => ({ d: r.d, b: !!r.breakfast, l: !!r.lunch, ref: v.resident_id }));
        f.base = await базаПитания(f.meals);
    }
    if (!v.vaishnava_id) {
        const { data } = await Layout.db.rpc('fin_guest_person_candidates',
            { p_name: v.guest_name || '', p_phone: v.guest_phone || null, p_email: v.guest_email || null });
        f.person.candidates = data || [];
    }
}

// ==================== ЛЕНТА ПИТАНИЯ ====================
// Прасад за приём (ВГ, 02.10): снятый в окне приём, который кухня считала, — пропуск для
// кухни (resident_meal_skips, учтён в eating_detail). База — что кухня считает без прежних
// пропусков этих мест (они тоже отсюда). meals: [{d, b, l, ref}] — ref = место (resident)
async function базаПитания(meals) {
    const ids = [...new Set(meals.map(m => m.ref).filter(Boolean))];
    const { data } = ids.length
        ? await Layout.db.from('resident_meal_skips').select('resident_id, d, breakfast, lunch').in('resident_id', ids)
        : { data: [] };
    return meals.map(m => {
        const sk = (data || []).find(x => x.resident_id === m.ref && x.d === m.d);
        return { d: m.d, ref: m.ref, b: m.b || !!sk?.breakfast, l: m.l || !!sk?.lunch };
    });
}

const пропускиЛенты = (meals, base) => meals.map(m => {
    const x = base.find(y => y.d === m.d && y.ref === m.ref);
    return { d: m.d, ref: m.ref, b: !!x?.b && !m.b, l: !!x?.l && !m.l };
}).filter(s => s.b || s.l);

// Пропуски → кухня, по каждому месту в пределах его дней ленты.
// places: resident_id → {check_in, check_out} — ранний заезд / поздний выезд, если в
// день заезда поставлен завтрак (в день выезда — обед), которого кухня не считала
async function сохранитьПропуски(meals, base, places = {}) {
    const пр = пропускиЛенты(meals, base);
    for (const ref of new Set(meals.map(m => m.ref).filter(Boolean))) {
        const дни = meals.filter(m => m.ref === ref);
        const p = places[ref];
        const добавлен = (d, k) => { const m = дни.find(x => x.d === d); const x = base.find(y => y.d === d && y.ref === ref); return !!m?.[k] && !x?.[k]; };
        const payload = { resident_id: ref, from: дни[0].d, to: дни[дни.length - 1].d,
            skips: пр.filter(s => s.ref === ref).map(({ d, b, l }) => ({ d, b, l })) };
        if (p && добавлен(p.check_in, 'b')) payload.early_checkin = true;
        if (p?.check_out && добавлен(p.check_out, 'l')) payload.late_checkout = true;
        if (!await call('fin_set_meal_skips', payload)) return false;
    }
    return true;
}

// Описание строки начисления: «Завтраки 30.09–05.10, без 02.10». Не было приёма в день
// заезда/выезда (утренний завтрак, обед после отъезда) — это не пропуск, в «без» не пишем
function описаниеПриёмов(назв, meals, k) {
    const есть = meals.filter(m => m[k]);
    if (!есть.length) return назв;
    const d = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
    const a = есть[0].d, b = есть[есть.length - 1].d;
    const без = meals.filter(m => !m[k] && m.d > a && m.d < b).map(m => d(m.d));
    return `${назв} ${a === b ? d(a) : `${d(a)}–${d(b)}`}${без.length ? `, без ${без.join(', ')}` : ''}`;
}

function расчёт(f) {
    if (f.freeOn) return { заНочь: 0, завтраков: 0, обедов: 0, проживание: 0, питание: 0, доп: 0, итого: 0 };
    // на доп. кровати — цена доп. кровати за ночь, иначе номер ÷ жильцов
    const заНочь = f.extraBed ? round2(f.extraBedPrice) : f.people > 0 ? round2(f.roomPrice / f.people) : 0;
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
                <div class="font-semibold">${e(v.name)} <span class="font-normal text-sm opacity-60">· ${v.room ? `${e(v.building || '')} №${e(String(v.room))} (${v.capacity}-мест.)` : 'самостоятельное проживание'} · ${дата(v.check_in)} — ${v.check_out ? дата(v.check_out) : '…'}</span></div>
                <div class="font-mono font-semibold">${inr(r.итого)}</div>
            </div>
            ${уже}
            <label class="flex flex-wrap items-center gap-2 text-sm mb-2 cursor-pointer">
                <input type="checkbox" class="toggle toggle-sm" data-gc-f="${rid}" data-k="freeOn" ${f.freeOn ? 'checked' : ''}>
                Без оплаты
                ${f.freeOn ? `<input type="text" list="gcFreeReasons" class="input input-bordered input-xs flex-1 min-w-48" placeholder="Причина *" data-gc-f="${rid}" data-k="freeReason" value="${e(f.freeReason)}">` : '<span class="text-xs opacity-60">гость ашрама, за счёт ашрама, пожертвование</span>'}
            </label>
            ${f.freeOn ? `<datalist id="gcFreeReasons"><option value="Гость ашрама"><option value="За счёт ашрама"><option value="Пожертвование"></datalist>
            <div class="text-xs opacity-60">Начисления не будет, визит перестанет висеть «не начислено», серый $ в шахматке уйдёт. Частичная оплата — обычное начисление со скидкой.</div>` : `
            ${personHtml(rid, f)}
            ${!v.room_id ? `<div class="text-xs opacity-60 mb-3">Живёт самостоятельно — за жильё не начисляется</div>` : `
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">Проживание</div>
            <div class="flex flex-wrap items-center gap-1 text-sm mb-3">
                <input type="number" min="0" step="1" class="input input-bordered input-xs w-16" data-gc-f="${rid}" data-k="nights" value="${f.nights}"> ноч. ×
                (<input type="number" min="0" step="50" class="input input-bordered input-xs w-24" data-gc-f="${rid}" data-k="roomPrice" value="${f.roomPrice}" title="Цена номера за сутки">
                ÷ <input type="number" min="1" step="1" class="input input-bordered input-xs w-14" data-gc-f="${rid}" data-k="people" value="${f.people}" title="Сколько человек делят номер"> чел.
                = <span class="font-mono">${inr(r.заНочь)}</span>)
                = <b class="font-mono">${inr(r.проживание)}</b>
            </div>
            ${(() => {
                const койки = Math.max(Number(f.roomType?.capacity) || Number(v.capacity) || 1, 1);
                const жильцов = Math.max(Number(v.roommates) || 1, 1);
                if (f.extraBed || койки === жильцов) return '';
                return f.people === койки
                    ? `<div class="text-xs -mt-2 mb-2 opacity-70">÷ ${койки} — койко-место. Семья заняла номер целиком? <button type="button" class="link link-primary" data-gc-people="${rid}" data-n="${жильцов}">÷ ${жильцов} жильцов</button></div>`
                    : f.people === жильцов
                    ? `<div class="text-xs -mt-2 mb-2 opacity-70">÷ ${жильцов} — номер на семью. <button type="button" class="link link-primary" data-gc-people="${rid}" data-n="${койки}">Койко-место: ÷ ${койки}</button></div>`
                    : '';
            })()}
            ${f.roomType?.price == null ? `<div class="text-xs text-warning -mt-2 mb-2">Цена номера ${f.roomType ? `«${e(f.roomType.name)}»` : `в здании «${e(v.building || '')}»`} не задана в Тарифах — впишите вручную</div>` : ''}
            ${f.roomType && Number(v.capacity) > Number(f.roomType.capacity) ? `<label class="flex flex-wrap items-center gap-1 text-sm mb-3 -mt-2 cursor-pointer">
                <input type="checkbox" class="checkbox checkbox-xs" data-gc-f="${rid}" data-k="extraBed" ${f.extraBed ? 'checked' : ''}>
                на доп. кровати <span class="opacity-60">(${v.capacity}-местный = ${f.roomType?.capacity}-местный + доп. кровать)</span>
                ${f.extraBed ? `— <input type="number" min="0" step="50" class="input input-bordered input-xs w-20" data-gc-f="${rid}" data-k="extraBedPrice" value="${f.extraBedPrice}"> за ночь` : ''}
            </label>` : ''}
            `}
            ${v.has_meals === false && !f.mealsOn ? `<div class="text-xs mb-3"><span class="opacity-60">Питание в шахматке выключено</span>
                <button type="button" class="btn btn-ghost btn-xs text-primary" data-gc-meals-on="${rid}" title="Если выключено по ошибке — включится и в шахматке, кухня посчитает его">включить питание</button></div>` : `
            <div class="text-xs font-semibold uppercase opacity-60 mb-1 flex items-center gap-2">Питание
                <button type="button" class="btn btn-ghost btn-xs normal-case font-normal" data-gc-all="${rid}" data-on="1">все</button>
                <button type="button" class="btn btn-ghost btn-xs normal-case font-normal" data-gc-all="${rid}" data-on="0">ничего</button>
            </div>
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
            <div class="text-[11px] opacity-60 mb-3">Завтрак в день заезда и обед в день выезда уходят в шахматку (ранний заезд / поздний выезд), снятые дни в середине — кухне как пропуск</div>`}
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">Дополнительно</div>
            <div class="flex flex-wrap items-center gap-1 mb-2">
                <input type="number" min="0" step="10" class="input input-bordered input-xs w-24" placeholder="₹" data-gc-f="${rid}" data-k="extraAmt" value="${f.extraAmt || ''}">
                <input type="text" class="input input-bordered input-xs flex-1 min-w-40" placeholder="За что (такси, стирка…)" data-gc-f="${rid}" data-k="extraDesc" value="${e(f.extraDesc)}">
            </div>
            <input type="text" class="input input-bordered input-xs w-full" placeholder="Комментарий (необязательно)" data-gc-f="${rid}" data-k="comment" value="${e(f.comment)}">`}
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
        if (f.freeOn) {
            if (!f.freeReason.trim()) { Layout.showNotification(`${f.v.name}: укажите причину «без оплаты»`, 'warning'); return; }
            continue;
        }
        if (f.person.mode === 'existing' && !f.person.id) { Layout.showNotification(`${f.v.name}: выберите карточку`, 'warning'); return; }
        if (f.person.mode === 'new') {
            const np = f.person.np;
            if (!(np.spiritual_name || np.first_name).trim()) { Layout.showNotification(`${f.v.name}: нужно имя`, 'warning'); return; }
            if (!(np.phone || np.email).trim()) { Layout.showNotification(`${f.v.name}: нужен телефон или почта`, 'warning'); return; }
        }
        if (расчёт(f).итого <= 0) { Layout.showNotification(`${f.v.name}: нечего начислять`, 'warning'); return; }
    }
    const повтор = [...selected].filter(rid => !forms[rid].freeOn).map(rid => forms[rid].v).filter(v => Number(v.charged) > 0);
    if (повтор.length && !confirm(`Уже есть начисления: ${повтор.map(v => v.name).join(', ')}. Добавить ещё?`)) return;

    let первый = null;
    for (const rid of [...selected]) {
        const f = forms[rid];
        const v = f.v;
        if (f.freeOn) {
            if (!await call('fin_guest_set_no_charge', { resident_id: rid, reason: f.freeReason.trim() })) return;
            selected.delete(rid);
            continue;
        }
        // отметку «без оплаты» сняли — убрать её до начисления
        if (v.no_charge_reason && !await call('fin_guest_set_no_charge', { resident_id: rid, reason: null })) return;
        const payload = { resident_id: rid };
        if (f.person.mode === 'linked' || f.person.mode === 'existing') payload.vaishnava_id = f.person.id;
        else payload.new_person = Object.fromEntries(Object.entries(f.person.np).map(([k, x]) => [k, (x || '').trim()]));
        if (f.mealsOn) payload.has_meals = true;
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
        const base = { retreat_id: retreatId, participant_id: pid, resident_id: rid, occurred_on: v.check_in };
        const rows = [];
        if (f.nights > 0 && r.заНочь > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'accommodation',
            description: `${f.extraBed ? 'Доп. кровать' : 'Проживание'} ${дата(v.check_in)}–${v.check_out ? дата(v.check_out) : '…'}${где}${!f.extraBed && f.people > 1 ? ` (номер ${inr(f.roomPrice)} ÷ ${f.people})` : ''}${хвост}`,
            quantity: f.nights, unit_price: вВалюту(r.заНочь) });
        if (r.завтраков && f.bPrice > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'meals',
            description: описаниеПриёмов('Завтраки', f.meals, 'b'), quantity: r.завтраков, unit_price: вВалюту(f.bPrice) });
        if (r.обедов && f.lPrice > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'meals',
            description: описаниеПриёмов('Обеды', f.meals, 'l'), quantity: r.обедов, unit_price: вВалюту(f.lPrice) });
        if (r.доп > 0) rows.push({ ...base, id: crypto.randomUUID(), kind: 'extra',
            description: f.extraDesc.trim() || 'Дополнительно', quantity: 1, unit_price: вВалюту(r.доп) });
        const res = await call('fin_create_charge', { rows });
        if (!res) return;
        // снятые дни в середине → кухня (края уже ушли флагами раннего заезда / позднего выезда)
        if (f.base && f.meals.length && !await сохранитьПропуски(f.meals, f.base)) return;
        selected.delete(rid);
        if (!первый) первый = pid;
    }
    document.getElementById('guestChargeModal').close();
    Layout.showNotification(первый ? 'Начислено — можно принимать оплату' : 'Сохранено', 'success');
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
    // список визитов за период
    document.querySelectorAll('[data-gv-step]').forEach(b => b.addEventListener('click', () => { setStep(b.dataset.gvStep); loadVisitList(); }));
    document.getElementById('gvPeriod')?.addEventListener('change', ev => { setStep(gv.step, ev.target.value); loadVisitList(); });
    document.getElementById('gvSearch')?.addEventListener('input', Layout.debounce(renderVisitList, 200));
    document.querySelector('main')?.addEventListener('click', ev => {
        const f = ev.target.closest('[data-gv-filter]');
        if (f) { gv.filter = gv.filter === f.dataset.gvFilter && !f.closest('.join') ? 'all' : f.dataset.gvFilter; renderVisitList(); return; }
        const row = ev.target.closest('[data-gv-visit]');
        if (row) openVisit(row.dataset.gvVisit);
    });
    document.getElementById('gvBody')?.addEventListener('keydown', ev => {
        const row = ev.target.closest('[data-gv-visit]');
        if (row && ev.key === 'Enter') openVisit(row.dataset.gvVisit);
    });
    document.getElementById('gcSearch')?.addEventListener('input', Layout.debounce(renderVisits, 200));
    document.getElementById('gcRoom')?.addEventListener('input', Layout.debounce(renderVisits, 200));
    document.getElementById('gcBuilding')?.addEventListener('change', renderVisits);
    document.getElementById('gcVisits')?.addEventListener('click', ev => {
        const row = ev.target.closest('[data-gc-visit]');
        if (row) toggleVisit(row.dataset.gcVisit);
    });
    const forms_ = document.getElementById('gcForms');
    // «все / ничего» по питанию — для долгих проживаний
    forms_?.addEventListener('click', ev => {
        // питание было выключено в шахматке по ошибке — включаем по датам визита,
        // при сохранении включится и в шахматке (ВГ, 28.09)
        const вкл = ev.target.closest('[data-gc-meals-on]');
        if (вкл) {
            const f = forms[вкл.dataset.gcMealsOn];
            f.mealsOn = true;
            f.meals = [];
            for (let d = DateUtils.parseDate(f.v.check_in); f.v.check_out && d <= DateUtils.parseDate(f.v.check_out); d.setDate(d.getDate() + 1)) {
                const iso = DateUtils.toISO(d);
                f.meals.push({ d: iso, ref: f.v.resident_id, b: iso !== f.v.check_in || !!f.v.early_checkin, l: iso !== f.v.check_out || !!f.v.late_checkout });
            }
            // база — дни по датам визита: снятое потом в середине уйдёт кухне пропуском
            f.base = f.meals.map(m => ({ ...m }));
            renderForms();
            return;
        }
        const дел = ev.target.closest('[data-gc-people]');
        if (дел) { forms[дел.dataset.gcPeople].people = Number(дел.dataset.n); renderForms(); return; }
        const btn = ev.target.closest('[data-gc-all]');
        if (!btn) return;
        const on = btn.dataset.on === '1';
        forms[btn.dataset.gcAll].meals.forEach(m => { m.b = on; m.l = on; });
        renderForms();
    });
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
            f[k] = ['extraBed', 'freeOn'].includes(k) ? el.checked : ['extraDesc', 'comment', 'freeReason'].includes(k) ? el.value : Number(el.value) || 0;
            renderForms();
        }
    });
    // текстовые поля карточки — без перерисовки, чтобы не терять курсор
    forms_?.addEventListener('input', ev => {
        const el = ev.target;
        if (el.dataset.gcNp) forms[el.dataset.gcNp].person.np[el.dataset.k] = el.value;
    });
}

window.FinGuests = { open, openTariffs, showTariffLine, collapsePicker, expandPicker, типНомера, loadVisitList, openVisit,
    базаПитания, сохранитьПропуски, описаниеПриёмов };
init();
})();
