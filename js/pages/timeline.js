// Шахматка проживания — Timeline Module
// Вынесено из placement/timeline.html

// Конфигурация
const DAYS_TO_SHOW = 90; // 3 месяца
const CELL_WIDTH = 24;   // ширина половины дня
const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

// Состояние сворачивания
const collapsedBuildings = new Set();
const collapsedRooms = new Set();

// Данные из БД
let timelineData = {
    retreats: [],
    buildings: []
};

// Справочники для форм
let categories = [];
let vaishnavas = [];
let departments = [];         // справочник департаментов (ВГ 02.10: у волонтёра и команды — обязательно)

// Хранилище гостей для кликов
let guestsMap = new Map();

// Хранилище уборок для кликов
let cleaningsMap = new Map();

// Даты Экадаши (загружаются из holidays)
let ekadashiDays = new Set();

// Фактическое время прибытия/отъезда из retreat_registrations
let retreatTimesMap = new Map();
const SELF_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.118a7.5 7.5 0 0115 0"/></svg>';
// Есть примечание у брони или места — значок «записка», текст в подсказке плашки (ТЗ 01.10, п. 6)
const NOTE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;margin-left:3px;vertical-align:-1px"><path d="M8 10h8M8 14h5M21 12a9 9 0 01-13.5 7.8L3 21l1.2-4.5A9 9 0 1121 12z"/></svg>';
const GUEST_CATEGORY_ID = '6ad3bfdd-cb95-453a-b589-986717615736'; // resident_categories: «Гость»
let allRetreats = [];         // для выбора ретрита при заселении (наши и сторонние мероприятия)
let retreatTags = new Map();  // retreat_id → { tag, name } только для ретритов, пересекающихся с другими в периоде
let creditorsSet = new Set(); // `${vaishnava_id}_${retreat_id}` — ашрам должен участнику (переплата при начисленной карточке)
let debtorsSet = new Set();   // `${vaishnava_id}_${retreat_id}` — участники с долгом по финмодулю
// Ключ финмодуля: у гостя без события вместо ретрита — служебный контейнер «Гости без события»
const finKey = res => res.vaishnava_id ? `${res.vaishnava_id}_${res.retreat_id || 'no-event'}` : null;
// Карточка в Финансах: гость без события открывается по визиту — начисление или оплата
const finHref = res => res.retreat_id
    ? `../finance/participants.html?retreat=${res.retreat_id}&open=${res.vaishnava_id}`
    : `../finance/participants.html?guests=1&visit=${res.id}`;
let uncharged = new Set();         // id визитов «гость без события»: начался, а не начислено и не «без оплаты»
// Значок $: красный — долг, зелёный — мы должны, серый — гость без события, которому ничего не начислено
function balanceBadge(res, hasDebt, hasCredit) {
    const kind = hasDebt ? 'debt' : hasCredit ? 'credit' : uncharged.has(res.id) ? 'uncharged' : '';
    if (!kind) return '';
    const title = kind === 'debt' ? t('timeline_has_debt') : kind === 'credit' ? t('timeline_we_owe') : tf('timeline_not_charged', 'Не начислено и не оплачено');
    return `<span class="balance-badge ${kind}" title="${Layout.escapeHtml(title)}" data-action="open-finance" data-href="${finHref(res)}">$</span>`;
}
// Значок $ на строке групповой брони (ВГ 03.10): если хоть у одного места долг или «не начислено» —
// тот же значок у группы, с числом таких мест; клик ведёт к первому такому месту.
// Важнее долг, потом «не начислено», потом «мы должны»
function groupBalanceBadge(seats) {
    const kindOf = r => debtorsSet.has(finKey(r)) ? 'debt' : creditorsSet.has(finKey(r)) ? 'credit' : uncharged.has(r.id) ? 'uncharged' : '';
    const kind = ['debt', 'uncharged', 'credit'].find(k => seats.some(r => kindOf(r) === k));
    if (!kind) return '';
    const hit = seats.filter(r => kindOf(r) === kind);
    const label = kind === 'debt' ? t('timeline_has_debt') : kind === 'credit' ? t('timeline_we_owe') : tf('timeline_not_charged', 'Не начислено и не оплачено');
    const title = `${label}: ${hit.length} ${tf('timeline_of', 'из')} ${seats.length}`;
    return `<span class="balance-badge ${kind}" title="${Layout.escapeHtml(title)}" data-action="open-finance" data-href="${finHref(hit[0])}">$</span>`;
}
let selfAccommodated = [];        // проживающие без номера: живут вне территории, в сетку не попадают
let selfStays = [];               // группа «Самостоятельное проживание» внизу шахматки
let mealStrips = [];             // питание группы по событию из «Разового питания» — полосой в «Самостоятельном проживании»
const expandedSelfGroups = new Set(); // раскрытые групповые брони без номера (по умолчанию свёрнуты)
const SEAT_FORMS = { ru: ['место', 'места', 'мест'], en: ['seat', 'seats'], hi: 'स्थान' };
const SELF_GROUP_ID = '__self';   // её ключ в collapsedBuildings: гости
const SELF_TEAM_ID = '__self_team';   // …и команда с волонтёрами — отдельным блоком (ВГ, 29.09)
const SELF_BLOCKS = [['guests', SELF_GROUP_ID], ['team', SELF_TEAM_ID]];
// Команда и волонтёры живут сами, но служат и едят с нами — их видно отдельно от гостей.
// slug обязателен в выборке resident_categories: без него все уходили в блок гостей (ВГ, 01.10)
function selfKind(res) {
    const cat = res.resident_categories || categories.find(c => c.id === res.category_id);
    return cat?.slug === 'team' || cat?.slug === 'volunteer' ? 'team' : 'guests';
}
let periodRetreats = [];          // ретриты показанного периода — для «Сам организует» из CRM
let periodResidents = [];         // все проживания периода — чтобы не дублировать людей из CRM
let cancelledDealsSet = new Set(); // `${vaishnava_id}_${retreat_id}` — все сделки человека по ретриту отменены
let specialNeedsMap = new Map();   // `${vaishnava_id}_${retreat_id}` — особые потребности из CRM
let mealSkipsMap = new Map();      // resident_id → Map(d → {b, l}) — пропуски питания (отлучки, мигр. 627)

// Флаг права на редактирование таймлайна
const canEditTimeline = () => window.hasPermission?.('edit_timeline') ?? false;

// Базовая дата (сегодня минус 2 дня)
let baseDate = new Date();
baseDate.setHours(0, 0, 0, 0);
baseDate.setDate(baseDate.getDate() - 2);

// Индекс сегодняшнего дня относительно baseDate
const TODAY_INDEX = 2;

// Преобразовать дату в dayIndex относительно baseDate
function dateToDayIndex(dateStr) {
    const date = DateUtils.parseDate(dateStr);
    date.setHours(0, 0, 0, 0);
    const diff = date - baseDate;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

const AWAY_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';

// Отлучка на полосе гостя: снятый завтрак — крестик в первой половине дня, обед — во второй.
// Номер остаётся за человеком, кухня его не считает (resident_meal_skips, мигр. 627)
function awayHatchHtml(residentId, startCol, spanCells) {
    const skips = mealSkipsMap.get(residentId);
    if (!skips) return '';
    const title = e(tf('timeline_away_hatch', 'Не ест — уехал на время'));
    let html = '';
    for (const [d, sk] of skips) {
        const day = dateToDayIndex(d) * 2 - startCol;
        for (const [half, off] of [[0, sk.b], [1, sk.l]]) {
            const col = day + half;
            if (!off || col < 0 || col >= spanCells) continue;
            html += `<span class="away-hatch" style="left: ${col * CELL_WIDTH - 1}px; width: ${CELL_WIDTH}px;" title="${title}">${AWAY_X}</span>`;
        }
    }
    return html;
}

// Буквенная метка ретрита в полосе гостя: «(СР) Иван». Нужна только там, где ретриты идут
// одновременно, — иначе непонятно, кто к какому относится; у непересекающихся метки нет.
// Буквы — свои из карточки ретрита (short_name), иначе первые буквы двух первых слов названия
// (без предлогов и годов); при совпадении у пересекающихся
// ретритов добавляется номер.
const TAG_STOPWORDS = new Set(['для', 'и', 'в', 'на', 'с', 'по', 'of', 'the', 'for', 'and', 'in']);
function retreatInitials(name) {
    const words = (name || '').split(/[\s\-–—.,:()]+/).filter(w => w && !/^\d+$/.test(w) && !TAG_STOPWORDS.has(w.toLowerCase()));
    return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function computeRetreatTags(list) {
    const overlaps = (a, b) => a.start_date <= b.end_date && a.end_date >= b.start_date;
    const inOverlap = list.filter(r => list.some(o => o.id !== r.id && overlaps(r, o)));
    const used = new Map();
    const tags = new Map();
    inOverlap.forEach(r => {
        const name = Layout.getName(r);
        let tag = r.short_name?.trim() || retreatInitials(name) || '?';
        const n = (used.get(tag) || 0) + 1;
        used.set(tag, n);
        if (n > 1) tag += n;
        tags.set(r.id, { tag, name });
    });
    return tags;
}

// Загрузка данных из БД
async function loadTimelineData() {
    const endDate = new Date(baseDate);
    endDate.setDate(endDate.getDate() + DAYS_TO_SHOW);
    const startDateStr = formatDateYMD(baseDate);
    const endDateStr = formatDateYMD(endDate);

    // Урезанный кэш зданий (только названия — его раньше клала страница Бронирований)
    // ломал порядок: временные здания вставали перед Гостевым домом. Такой — выбрасываем
    const кэшЗданий = Cache.get('buildings');
    if (кэшЗданий && кэшЗданий.some(b => !('is_temporary' in b))) Cache.invalidate('buildings');

    // Загружаем параллельно
    const [buildingsData, roomsRes, residentsRes, retreatsRes, cleaningsRes, holidaysRes, skipsRes] = await Promise.all([
        Cache.getOrLoad('buildings', async () => {
            const { data, error } = await Layout.db.from('buildings')
                .select('*, building_types(id, slug, color, name_ru, name_en, name_hi)')
                .eq('is_active', true)
                .order('sort_order');
            if (error) { console.error('Error loading buildings:', error); return null; }
            return data;
        }),
        Layout.db.from('rooms')
            .select('id, number, floor, building_id, capacity, status, plan_x, plan_y, plan_width, plan_height')
            .eq('is_active', true)
            .order('building_id')
            .order('floor')
            .order('number'),
        Layout.db.from('residents')
            .select(`*,
                resident_categories(id, slug, name_ru, name_en, name_hi, color),
                vaishnavas(id, first_name, last_name, spiritual_name, service),
                bookings(id, name, contact_name, contact_phone, contact_telegram, notes)`)
            .in('status', ['confirmed', 'checked_out', 'booked'])
            .lte('check_in', endDateStr)
            .or(`check_out.is.null,check_out.gte.${startDateStr}`),
        Layout.db.from('retreats')
            .select('id, name_ru, name_en, name_hi, short_name, start_date, end_date, color, is_external')
            .lte('start_date', endDateStr)
            .gte('end_date', startDateStr)
            .order('start_date'),
        Layout.db.from('room_cleanings')
            .select('id, room_id, start_date, end_date, type, completed, completed_at')
            .lte('start_date', endDateStr)
            .gte('end_date', startDateStr),
        Layout.db.from('holidays')
            .select('date')
            .eq('type', 'ekadashi')
            .gte('date', startDateStr)
            .lte('date', endDateStr),
        Layout.db.from('resident_meal_skips')
            .select('resident_id, d, breakfast, lunch')
            .gte('d', startDateStr)
            .lte('d', endDateStr)
    ]);
    mealSkipsMap = new Map();
    for (const sk of (skipsRes.data || [])) {
        if (!mealSkipsMap.has(sk.resident_id)) mealSkipsMap.set(sk.resident_id, new Map());
        mealSkipsMap.get(sk.resident_id).set(sk.d, { b: sk.breakfast, l: sk.lunch });
    }

    if (roomsRes.error) console.error('Error loading rooms:', roomsRes.error);
    if (residentsRes.error) console.error('Error loading residents:', residentsRes.error);
    if (retreatsRes.error) console.error('Error loading retreats:', retreatsRes.error);
    if (cleaningsRes.error) console.error('Error loading cleanings:', cleaningsRes.error);
    if (holidaysRes.error) console.error('Error loading holidays:', holidaysRes.error);

    let buildings = buildingsData || [];
    const rooms = roomsRes.data || [];
    const residents = residentsRes.data || [];
    selfAccommodated = residents.filter(r => !r.room_id);
    periodResidents = residents;
    const retreats = retreatsRes.data || [];
    periodRetreats = retreats;
    retreatTags = computeRetreatTags(retreats);
    // Для выбора при брони/заселении нужны не только ретриты просматриваемого периода:
    // бронируют и на будущие, а прошедшие — через «Архив / все ретриты…». Ретритов
    // немного, берём все; что показать в списке, решает retreatFitsDates.
    // fact_end — фактическое окончание (миграции 603, 605): внутренний ретрит идёт, пока живут
    // его люди; обычный — не дольше конца + 3 дня.
    const [{ data: selectableRetreats }, { data: factEnds }] = await Promise.all([
        Layout.db.from('retreats')
            .select('id, name_ru, name_en, name_hi, short_name, start_date, end_date, color, is_external, contact_vaishnava_id')
            .order('start_date'),
        Layout.db.from('retreat_fact_end').select('retreat_id, fact_end, is_internal')
    ]);
    const factEndMap = new Map((factEnds || []).map(f => [f.retreat_id, f]));
    allRetreats = (selectableRetreats || retreats).map(r => ({ ...r,
        fact_end: factEndMap.get(r.id)?.fact_end || r.end_date,
        is_internal: !!factEndMap.get(r.id)?.is_internal }));
    // Самостоятельное проживание — отдельной группой внизу шахматки: без номера + «Сам организует»
    // из CRM. Раскрыта, если в периоде кто-то есть, свёрнута — если никого
    const fromCrm = await loadCrmSelfAccommodated().catch(err => {
        console.error('CRM self accommodation:', err);
        return [];
    });
    // Сверху питающиеся, ниже не питающиеся, внутри — по алфавиту
    const selfName = r => (r.vaishnavas ? getVaishnavName(r.vaishnavas, '') : '') || r.guest_name || r.bookings?.name || '';
    selfStays = [...selfAccommodated, ...fromCrm].sort((a, b) =>
        (a.has_meals === false) - (b.has_meals === false)
        || selfName(a).localeCompare(selfName(b), 'ru'));
    // Питание группы по событию (ВГ, 08.10.2026): запись «Разового питания» с ретритом и дольше
    // 3 дней — полосой в «Самостоятельном проживании — гости»; клик — то же окно, что на странице
    const { data: mg, error: mgErr } = await Layout.db.from('meal_groups')
        .select('*')
        .not('retreat_id', 'is', null)
        .lte('start_date', endDateStr)
        .gte('end_date', startDateStr)
        .order('start_date');
    if (mgErr) console.error('meal_groups:', mgErr);
    const днейВЗаписи = g => Math.round((DateUtils.parseDate(g.end_date) - DateUtils.parseDate(g.start_date)) / 86400000) + 1;
    mealStrips = (mg || []).filter(g => днейВЗаписи(g) > 3);
    // числа по дням — для раскрытой полосы (строки «Завтраки» / «Обеды»)
    const byDayIds = mealStrips.filter(g => g.by_day).map(g => g.id);
    const { data: mgd, error: mgdErr } = byDayIds.length
        ? await Layout.db.from('meal_group_days').select('group_id, d, breakfast, lunch, note').in('group_id', byDayIds)
        : { data: [] };
    if (mgdErr) console.error('meal_group_days:', mgdErr);
    for (const g of mealStrips) g.days = new Map();
    for (const r of mgd || []) mealStrips.find(g => g.id === r.group_id)?.days.set(r.d, { b: r.breakfast, l: r.lunch, note: r.note });
    for (const [kind, id] of SELF_BLOCKS) {
        if (selfStays.some(r => selfKind(r) === kind) || (kind === 'guests' && mealStrips.length)) collapsedBuildings.delete(id);
        else collapsedBuildings.add(id);
    }
    const cleanings = cleaningsRes.data || [];

    // Строим Set dayIndex-ов для Экадаши
    ekadashiDays = new Set(
        (holidaysRes.data || []).map(h => dateToDayIndex(h.date))
    );

    // Загружаем фактическое время прибытия/отъезда из регистраций
    const residentRetreatIds = [...new Set(residents.filter(r => r.retreat_id).map(r => r.retreat_id))];
    retreatTimesMap = new Map();
    if (residentRetreatIds.length > 0) {
        const { data: regTimes } = await Layout.db
            .from('retreat_registrations')
            .select('vaishnava_id, retreat_id, arrival_datetime, departure_datetime')
            .in('retreat_id', residentRetreatIds)
            .eq('is_deleted', false);
        for (const reg of (regTimes || [])) {
            if (reg.vaishnava_id) {
                retreatTimesMap.set(`${reg.vaishnava_id}_${reg.retreat_id}`, {
                    arrival: reg.arrival_datetime,
                    departure: reg.departure_datetime
                });
            }
        }
    }

    // Должники по финмодулю: только флаг «есть долг», без сумм (fin_retreat_debtors
    // отдаёт список id; детали — в финмодуле по его собственным правам)
    debtorsSet = new Set();
    creditorsSet = new Set();
    await Promise.all(residentRetreatIds.map(async rid => {
        const [debtors, creditors] = await Promise.all([
            Layout.db.rpc('fin_retreat_debtors', { p_retreat: rid }),
            Layout.db.rpc('fin_retreat_creditors', { p_retreat: rid })
        ]);
        // нет прав/сбой — шахматка работает без значка
        if (!debtors.error) for (const row of (debtors.data || [])) debtorsSet.add(`${row.participant_id}_${rid}`);
        if (!creditors.error) for (const row of (creditors.data || [])) creditorsSet.add(`${row.participant_id}_${rid}`);
    }));
    // Гости без события (ВГ, 29.09): долг ведётся в служебном контейнере, флаги — отдельной функцией
    if (residents.some(r => r.vaishnava_id && !r.retreat_id)) {
        const { data, error } = await Layout.db.rpc('fin_no_event_debt_flags');
        if (!error) for (const row of (data || [])) (row.is_debt ? debtorsSet : creditorsSet).add(`${row.participant_id}_no-event`);
    }
    // Серый $: гость без события живёт, а не начислено и не отмечено «без оплаты» (ВГ, 01.10)
    uncharged = new Set();
    if (residents.some(r => !r.retreat_id)) {
        const { data, error } = await Layout.db.rpc('fin_no_event_uncharged');
        if (!error) for (const row of (data || [])) uncharged.add(row.resident_id);
    }

    // Сделка отменена, а бронь в шахматке осталась: сами не снимаем (иначе не заметим, что место
    // освободилось), а вешаем красную плашку «Отмена» — снять бронь руками. Если у человека есть
    // другая, живая сделка по тому же ретриту, это не отмена.
    cancelledDealsSet = new Set();
    if (residentRetreatIds.length) {
        const { data: dealRows } = await Layout.db.from('crm_deals')
            .select('vaishnava_id, retreat_id, status')
            .in('retreat_id', residentRetreatIds)
            .not('vaishnava_id', 'is', null);
        const alive = new Set();
        for (const d of (dealRows || [])) {
            const key = `${d.vaishnava_id}_${d.retreat_id}`;
            if (d.status === 'cancelled') cancelledDealsSet.add(key); else alive.add(key);
        }
        alive.forEach(key => cancelledDealsSet.delete(key));
    }

    // Особые потребности из сделок CRM (доп. подушка, обогреватель…) — значок
    // на баре, детали по клику в карточке (ТЗ 2.3)
    specialNeedsMap = new Map();
    if (residentRetreatIds.length) {
        const { data: нужды } = await Layout.db.from('crm_deals')
            .select('vaishnava_id, retreat_id, special_needs')
            .in('retreat_id', residentRetreatIds).neq('status', 'cancelled')
            .not('special_needs', 'is', null);
        for (const d of (нужды || [])) {
            if (d.special_needs?.trim()) specialNeedsMap.set(`${d.vaishnava_id}_${d.retreat_id}`, d.special_needs.trim());
        }
    }

    // Внешние (временные) здания — только когда в них кто-то живёт или забронирован
    // в показанном периоде; нет записей — здание пропадает из списка (ВГ, 29.09).
    // Поставить первую бронь во внешнее здание — через «Перенос» или Бронирования
    const зданиеНомера = new Map(rooms.map(r => [r.id, r.building_id]));
    const занятыеЗдания = new Set(residents.filter(r => r.room_id).map(r => зданиеНомера.get(r.room_id)));
    buildings = buildings.filter(b => !b.is_temporary || занятыеЗдания.has(b.id));

    // Сортируем: сначала постоянные, потом временные (внутри — по sort_order)
    buildings.sort((a, b) => (a.is_temporary ? 1 : 0) - (b.is_temporary ? 1 : 0) || (a.sort_order || 0) - (b.sort_order || 0));

    // Очищаем хранилища
    guestsMap.clear();
    cleaningsMap.clear();

    // Преобразуем ретриты
    timelineData.retreats = retreats.map(r => {
        const rawStartDay = dateToDayIndex(r.start_date);
        const rawEndDay = dateToDayIndex(r.end_date);
        return {
            name: Layout.getName(r),
            color: r.color,
            dates: DateUtils.formatRange(r.start_date, r.end_date),
            startDay: Math.max(0, rawStartDay),
            endDay: Math.min(DAYS_TO_SHOW - 1, rawEndDay),
            rawStartDay,
            rawEndDay
        };
    }).filter(r => r.rawStartDay <= DAYS_TO_SHOW - 1 && r.rawEndDay >= 0);

    // Группируем комнаты по зданиям
    const roomsByBuilding = {};
    rooms.forEach(room => {
        if (!roomsByBuilding[room.building_id]) {
            roomsByBuilding[room.building_id] = [];
        }
        roomsByBuilding[room.building_id].push(room);
    });

    // Сортируем номера числовым способом (1, 2, 3, 10, 11, а не 1, 10, 11, 2, 3)
    Object.values(roomsByBuilding).forEach(roomList => {
        roomList.sort((a, b) => {
            // Сначала по этажу
            if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
            // Потом по номеру (натуральная сортировка)
            return a.number.localeCompare(b.number, undefined, { numeric: true });
        });
    });

    // Группируем резидентов по комнатам (исключаем самостоятельное размещение)
    const residentsByRoom = {};
    residents.forEach(res => {
        // Skip self-accommodation (NULL room_id)
        if (!res.room_id) return;

        if (!residentsByRoom[res.room_id]) {
            residentsByRoom[res.room_id] = [];
        }
        residentsByRoom[res.room_id].push(res);
    });

    // Группируем ручные уборки по комнатам
    const cleaningsByRoom = {};
    cleanings.forEach(c => {
        if (!cleaningsByRoom[c.room_id]) {
            cleaningsByRoom[c.room_id] = [];
        }
        cleaningsByRoom[c.room_id].push(c);
    });

    // Формируем структуру данных
    timelineData.buildings = buildings.map(building => {
        const buildingRooms = roomsByBuilding[building.id] || [];

        return {
            id: building.id,
            name: Layout.getName(building),
            isTemporary: building.is_temporary || false,
            availableFromDay: building.available_from ? dateToDayIndex(building.available_from) : null,
            availableUntilDay: building.available_until ? dateToDayIndex(building.available_until) : null,
            rooms: buildingRooms.map(room => {
                const capacity = room.capacity || 1;
                const roomResidents = residentsByRoom[room.id] || [];

                // Создаём виртуальные места
                const beds = [];
                for (let i = 0; i < capacity; i++) {
                    beds.push({
                        name: capacity === 1 ? '' : `${i + 1}`,
                        roomId: room.id,
                        bedIndex: i,
                        guests: []
                    });
                }

                // Массив уборок на уровне комнаты
                const roomCleaningsList = [];

                // Распределяем резидентов по местам
                // Сортируем по дате заселения
                roomResidents.sort((a, b) => DateUtils.parseDate(a.check_in) - DateUtils.parseDate(b.check_in));

                roomResidents.forEach(res => {
                    const startDay = Math.max(0, dateToDayIndex(res.check_in));
                    const endDay = res.check_out
                        ? Math.min(DAYS_TO_SHOW - 1, dateToDayIndex(res.check_out))
                        : DAYS_TO_SHOW - 1;

                    if (startDay > DAYS_TO_SHOW - 1 || endDay < 0) return;

                    // Получаем имя резидента
                    let guestName = res.guest_name || '';
                    if (res.vaishnavas) {
                        guestName = getVaishnavName(res.vaishnavas, '');
                    }
                    // Если это бронирование - показываем название брони или имя контакта
                    if (!guestName && res.bookings) {
                        guestName = res.bookings.name || res.bookings.contact_name || '';
                    }

                    // Определяем, это бронирование или заселение.
                    // Бронь = гость ещё не отмечен приехавшим («Заселить» не нажимали).
                    // Раньше признаком было пустое имя — из-за этого бронь с именем
                    // выглядела заселением и теряла кнопку «Заселить» (03.08.2026).
                    const isBooking = res.status === 'booked' || !res.arrived_at;

                    // Получаем цвет категории
                    const category = res.resident_categories;
                    const color = category?.color || '#3b82f6';
                    // Делаем border темнее
                    const border = color;

                    // Ранний заезд = обе половины дня заезда (startHalf = 0)
                    // Обычный заезд = только вторая половина (startHalf = 1)
                    // Поздний выезд = обе половины дня выезда (endHalf = 1)
                    // Обычный выезд = только первая половина (endHalf = 0)
                    let startHalf = res.early_checkin === true ? 0 : 1;
                    let endHalf = res.late_checkout === true ? 1 : 0;

                    // Уточняем по фактическому времени из регистрации на ретрит
                    if (res.vaishnava_id && res.retreat_id) {
                        const regTimes = retreatTimesMap.get(`${res.vaishnava_id}_${res.retreat_id}`);
                        if (regTimes) {
                            if (!res.early_checkin && regTimes.arrival) {
                                const hour = new Date(regTimes.arrival.slice(0, 16)).getHours();
                                if (hour < 10) startHalf = 0;
                            }
                            if (!res.late_checkout && regTimes.departure) {
                                const hour = new Date(regTimes.departure.slice(0, 16)).getHours();
                                if (hour >= 13) endHalf = 1;
                            }
                        }
                    }

                    // Если заезд и выезд в один день, корректируем чтобы span был минимум 1
                    if (startDay === endDay && startHalf > endHalf) {
                        // Показываем хотя бы одну половину
                        endHalf = startHalf;
                    }

                    const guest = {
                        id: res.id,
                        name: guestName || '—',
                        // Департамент места (ВГ 02.10) — на плашке «Имя · Кухня» и в поиске
                        dept: departmentName(res.department_id),
                        // Примечание брони или места — значок на плашке, текст в подсказке (ТЗ 01.10, п. 6)
                        note: res.notes || res.bookings?.notes || '',
                        startDay,
                        startHalf,
                        endDay,
                        endHalf,
                        color,
                        border,
                        isBooking,
                        retreatTag: res.retreat_id ? (retreatTags.get(res.retreat_id) || null) : null,
                        // Гость без события: обычный «Гость» без ретрита. Команда, волонтёры и важные
                        // гости и так выделены своими категориями. В шахматке — точечная рамка.
                        isSelf: !res.retreat_id && res.category_id === GUEST_CATEGORY_ID,
                        isCheckedOut: res.status === 'checked_out',
                        // Уже выселенных не помечаем: прожил — значит, приезжал
                        isDealCancelled: !!(res.vaishnava_id && res.retreat_id && res.status !== 'checked_out'
                            && cancelledDealsSet.has(`${res.vaishnava_id}_${res.retreat_id}`)),
                        hasDebt: debtorsSet.has(finKey(res)),
                        hasCredit: creditorsSet.has(finKey(res)),
                        specialNeeds: (res.vaishnava_id && res.retreat_id
                            && specialNeedsMap.get(`${res.vaishnava_id}_${res.retreat_id}`)) || null,
                        // Сырые данные для модалки
                        rawData: res
                    };

                    // Уборка после выезда (не для временных зданий)
                    // Обычный выезд (endHalf=0): уборка со второй половины дня выезда
                    // Поздний выезд (endHalf=1): уборка с первой половины СЛЕДУЮЩЕГО дня
                    // ВАЖНО: уборка создаётся только если нет пересекающихся проживаний с более поздним выездом
                    let cleaningEntry = null;
                    const hasOthersStayingLonger = roomResidents.some(other => {
                        if (other.id === res.id) return false;
                        // Проверяем пересечение периодов проживания
                        const overlaps = other.check_in < res.check_out &&
                                         (other.check_out === null || other.check_out > res.check_in);
                        // И что другой выезжает позже
                        const staysLonger = other.check_out === null || other.check_out > res.check_out;
                        return overlaps && staysLonger;
                    });
                    if (res.check_out && !building.isTemporary && !hasOthersStayingLonger) {
                        let cleaningStartDay, cleaningStartHalf, cleaningEndDay, cleaningEndHalf;

                        if (endHalf === 0) {
                            // Обычный выезд — уборка начинается во второй половине дня выезда
                            cleaningStartDay = endDay;
                            cleaningStartHalf = 1;
                            cleaningEndDay = endDay + 1;
                            cleaningEndHalf = 0;
                        } else {
                            // Поздний выезд — уборка начинается на следующий день
                            cleaningStartDay = endDay + 1;
                            cleaningStartHalf = 0;
                            cleaningEndDay = endDay + 1;
                            cleaningEndHalf = 1;
                        }

                        // Если уборка попадает в диапазон отображения — показываем (выполненные тоже, но не удалённые)
                        if (cleaningStartDay < DAYS_TO_SHOW && !res.cleaning_skipped) {
                            const autoCleaningId = 'cleaning-' + res.id;
                            cleaningEntry = {
                                id: autoCleaningId,
                                cleaningId: autoCleaningId,
                                residentId: res.id, // для обновления cleaning_done
                                name: '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>',
                                startDay: cleaningStartDay,
                                startHalf: cleaningStartHalf,
                                endDay: Math.min(cleaningEndDay, DAYS_TO_SHOW - 1),
                                endHalf: cleaningEndDay >= DAYS_TO_SHOW ? 1 : cleaningEndHalf,
                                isCleaning: true,
                                isAutoCleaning: true,
                                isCompleted: res.cleaning_done || false,
                                rawData: {
                                    room_id: room.id,
                                    start_date: formatDateYMD(getDateForDay(cleaningStartDay)),
                                    end_date: formatDateYMD(getDateForDay(cleaningEndDay))
                                }
                            };
                        }
                    }

                    // Ищем свободное место для этого периода
                    let placed = false;
                    let placedBed = null;
                    for (const bed of beds) {
                        const hasOverlap = bed.guests.some(g => {
                            if (g.isCleaning) return false; // Уборка не блокирует
                            const gStart = g.startDay * 2 + g.startHalf;
                            const gEnd = g.endDay * 2 + g.endHalf;
                            const rStart = guest.startDay * 2 + guest.startHalf;
                            const rEnd = guest.endDay * 2 + guest.endHalf;
                            return !(rEnd < gStart || rStart > gEnd);
                        });

                        if (!hasOverlap) {
                            bed.guests.push(guest);
                            // Сохраняем в хранилище с контекстом
                            guestsMap.set(guest.id, { ...guest, buildingName: Layout.getName(building), roomName: room.number });
                            placedBed = bed;
                            placed = true;
                            break;
                        }
                    }

                    // Если не нашли место, добавляем в первое (будет визуальное наложение)
                    if (!placed && beds.length > 0) {
                        beds[0].guests.push(guest);
                        guestsMap.set(guest.id, { ...guest, buildingName: Layout.getName(building), roomName: room.number });
                        placedBed = beds[0];
                    }

                    // Добавляем автоуборку в cleaningsMap (не в beds!)
                    if (cleaningEntry) {
                        cleaningsMap.set(cleaningEntry.id, {
                            ...cleaningEntry,
                            roomId: room.id,
                            buildingName: Layout.getName(building),
                            roomName: room.number,
                            isAuto: true,
                            residentId: res.id
                        });
                        roomCleaningsList.push(cleaningEntry);
                    }
                });

                // Добавляем ручные уборки
                const roomCleanings = cleaningsByRoom[room.id] || [];
                roomCleanings.forEach(c => {
                    const startDay = Math.max(0, dateToDayIndex(c.start_date));
                    const endDay = Math.min(DAYS_TO_SHOW - 1, dateToDayIndex(c.end_date));

                    if (startDay > DAYS_TO_SHOW - 1 || endDay < 0) return;

                    // Определяем половины дня:
                    // - linen: только первая половина дня (0-0)
                    // - cleaning с start_date === end_date: обе половины одного дня (0-1)
                    // - cleaning с end_date = start_date + 1: вторая половина первого + первая второго (1-0)
                    const isBedding = c.type === 'linen';
                    const sameDay = c.start_date === c.end_date;
                    let startHalf, endHalf;
                    if (isBedding) {
                        startHalf = 0;
                        endHalf = 0; // только первая половина
                    } else if (sameDay) {
                        startHalf = 0;
                        endHalf = 1;
                    } else {
                        startHalf = 1;
                        endHalf = 0;
                    }

                    // Иконка зависит от типа
                    const icon = isBedding
                        ? '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>'
                        : '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>';

                    const cleaningEntry = {
                        id: 'manual-cleaning-' + c.id,
                        cleaningId: c.id,
                        name: icon,
                        type: c.type || 'cleaning',
                        startDay,
                        startHalf,
                        endDay,
                        endHalf,
                        isCleaning: true,
                        isManualCleaning: true,
                        isCompleted: c.completed || false,
                        rawData: c
                    };

                    // Сохраняем в хранилище с контекстом
                    cleaningsMap.set(c.id, {
                        ...cleaningEntry,
                        roomId: room.id,
                        buildingName: Layout.getName(building),
                        roomName: room.number
                    });

                    roomCleaningsList.push(cleaningEntry);
                });

                return {
                    id: room.id,
                    name: room.number,
                    beds,
                    cleanings: roomCleaningsList // Уборки на уровне комнаты
                };
            })
        };
    }).filter(b => b.rooms.length > 0);
}

// Получить дату для дня
function getDateForDay(dayIndex) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + dayIndex);
    return date;
}

// Проверка выходного
function isWeekend(dayIndex) {
    const date = getDateForDay(dayIndex);
    const day = date.getDay();
    return day === 0 || day === 6;
}

// Проверка Экадаши
function isEkadashi(dayIndex) {
    return ekadashiDays.has(dayIndex);
}

// Получить день недели
function getWeekdayName(dayIndex) {
    const days = DateUtils.dayNamesShort[Layout.currentLang] || DateUtils.dayNamesShort.ru;
    const date = getDateForDay(dayIndex);
    return days[date.getDay()];
}

// Переключить сворачивание здания
function toggleBuilding(buildingId) {
    if (collapsedBuildings.has(buildingId)) {
        collapsedBuildings.delete(buildingId);
    } else {
        collapsedBuildings.add(buildingId);
    }
    renderTable();
}

// Переключить сворачивание номера
function toggleRoom(roomId) {
    if (collapsedRooms.has(roomId)) {
        collapsedRooms.delete(roomId);
    } else {
        collapsedRooms.add(roomId);
    }
    renderTable();
}

// Свернуть все номера (здания остаются развёрнутыми)
function collapseAllRooms() {
    collapsedBuildings.clear();
    collapsedRooms.clear();
    timelineData.buildings.forEach(building => {
        building.rooms.forEach(room => {
            collapsedRooms.add(room.id);
        });
    });
    renderTable();
}

// Свернуть всё (включая здания)
function collapseAllBuildings() {
    collapsedBuildings.clear();
    collapsedRooms.clear();
    collapsedBuildings.add(SELF_GROUP_ID);
    collapsedBuildings.add(SELF_TEAM_ID);
    timelineData.buildings.forEach(building => {
        collapsedBuildings.add(building.id);
        building.rooms.forEach(room => {
            collapsedRooms.add(room.id);
        });
    });
    renderTable();
}

// Развернуть всё
function expandAll() {
    collapsedBuildings.clear();
    collapsedRooms.clear();
    renderTable();
}

// Текущий контекст модалки
let modalContext = null;

// Форматировать дату для input[type="date"]
function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Открыть модалку действий
function openActionModal(dayIndex, roomId, buildingName, roomName, bedName, halfIndex = 0) {
    // Проверка прав на редактирование
    if (!canEditTimeline()) return;

    const checkInDate = getDateForDay(dayIndex);
    const checkOutDate = getDateForDay(dayIndex + 1);

    // Сохраняем контекст (сбрасываем флаг конвертации)
    modalContext = { dayIndex, halfIndex, roomId, buildingName, roomName, bedName, isConversion: false };

    // Заполняем поля
    const location = bedName
        ? `${buildingName} → ${roomName} → ${t('timeline_bed')} ${bedName}`
        : `${buildingName} → ${roomName}`;
    document.getElementById('modalLocation').textContent = location;
    document.getElementById('modalCheckIn').value = formatDateForInput(checkInDate);
    document.getElementById('modalCheckOut').value = formatDateForInput(checkOutDate);

    // Показываем экран выбора действия
    showActionScreen();

    // Открываем модалку
    document.getElementById('actionModal').showModal();
}

// Загрузка справочников
async function loadDictionaries() {
    const [catData, vaishnavasRes] = await Promise.all([
        Cache.getOrLoad('resident_categories', async () => {
            const { data, error } = await Layout.db.from('resident_categories').select('*').order('sort_order');
            if (error) { console.error('Error loading resident_categories:', error); return null; }
            return (data || []).filter(c => (c.sort_order || 0) < 999);
        }),
        Utils.fetchAll((from, to) => Layout.db.from('vaishnavas').select('id, spiritual_name, first_name, last_name, gender, phone, telegram, telegram_username, birth_date, status').eq('is_deleted', false).order('spiritual_name').range(from, to)),
        Layout.db.from('departments').select('id, name_ru, name_en, name_hi, sort_order').order('sort_order')
            .then(({ data, error }) => { if (error) console.error('departments:', error); departments = data || []; })
    ]);
    categories = catData || [];
    vaishnavas = vaishnavasRes.data || [];
    const deptSelect = document.getElementById('bookingDepartment');
    if (deptSelect) deptSelect.innerHTML = '<option value="">—</option>'
        + departments.map(d => `<option value="${d.id}">${e(Layout.getName(d))}</option>`).join('');

    // Заполняем категории
    const catSelect = document.getElementById('checkinCategory');
    catSelect.innerHTML = '<option value="">—</option>' +
        categories.map(c => `<option value="${c.id}">${Layout.getName(c)}</option>`).join('');
    const bookingCatSelect = document.getElementById('bookingCategory');
    if (bookingCatSelect) bookingCatSelect.innerHTML = catSelect.innerHTML;

    // Рендерим легенду
    renderLegend();
}

// Легенда цветов
function renderLegend() {
    const legend = document.getElementById('legend');

    // Категории заселений
    const categoriesHtml = categories.map(c => {
        const color = c.color || '#3b82f6';
        return `<div class="flex items-center gap-1 whitespace-nowrap">
            <span class="w-3 h-3 rounded shrink-0" style="background: ${color}; border: 1px solid rgba(0,0,0,0.15);"></span>
            <span class="text-xs text-gray-600">${Layout.getName(c)}</span>
        </div>`;
    }).join('');

    // Бронирования (штриховка)
    const bookingHtml = `<div class="flex items-center gap-1 whitespace-nowrap">
        <span class="w-3 h-3 rounded" style="background: repeating-linear-gradient(45deg, #9dc1f7, #9dc1f7 2px, #e3edfd 2px, #e3edfd 4px); border: 1px dashed #1e40af;"></span>
        <span class="text-xs text-gray-600">${t('timeline_booking')}</span>
    </div>`;

    // Уборка и бельё
    const cleaningHtml = `<div class="flex items-center gap-1 whitespace-nowrap">
        <span class="w-3 h-3 rounded" style="background: #9ca3af;"></span>
        <span class="text-xs text-gray-600">${t('timeline_cleaning')}</span>
    </div>
    <div class="flex items-center gap-1 whitespace-nowrap">
        <span class="w-3 h-3 rounded" style="background: #06b6d4;"></span>
        <span class="text-xs text-gray-600">${t('timeline_bedding')}</span>
    </div>
    <div class="flex items-center gap-1 whitespace-nowrap">
        <span class="w-3 h-3 rounded" style="background: #22c55e;"></span>
        <span class="text-xs text-gray-600">${t('timeline_done')}</span>
    </div>`;

    // Гость без события — человечек перед именем (компактная легенда, как у остальных)
    const selfLabelRaw = t('timeline_self_guest');
    const selfLabel = selfLabelRaw === 'timeline_self_guest' ? 'Гость без события' : selfLabelRaw;
    const selfHtml = `<div class="flex items-center gap-1 whitespace-nowrap" title="Гость без события — приехал не на ретрит и не на мероприятие">
        <span class="w-3 h-3 rounded shrink-0 flex items-center justify-center" style="background: #3b82f6; color: #fff;">${SELF_ICON}</span>
        <span class="text-xs text-gray-600">${selfLabel}</span>
    </div>`;

    legend.innerHTML = categoriesHtml + selfHtml + bookingHtml + cleaningHtml;
}

// Переключение экранов
function showActionScreen() {
    document.getElementById('actionScreen').classList.remove('hidden');
    document.getElementById('checkinScreen').classList.add('hidden');
    document.getElementById('bookingScreen').classList.add('hidden');
    // Без номера (самостоятельное проживание): уборка, бельё и ремонт не нужны,
    // «Заселить» = человек уже здесь, заезд отмечается сразу
    const isSelf = !!modalContext?.isSelf;
    document.querySelectorAll('#actionScreen [data-room-only]').forEach(b => b.classList.toggle('hidden', isSelf));
    document.getElementById('actionCheckinLabel').textContent = isSelf
        ? tf('timeline_self_here', 'Уже здесь (заехал)') : t('timeline_checkin');
}

function showCheckinForm() {
    document.getElementById('actionScreen').classList.add('hidden');
    document.getElementById('checkinScreen').classList.remove('hidden');
    document.getElementById('bookingScreen').classList.add('hidden');

    // Копируем данные
    document.getElementById('checkinLocation').textContent =
        document.getElementById('modalLocation').textContent;
    document.getElementById('checkinDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('checkinDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Сбрасываем форму
    document.getElementById('checkinForm').reset();
    document.getElementById('checkinDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('checkinDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Сбрасываем выбор вайшнава
    clearVaishnavSelection();

    // «+ Добавить» в блоке «Самостоятельное проживание» — та же форма, но без номера
    const isSelf = !!modalContext.isSelf;
    document.getElementById('checkinTitle').textContent = isSelf ? selfBlockLabel(modalContext.selfKind) : t('timeline_checkin_title');
    // Из блока команды — сразу категория «Команда», её можно сменить на «Волонтёр»
    if (isSelf && modalContext.selfKind === 'team') {
        const team = categories.find(c => c.slug === 'team');
        if (team) document.getElementById('checkinCategory').value = team.id;
    }
    document.getElementById('checkinSubmit').textContent = isSelf ? tf('timeline_self_add', 'Добавить') : t('timeline_checkin');
}

// Перевод с запасным русским текстом, пока ключа нет в словаре
function tf(key, fallback) {
    const v = t(key);
    return v === key ? fallback : v;
}

function selfBlockLabel(kind = 'guests') {
    return kind === 'team'
        ? tf('timeline_self_block_team', 'Самостоятельное проживание — команда и волонтёры')
        : tf('timeline_self_block_guests', 'Самостоятельное проживание — гости');
}

// Открыть форму добавления в «Самостоятельное проживание» (живёт вне ашрама, может питаться с нами)
function openSelfStayModal(kind = 'guests') {
    if (!canEditTimeline()) return;
    modalContext = { roomId: null, isSelf: true, selfKind: kind, isConversion: false };
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const hint = tf('timeline_self_add_hint', 'без номера — живёт вне ашрама');
    document.getElementById('modalLocation').textContent = `${selfBlockLabel(kind)} (${hint})`;
    document.getElementById('modalCheckIn').value = formatDateForInput(today);
    document.getElementById('modalCheckOut').value = formatDateForInput(tomorrow);
    // Выбор, как у номера: «Уже здесь» (заезд сразу) или «Забронировать» — один человек
    // или группа местами без имён; бронь висит пунктиром, пока не отмечен заезд (ВГ, 01.10)
    showActionScreen();
    document.getElementById('actionModal').showModal();
}

// Окно проживания для записи из блока «Самостоятельное проживание»
function openSelfStay(id) {
    const res = selfStays.find(r => r.id === id && !r.fromCrm);
    if (!res) return;
    const name = (res.vaishnavas ? getVaishnavName(res.vaishnavas, '') : '') || res.guest_name || '—';
    openResidentModal({
        id: res.id, name: name !== '—' ? name : selfSeatName(res), isBooking: !res.arrived_at, rawData: res,
        hasDebt: debtorsSet.has(finKey(res)),
        hasCredit: creditorsSet.has(finKey(res))
    }, selfBlockLabel(selfKind(res)), '');
}

function showBookingForm() {
    document.getElementById('actionScreen').classList.add('hidden');
    document.getElementById('checkinScreen').classList.add('hidden');
    document.getElementById('bookingScreen').classList.remove('hidden');

    // Копируем данные
    document.getElementById('bookingLocation').textContent =
        document.getElementById('modalLocation').textContent;
    document.getElementById('bookingDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('bookingDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Сбрасываем форму
    document.getElementById('bookingForm').reset();
    document.getElementById('bookingDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('bookingDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Гость и ретрит: чистый старт на каждое открытие
    const bookingRetreatSel = document.getElementById('bookingRetreat');
    if (bookingRetreatSel) delete bookingRetreatSel.dataset.touched;
    const bookingCatSel = document.getElementById('bookingCategory');
    if (bookingCatSel) { delete bookingCatSel.dataset.touched; delete bookingCatSel.dataset.auto; }
    resetBookingRetreatAuto();
    clearBookingVaishnavSelection();
    const extraPeople = document.getElementById('bookingExtraPeople');
    if (extraPeople) extraPeople.innerHTML = '';
    delete document.getElementById('bookingForm').beds_count.dataset.manual;

    // Бронь без номера: группа местами без имён или один человек (ВГ, 01.10)
    const isSelf = !!modalContext?.isSelf;
    document.getElementById('bookingTitle').textContent = isSelf
        ? `${tf('timeline_booking_title', 'Бронирование')}: ${selfBlockLabel(modalContext.selfKind)}`
        : t('timeline_booking_title');
    document.getElementById('bookingSelfHint').classList.toggle('hidden', !isSelf);
    if (isSelf && modalContext.selfKind === 'team' && bookingCatSel) {
        const team = categories.find(c => c.slug === 'team');
        if (team) { bookingCatSel.value = team.id; bookingCatSel.dataset.touched = '1'; }
    }
    toggleBookingStaffFields();
    setBookingEditMode(false);
}

// ===== Департамент и служение в брони (ТЗ 01.10, п. 5; ВГ 02.10) =====
// Волонтёр и команда: департамент обязателен, человек обязателен — из справочника или
// вписанное имя, по которому при сохранении создаётся черновая карточка.
const STAFF_CATEGORY_SLUGS = ['team', 'volunteer'];
const isStaffCategory = id => STAFF_CATEGORY_SLUGS.includes(categories.find(c => c.id === id)?.slug);
const departmentName = id => { const d = id && departments.find(x => x.id === id); return d ? Layout.getName(d) : ''; };

function toggleBookingStaffFields() {
    const staff = isStaffCategory(document.getElementById('bookingCategory')?.value);
    document.getElementById('bookingStaffFields')?.classList.toggle('hidden', !staff);
    updateBookingNewPersonHint();
}

// Человек не выбран, но имя вписано — подсказка, что заведём черновую карточку
function updateBookingNewPersonHint() {
    const hint = document.getElementById('bookingNewPersonHint');
    if (!hint) return;
    const staff = isStaffCategory(document.getElementById('bookingCategory')?.value);
    const chosen = document.getElementById('bookingVaishnavId')?.value;
    const typed = document.getElementById('bookingVaishnavSearch')?.value.trim();
    hint.textContent = staff && !chosen && typed
        ? tf('timeline_new_person_hint', 'Нет в справочнике — при сохранении будет заведена черновая карточка «{name}»').replace('{name}', typed)
        : '';
    hint.classList.toggle('hidden', !hint.textContent);
}

// ===== Правка брони и проживания (ТЗ 01.10, п. 7) =====
// Кнопка «Изменить» в окне проживания открывает ту же форму «Бронирование» с заполненными
// полями: категория, человек, департамент и служение, даты, ретрит, прасад, примечания,
// название и контакт брони. Номер меняется кнопкой «Перенос» — там подбор свободных мест.
// У брони на несколько мест категория, ретрит, департамент и прасад меняются у всех мест,
// даты и человек — только у этого места.
function setBookingEditMode(on, isLiving) {
    document.getElementById('bookingSubmit').textContent = on ? tf('save', 'Сохранить') : t('add_booking');
    if (on) document.getElementById('bookingTitle').textContent = isLiving
        ? tf('timeline_edit_stay', 'Изменить проживание') : tf('timeline_edit_booking', 'Изменить бронь');
    document.getElementById('bookingBedsRow').classList.toggle('hidden', on);
    // При правке — только этот человек; ещё людей добавляют только в новую бронь
    document.getElementById('bookingAddPerson')?.classList.toggle('hidden', on);
    if (on) { const extra = document.getElementById('bookingExtraPeople'); if (extra) extra.innerHTML = ''; }
    if (!on) {
        document.getElementById('bookingEditGroupHint').classList.add('hidden');
        document.getElementById('bookingContactName').required = true;
    }
}

function bookingBack() {
    if (modalContext?.editResidentId) document.getElementById('actionModal').close();
    else showActionScreen();
}

async function openBookingEdit() {
    if (!currentResident || !canEditTimeline()) return;
    const res = currentResident.rawData;
    const location = document.getElementById('residentModalLocation').textContent;
    document.getElementById('residentModal').close();

    modalContext = { roomId: res.room_id, isSelf: !res.room_id, isConversion: false,
        editResidentId: res.id, editRes: res };
    showBookingForm();
    setBookingEditMode(true, !!res.arrived_at);

    const form = document.getElementById('bookingForm');
    document.getElementById('bookingLocation').textContent = location;
    const catSel = document.getElementById('bookingCategory');
    catSel.value = res.category_id || '';
    catSel.dataset.touched = '1';
    form.name.value = res.bookings?.name || '';
    form.contact_name.value = res.bookings?.contact_name || '';
    form.contact_phone.value = res.bookings?.contact_phone || res.guest_phone || '';
    form.contact_telegram.value = res.bookings?.contact_telegram || '';
    // Контакт обязателен только у брони: у проживания без брони его негде хранить
    document.getElementById('bookingContactName').required = !!res.booking_id;
    document.getElementById('bookingDateIn').value = res.check_in || '';
    document.getElementById('bookingDateOut').value = res.check_out || '';
    form.early_checkin.checked = !!res.early_checkin;
    form.late_checkout.checked = !!res.late_checkout;
    // «Не питается» (has_meals = false) — галочки сняты: иначе правка любого поля
    // молча вернула бы человека в подсчёт кухни (eating_detail не считает has_meals = false)
    form.breakfast.checked = res.has_meals !== false && res.breakfast !== false;
    form.lunch.checked = res.has_meals !== false && res.lunch !== false;
    form.notes.value = (res.booking_id ? res.bookings?.notes : res.notes) || '';

    // Ретрит — как выбран, подсказка по датам не перебивает
    const retreatSel = document.getElementById('bookingRetreat');
    retreatSel.dataset.touched = '1';
    fillBookingRetreatSelect(res.retreat_id || '');

    if (res.vaishnava_id) {
        if (!vaishnavas.some(v => v.id === res.vaishnava_id) && res.vaishnavas) {
            vaishnavas.push({ id: res.vaishnava_id, ...res.vaishnavas });
        }
        selectBookingVaishnava(res.vaishnava_id);
    } else {
        document.getElementById('bookingVaishnavSearch').value = res.guest_name || '';
    }
    document.getElementById('bookingDepartment').value = res.department_id || '';
    document.getElementById('bookingService').value = res.vaishnavas?.service || '';
    toggleBookingStaffFields();

    // Бронь на несколько мест — подсказка, что меняется у всех
    const hint = document.getElementById('bookingEditGroupHint');
    hint.classList.add('hidden');
    if (res.booking_id) {
        const { count } = await Layout.db.from('residents').select('id', { count: 'exact', head: true })
            .eq('booking_id', res.booking_id).neq('status', 'cancelled');
        modalContext.bookingPlaces = count || 1;
        if (count > 1) {
            hint.textContent = tf('timeline_edit_group_hint', 'В брони {n} мест: категория, ретрит, департамент и прасад изменятся у всех мест, даты и человек — только у этого места.').replace('{n}', count);
            hint.classList.remove('hidden');
        }
    }
    document.getElementById('actionModal').showModal();
}

async function saveBookingEdit(form) {
    const res = modalContext.editRes;
    const checkIn = form.check_in.value;
    const checkOut = form.check_out.value || null;
    if (!checkIn) { Layout.showNotification(t('specify_checkin_date'), 'error'); return; }
    if (checkOut && checkOut < checkIn) {
        Layout.showNotification(tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда'), 'error');
        return;
    }
    const categoryId = form.category_id.value || null;
    const retreatId = form.retreat_id?.value || null;
    if (retreatDatesMismatch(retreatId, checkIn, checkOut)) {
        Layout.showNotification(retreatDatesMismatchText(), 'warning');
    }
    const staff = isStaffCategory(categoryId);
    const departmentId = staff ? (form.department_id?.value || null) : (res.department_id || null);
    const service = staff ? (form.service?.value.trim() || null) : null;
    if (staff && !departmentId) {
        Layout.showNotification(tf('timeline_department_required', 'Выберите департамент: у волонтёра и команды он обязателен'), 'error');
        return;
    }
    let vaishnavaId = form.vaishnava_id?.value || null;
    const typedName = document.getElementById('bookingVaishnavSearch')?.value.trim() || '';
    if (staff && !vaishnavaId && !typedName) {
        Layout.showNotification(tf('timeline_person_required', 'Укажите человека: выберите из справочника или впишите имя — заведём черновую карточку'), 'error');
        return;
    }

    // Новые даты — хватает ли мест в номере (пересекающиеся проживания против вместимости)
    if (res.room_id && (checkIn !== res.check_in || checkOut !== (res.check_out || null))) {
        const room = timelineData.buildings.flatMap(b => b.rooms || []).find(r => r.id === res.room_id);
        let q = Layout.db.from('residents').select('id', { count: 'exact', head: true })
            .eq('room_id', res.room_id).eq('status', 'confirmed').neq('id', res.id)
            .or(`check_out.is.null,check_out.gt.${checkIn}`);
        if (checkOut) q = q.lt('check_in', checkOut);
        const { count } = await q;
        if (room?.capacity && count >= room.capacity && !confirm(
            tf('timeline_edit_room_full', 'В номере {cap} мест, а в эти даты уже живут или забронированы {n}. Сохранить всё равно?')
                .replace('{cap}', room.capacity).replace('{n}', count))) return;
    }

    if (staff) {
        vaishnavaId = await ensureStaffPerson(vaishnavaId, typedName, service, categoryId);
        if (!vaishnavaId) return;
    }
    const breakfast = form.breakfast.checked;
    const lunch = form.lunch.checked;

    const place = {
        vaishnava_id: vaishnavaId,
        // Имя без карточки — у гостя без справочника; у брони имя берётся из названия брони
        guest_name: vaishnavaId ? null : (typedName || null),
        category_id: categoryId,
        retreat_id: retreatId,
        department_id: departmentId,
        check_in: checkIn,
        check_out: checkOut,
        early_checkin: form.early_checkin.checked,
        late_checkout: form.late_checkout.checked,
        breakfast,
        lunch,
        // Правят осознанно — «питается?» больше не «не указано» (случай Ананды Вардханы Свами, 02.10)
        has_meals: breakfast || lunch
    };
    if (!res.booking_id) place.notes = form.notes.value.trim() || null;
    if (!res.booking_id && form.contact_phone.value.trim()) place.guest_phone = form.contact_phone.value.trim();

    const { error } = await Layout.db.from('residents').update(place).eq('id', res.id);
    if (error) { Layout.handleError(error, tf('timeline_edit_booking', 'Изменить бронь')); return; }

    if (res.booking_id) {
        // Общее для брони — у остальных её мест
        if ((modalContext.bookingPlaces || 1) > 1) {
            const { error: grpError } = await Layout.db.from('residents')
                .update({ category_id: categoryId, retreat_id: retreatId, department_id: departmentId, breakfast, lunch })
                .eq('booking_id', res.booking_id).neq('id', res.id).neq('status', 'cancelled');
            if (grpError) Layout.handleError(grpError, tf('timeline_edit_booking', 'Изменить бронь'));
        }
        // Даты брони пересчитает база по местам (миграции 583/584)
        const { error: bError } = await Layout.db.from('bookings').update({
            name: form.name.value.trim() || null,
            contact_name: form.contact_name.value.trim() || null,
            contact_phone: form.contact_phone.value.trim() || null,
            contact_telegram: form.contact_telegram.value.trim() || null,
            notes: form.notes.value.trim() || null,
            retreat_id: retreatId
        }).eq('id', res.booking_id);
        if (bError) Layout.handleError(bError, tf('timeline_edit_booking', 'Изменить бронь'));
    }

    await offerRetreatOnAdjacent(vaishnavaId, checkIn, checkOut, retreatId);
    warnOutsideRetreat(retreatId, checkIn, checkOut);
    Layout.showNotification(tf('timeline_edit_saved', 'Изменения сохранены'), 'success');
    document.getElementById('actionModal').close();
    showActionScreen();
    await loadTimelineData();
    renderTable();
}

// ===== Поиск вайшнавов =====
function searchVaishnavas(query) {
    const suggestionsEl = document.getElementById('vaishnavaSuggestions');
    if (!query || query.length < 2) {
        suggestionsEl.classList.add('hidden');
        return;
    }

    const q = query.toLowerCase();
    const matches = vaishnavas.filter(v => {
        const name = getVaishnavName(v).toLowerCase();
        const phone = (v.phone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
        suggestionsEl.innerHTML = `<div class="p-3 text-gray-500 text-sm">${t('timeline_not_found')}</div>`;
    } else {
        suggestionsEl.innerHTML = matches.map(v => {
            const name = getVaishnavName(v);
            const badge = v.is_team_member ? `<span class="badge badge-sm badge-primary ml-2">${t('timeline_team')}</span>` : '';
            return `<div class="p-2 hover:bg-base-200 cursor-pointer flex items-center" data-action="select-vaishnava" data-id="${v.id}">
                <span>${e(name)}</span>${badge}
            </div>`;
        }).join('');
    }
    suggestionsEl.classList.remove('hidden');
}

function showVaishnavaSuggestions() {
    const query = document.getElementById('checkinVaishnavSearch').value;
    if (query.length >= 2) {
        searchVaishnavas(query);
    }
}

function selectVaishnava(id) {
    const v = vaishnavas.find(v => v.id === id);
    const name = v ? getVaishnavName(v) : '';
    document.getElementById('checkinVaishnavId').value = id;
    document.getElementById('checkinVaishnavSearch').value = name;
    document.getElementById('vaishnavaSuggestions').classList.add('hidden');
    document.getElementById('clearVaishnava').classList.remove('hidden');
    // Скрываем поля нового гостя
    document.getElementById('guestFields').classList.add('hidden');
    document.getElementById('checkinGuestName').value = '';
    suggestRetreat();
}

// ==================== РЕТРИТ ПРИ ЗАСЕЛЕНИИ ====================
// Раньше шахматка вообще не связывала гостя с ретритом — отсюда 45 записей,
// где человек живёт, а система не знает, что он участник: ни долг при выезде
// не проверить, ни расселение. Теперь подставляем сами, но оставляем на выбор:
// кто-то приезжает до ретрита, а кто-то живёт в его даты волонтёром.
// Список для заселения и брони: наши ретриты и сторонние мероприятия — двумя разделами.
// Только те, что идут в даты проживания, и с датами в скобках: «Сева-ретрит» 2026 и 2027
// иначе не различить. Уже выбранный остаётся в списке, даже если даты разошлись, —
// тогда под полем предупреждение (retreatDatesMismatch), но сохранить можно.
// Конец нашего ретрита — fact_end (ВГ 01.10.2026): внутренний (художники) идёт, пока живут
// его люди — до выезда последнего; обычный — не дольше конца + 3 дня (вариант 2).
// Прошёл — ретрит больше не предлагается, но не закрывается: он в «Архиве».
// Правило списка и «Архив / все ретриты…» — общие, в js/retreat-select.js (ВГ 08.10.2026)
const retreatFitsDates = (r, from, to) => RetreatSelect.fits(r, from, to);

function retreatIdFits(id, from, to) {
    const r = allRetreats.find(x => x.id === id);
    return !!r && retreatFitsDates(r, from, to);
}

function retreatSelectHtml(selectedId, from, to, opts = {}) {
    return RetreatSelect.html(allRetreats, selectedId, from, to, opts);
}
RetreatSelect.setSource(() => allRetreats);

// Мягкое предупреждение под полем (ТЗ 01.10, п. 4): даты брони не попадают в ретрит.
// Сохранение не блокирует — выбрать прошедший ретрит из архива можно осознанно.
function showRetreatWarn(prefix) {
    const sel = document.getElementById(prefix + 'Retreat');
    const warn = document.getElementById(prefix + 'RetreatWarn');
    if (!sel || !warn) return;
    const from = document.getElementById(prefix + 'DateIn').value;
    const to = document.getElementById(prefix + 'DateOut').value || from;
    const bad = retreatDatesMismatch(sel.value, from, to);
    warn.textContent = bad ? retreatDatesMismatchText() : '';
    warn.classList.toggle('hidden', !bad);
}

// Пока кэш переводов у пользователя не обновился, показываем русский текст, а не имя ключа
function retreatDatesMismatchText() {
    const v = Layout.t('retreat_dates_mismatch');
    return v === 'retreat_dates_mismatch' ? 'Даты не пересекаются с датами выбранного ретрита' : v;
}

// Переезд встык (решение ВГ 25.09, случай Гокула-рани): у соседней брони того же человека,
// которая кончается в день заезда (или накануне) либо начинается в день выезда (или назавтра),
// другой ретрит или его нет — предложить поставить тот же. Молча не переносим:
// бывает законно (остался с фестиваля на следующий ретрит).
async function offerRetreatOnAdjacent(vaishnavaId, checkIn, checkOut, retreatId) {
    if (!vaishnavaId || !retreatId || !checkIn) return;
    const shift = (d, n) => { const x = DateUtils.parseDate(d); x.setDate(x.getDate() + n); return DateUtils.toISO(x); };
    const { data, error } = await Layout.db.from('residents')
        .select('id, check_in, check_out, retreat_id')
        .eq('vaishnava_id', vaishnavaId)
        .in('status', ['confirmed', 'checked_out']);
    if (error) { console.error('adjacent residents:', error); return; }
    const out = checkOut || checkIn;
    const adjacent = (data || []).filter(r => r.retreat_id !== retreatId && (
        (r.check_in < checkIn && r.check_out && r.check_out >= shift(checkIn, -1) && r.check_out <= checkIn) ||
        (r.check_in > out && r.check_in <= shift(out, 1))));
    if (!adjacent.length) return;
    const retreatLabel = id => { const r = allRetreats.find(x => x.id === id); return r ? Layout.getName(r) : '—'; };
    const noRetreat = Layout.t('timeline_adjacent_no_retreat') === 'timeline_adjacent_no_retreat' ? 'без ретрита' : Layout.t('timeline_adjacent_no_retreat');
    const q = Layout.t('timeline_adjacent_retreat_q');
    for (const r of adjacent) {
        const range = DateUtils.formatRangeShort(r.check_in, r.check_out || r.check_in);
        const cur = r.retreat_id ? `«${retreatLabel(r.retreat_id)}»` : noRetreat;
        const text = (q === 'timeline_adjacent_retreat_q'
            ? 'Соседняя бронь этого человека встык ({range}) — {cur}. Поставить и на неё «{retreat}»?'
            : q).replace('{range}', range).replace('{cur}', cur).replace('{retreat}', retreatLabel(retreatId));
        if (!confirm(text)) continue;
        const { error: upErr } = await Layout.db.from('residents').update({ retreat_id: retreatId }).eq('id', r.id);
        if (upErr) Layout.handleError(upErr, Layout.t('nav_retreats') || 'Ретрит');
    }
}

function retreatDatesMismatch(retreatId, from, to) {
    const r = retreatId && allRetreats.find(x => x.id === retreatId);
    return !!r && !retreatFitsDates(r, from, to);
}

// Вариант 2 (ВГ, 01.10.2026): пара дней до/после ретрита — осознанно часть ретрита;
// больше OUTSIDE_RETREAT_DAYS — подсказка вынести хвост в «Гости без события». Не запрет.
const OUTSIDE_RETREAT_DAYS = 3;
function outsideRetreat(retreatId, from, to) {
    const r = retreatId && allRetreats.find(x => x.id === retreatId);
    // Внутренний ретрит (художники) идёт, пока живут его люди, — хвост не выносим (ВГ 01.10)
    if (!r || !from || r.is_internal) return null;
    const днейМежду = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / 86400000);
    const before = Math.max(0, днейМежду(from, r.start_date));
    const after = to ? Math.max(0, днейМежду(r.end_date, to)) : 0;
    if (before <= OUTSIDE_RETREAT_DAYS && after <= OUTSIDE_RETREAT_DAYS) return null;
    return { retreat: r, before: before > OUTSIDE_RETREAT_DAYS ? before : 0, after: after > OUTSIDE_RETREAT_DAYS ? after : 0 };
}
function outsideRetreatText(o) {
    const части = [o.before ? `${o.before} ${tf('timeline_days_before', 'дн. до')}` : '', o.after ? `${o.after} ${tf('timeline_days_after', 'дн. после')}` : ''].filter(Boolean);
    return `${Layout.getName(o.retreat)}: ${части.join(', ')} — ${tf('timeline_outside_retreat_hint', 'вне дат ретрита. Вынести в «Гости без события»? Кнопка «Разделить» в окне проживания')}`;
}
// «✕» на подсказке — больше не показывать для этого проживания (только в этом браузере)
function outsideDismissed(id) { try { return localStorage.getItem('outsideRetreatOk_' + id) === '1'; } catch { return false; } }
function dismissOutside(id) { try { localStorage.setItem('outsideRetreatOk_' + id, '1'); } catch { /* приватный режим */ } }
function warnOutsideRetreat(retreatId, from, to) {
    const o = outsideRetreat(retreatId, from, to);
    if (o) Layout.showNotification(outsideRetreatText(o), 'warning');
}

// «Разделить»: часть до начала / после конца ретрита — отдельной записью «Гость» без ретрита.
// Шов кухни: в день разреза одна запись даёт завтрак (выезд без позднего), другая — обед
// (заезд без раннего) — порция ровно одна, как было.
async function splitOffRetreat(side) {
    if (!currentResident || !canEditTimeline()) return;
    const res = currentResident.rawData;
    const o = outsideRetreat(res.retreat_id, res.check_in, res.check_out);
    if (!o) return;
    const cut = side === 'before' ? o.retreat.start_date : o.retreat.end_date;
    const span = side === 'before' ? [res.check_in, cut] : [cut, res.check_out];
    const q = tf('timeline_split_confirm', 'Вынести {dates} в «Гости без события»? Ретрит останется на своих датах, хвост станет отдельным визитом — его начисление и оплата в Финансах.');
    if (!confirm(q.replace('{dates}', DateUtils.formatRange(span[0], span[1])))) return;
    const { data: row, error: rErr } = await Layout.db.from('residents').select('*').eq('id', res.id).single();
    if (rErr) { Layout.handleError(rErr, 'Разделить'); return; }
    const { id, created_at, updated_at, ...copy } = row;
    const piece = { ...copy, retreat_id: null, category_id: GUEST_CATEGORY_ID, booking_id: null,
        cleaning_done: false, cleaning_skipped: false, check_in: span[0], check_out: span[1] };
    const keep = {};
    if (side === 'before') {
        piece.late_checkout = false;
        keep.check_in = cut; keep.early_checkin = false;
    } else {
        piece.early_checkin = false;
        keep.check_out = cut; keep.late_checkout = false;
    }
    const { error: insErr } = await Layout.db.from('residents').insert(piece);
    if (insErr) { Layout.handleError(insErr, 'Разделить'); return; }
    const { error: upErr } = await Layout.db.from('residents').update(keep).eq('id', res.id);
    if (upErr) { Layout.handleError(upErr, 'Разделить'); return; }
    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

function fillRetreatSelect(selectedId) {
    const sel = document.getElementById('checkinRetreat');
    if (sel) sel.innerHTML = retreatSelectHtml(selectedId,
        document.getElementById('checkinDateIn').value, document.getElementById('checkinDateOut').value);
    showRetreatWarn('checkin');
}

// Подсказать ретрит по человеку и датам: берём регистрацию, чей ретрит
// пересекается с проживанием. Если подходит несколько — не выбираем за
// человека, показываем подсказку.
async function suggestRetreat() {
    const hint = document.getElementById('checkinRetreatHint');
    const sel = document.getElementById('checkinRetreat');
    if (!sel || !hint) return;
    // казначей выбрал сам — не перебиваем, но список под новые даты обновляем
    if (sel.dataset.touched === '1') { fillRetreatSelect(sel.value); return; }

    const vId = document.getElementById('checkinVaishnavId').value;
    const from = document.getElementById('checkinDateIn').value;
    const to = document.getElementById('checkinDateOut').value || from;
    hint.textContent = '';
    if (!vId || !from) { fillRetreatSelect(''); return; }

    const { data } = await Layout.db
        .from('retreat_registrations')
        .select('retreat_id')
        .eq('vaishnava_id', vId)
        .eq('is_deleted', false)
        .not('status', 'in', '("cancelled","rejected")');

    const fits = (data || []).filter(r => retreatIdFits(r.retreat_id, from, to));

    if (fits.length === 1) {
        fillRetreatSelect(fits[0].retreat_id);
        hint.textContent = Layout.t('timeline_retreat_auto') || 'подставлено по регистрации';
    } else if (fits.length > 1) {
        fillRetreatSelect('');
        hint.textContent = Layout.t('timeline_retreat_many') || 'подходит несколько — выберите';
    } else {
        fillRetreatSelect('');
    }
}

// ===== Гость из справочника в форме бронирования =====
// Не обязателен (безымянная бронь — норма), но если выбран — бронь сразу
// привязана к человеку: заработают долг, питание и «без места».
function searchBookingVaishnavas(query) {
    const suggestionsEl = document.getElementById('bookingVaishnavaSuggestions');
    if (!query || query.length < 2) {
        suggestionsEl.classList.add('hidden');
        return;
    }
    const q = query.toLowerCase();
    const matches = vaishnavas.filter(v => {
        const name = getVaishnavName(v).toLowerCase();
        const phone = (v.phone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
        suggestionsEl.innerHTML = `<div class="p-3 text-gray-500 text-sm">${t('timeline_not_found')}</div>`;
    } else {
        suggestionsEl.innerHTML = matches.map(v =>
            `<div class="p-2 hover:bg-base-200 cursor-pointer" data-action="select-booking-vaishnava" data-id="${v.id}">${e(getVaishnavName(v))}</div>`
        ).join('');
    }
    suggestionsEl.classList.remove('hidden');
}

function selectBookingVaishnava(id) {
    const v = vaishnavas.find(v => v.id === id);
    const name = v ? getVaishnavName(v) : '';
    document.getElementById('bookingVaishnavId').value = id;
    document.getElementById('bookingVaishnavSearch').value = name;
    document.getElementById('bookingVaishnavaSuggestions').classList.add('hidden');
    document.getElementById('clearBookingVaishnava').classList.remove('hidden');
    // Контакт по умолчанию — сам гость
    const form = document.getElementById('bookingForm');
    if (form && !form.contact_name.value.trim()) form.contact_name.value = name;
    updateBookingNewPersonHint();
    suggestBookingRetreat();
    suggestBookingCategory(id);
}

// Категория по статусу регистрации гостя (команда / волонтёр / важный гость),
// как при заселении из «Предварительной». Выбранную вручную не перебиваем.
const BOOKING_STATUS_CATEGORY = {
    team: '10c4c929-6aaf-4b73-a15a-b7c5ab70f64b',
    volunteer: 'cdb7a43e-51a8-47cd-ac97-c6fdf4fccd5e',
    vip: 'ab57efc9-504a-4a31-93e6-6de8daa46bb7'
};

async function suggestBookingCategory(vaishnavaId) {
    const sel = document.getElementById('bookingCategory');
    const hint = document.getElementById('bookingCategoryHint');
    if (!sel || sel.dataset.touched === '1') return;
    sel.value = '';
    if (hint) hint.textContent = '';
    toggleBookingStaffFields();
    if (!vaishnavaId) return;

    const from = document.getElementById('bookingDateIn').value;
    const to = document.getElementById('bookingDateOut').value || from;
    const { data } = await Layout.db
        .from('retreat_registrations')
        .select('status, retreat_id')
        .eq('vaishnava_id', vaishnavaId)
        .eq('is_deleted', false)
        .not('status', 'in', '("cancelled","rejected")');
    const fits = (data || []).filter(r => retreatIdFits(r.retreat_id, from, to));
    let catId = fits.length ? BOOKING_STATUS_CATEGORY[fits[0].status] : null;
    let hintText = Layout.t('timeline_retreat_auto') || 'подставлено по регистрации';
    // Регистрации нет — по статусу человека в карточке (волонтёр / команда). Категорию
    // можно поменять, статус в карточке от этого не меняется (ВГ 02.10)
    if (!catId) {
        const status = vaishnavas.find(v => v.id === vaishnavaId)?.status;
        catId = BOOKING_STATUS_CATEGORY[status] || null;
        hintText = tf('timeline_category_by_status', 'по статусу в карточке');
    }
    if (catId && sel.querySelector(`option[value="${catId}"]`)) {
        sel.value = catId;
        if (hint) hint.textContent = hintText;
    }
    toggleBookingStaffFields();
}

function clearBookingVaishnavSelection() {
    // Элементов может не быть, пока браузер держит старый HTML (кэш 10 мин)
    const idEl = document.getElementById('bookingVaishnavId');
    const searchEl = document.getElementById('bookingVaishnavSearch');
    const clearBtn = document.getElementById('clearBookingVaishnava');
    if (idEl) idEl.value = '';
    if (searchEl) searchEl.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    const sel = document.getElementById('bookingRetreat');
    if (sel) delete sel.dataset.touched;
    suggestBookingRetreat();
    const catSel = document.getElementById('bookingCategory');
    if (catSel) delete catSel.dataset.touched;
    suggestBookingCategory(null);
    updateBookingNewPersonHint();
}

document.getElementById('bookingVaishnavaSuggestions')?.addEventListener('click', ev => {
    const el = ev.target.closest('[data-action="select-booking-vaishnava"]');
    if (el) selectBookingVaishnava(el.dataset.id);
});

// ===== Несколько человек в одной брони (ВГ 02.10) =====
// Под первым «Вайшнавом» — «+ ещё человек»: каждое имя занимает своё место брони,
// число мест подтягивается под число людей. Из справочника — поиском, нет там — просто имя.
// У каждого добавленного свои заезд и выезд (ВГ 08.10): сначала общие даты брони,
// правят только тому, кто едет иначе. Первый человек и безымянные места — по общим датам.
function addBookingPersonRow() {
    const box = document.getElementById('bookingExtraPeople');
    if (!box) return;
    const form = document.getElementById('bookingForm');
    const row = document.createElement('div');
    row.className = 'mt-2';
    row.dataset.personRow = '1';
    row.innerHTML = `<div class="relative flex gap-1">
            <input type="hidden" data-role="id" />
            <input type="text" data-role="name" class="input input-bordered input-sm w-full" autocomplete="off"
                   placeholder="${e(tf('timeline_search_by_name', 'Поиск по имени...'))}" />
            <button type="button" class="btn btn-ghost btn-xs self-center" data-action="remove-booking-person">✕</button>
            <div data-role="suggestions" class="hidden absolute z-50 top-full left-0 right-8 bg-base-100 shadow-lg rounded-lg mt-1 max-h-48 overflow-y-auto border"></div>
        </div>
        <div class="flex items-center gap-1 mt-1 pr-8 text-xs opacity-80">
            <span>${e(tf('check_in', 'Заезд'))}</span>
            <input type="date" data-role="in" class="input input-bordered input-xs flex-1 min-w-0" value="${e(form.check_in.value)}" />
            <span>${e(tf('check_out', 'Выезд'))}</span>
            <input type="date" data-role="out" class="input input-bordered input-xs flex-1 min-w-0" value="${e(form.check_out.value)}" />
        </div>`;
    box.appendChild(row);
    syncBookingBeds();
    row.querySelector('[data-role="name"]').focus();
}

// Общие даты сменили — у строк, где даты не правили руками, они идут следом
function syncBookingPersonDates() {
    const form = document.getElementById('bookingForm');
    document.querySelectorAll('#bookingExtraPeople [data-person-row]').forEach(row => {
        const din = row.querySelector('[data-role="in"]'), dout = row.querySelector('[data-role="out"]');
        if (din.dataset.manual !== '1') din.value = form.check_in.value;
        if (dout.dataset.manual !== '1') dout.value = form.check_out.value;
    });
}
document.getElementById('bookingDateIn')?.addEventListener('change', syncBookingPersonDates);
document.getElementById('bookingDateOut')?.addEventListener('change', syncBookingPersonDates);

// Мест не меньше, чем людей; больше — если вписали вручную (едут ещё безымянные)
function syncBookingBeds() {
    const beds = document.getElementById('bookingForm').beds_count;
    const people = 1 + document.querySelectorAll('#bookingExtraPeople [data-person-row]').length;
    beds.value = Math.max(parseInt(beds.dataset.manual) || 1, people);
}

// Люди брони по порядку мест: первый — из поля «Вайшнав», дальше — добавленные строки
function bookingPeople() {
    const form = document.getElementById('bookingForm');
    const people = [{
        id: document.getElementById('bookingVaishnavId')?.value || null,
        name: document.getElementById('bookingVaishnavSearch')?.value.trim() || ''
    }];
    document.querySelectorAll('#bookingExtraPeople [data-person-row]').forEach(row => {
        const id = row.querySelector('[data-role="id"]').value || null;
        const name = row.querySelector('[data-role="name"]').value.trim();
        const check_in = row.querySelector('[data-role="in"]').value || null;
        const check_out = row.querySelector('[data-role="out"]').value || null;
        // Безымянное место тоже берём, если у него свои даты
        const ownDates = check_in !== form.check_in.value || check_out !== form.check_out.value;
        if (id || name || ownDates) people.push({ id, name, check_in, check_out });
    });
    return people;
}

{
    const box = document.getElementById('bookingExtraPeople');
    box?.addEventListener('change', ev => {
        if (['in', 'out'].includes(ev.target.dataset.role)) ev.target.dataset.manual = '1';
    });
    box?.addEventListener('input', ev => {
        const row = ev.target.closest('[data-person-row]');
        if (!row || ev.target.dataset.role !== 'name') return;
        row.querySelector('[data-role="id"]').value = '';
        const sug = row.querySelector('[data-role="suggestions"]');
        const q = ev.target.value.trim().toLowerCase();
        if (q.length < 2) { sug.classList.add('hidden'); return; }
        const matches = vaishnavas.filter(v =>
            getVaishnavName(v).toLowerCase().includes(q) || (v.phone || '').toLowerCase().includes(q)).slice(0, 10);
        sug.innerHTML = matches.length
            ? matches.map(v => `<div class="p-2 hover:bg-base-200 cursor-pointer" data-action="select-booking-person" data-id="${v.id}">${e(getVaishnavName(v))}</div>`).join('')
            : `<div class="p-3 text-gray-500 text-sm">${e(tf('timeline_not_found_new_name', 'Нет в справочнике — сохраним просто имя'))}</div>`;
        sug.classList.remove('hidden');
    });
    box?.addEventListener('click', ev => {
        const row = ev.target.closest('[data-person-row]');
        if (!row) return;
        if (ev.target.closest('[data-action="remove-booking-person"]')) { row.remove(); syncBookingBeds(); return; }
        const pick = ev.target.closest('[data-action="select-booking-person"]');
        if (pick) {
            const v = vaishnavas.find(x => x.id === pick.dataset.id);
            row.querySelector('[data-role="id"]').value = pick.dataset.id;
            row.querySelector('[data-role="name"]').value = v ? getVaishnavName(v) : '';
            row.querySelector('[data-role="suggestions"]').classList.add('hidden');
        }
    });
    document.addEventListener('click', ev => {
        document.querySelectorAll('#bookingExtraPeople [data-person-row]').forEach(row => {
            if (!row.contains(ev.target)) row.querySelector('[data-role="suggestions"]').classList.add('hidden');
        });
    });
}

// Ретрит в форме бронирования: если выбран человек — сначала пробуем его
// регистрации (как при заселении), иначе подсказываем по пересечению дат.
async function suggestBookingRetreat() {
    const sel = document.getElementById('bookingRetreat');
    const hint = document.getElementById('bookingRetreatHint');
    if (!sel || !hint) return;
    // выбрали сами — не перебиваем, но список под новые даты обновляем
    if (sel.dataset.touched === '1') { fillBookingRetreatSelect(sel.value); return; }

    const from = document.getElementById('bookingDateIn').value;
    const to = document.getElementById('bookingDateOut').value || from;
    hint.textContent = '';

    const vId = document.getElementById('bookingVaishnavId')?.value;
    if (vId && from) {
        const { data } = await Layout.db
            .from('retreat_registrations')
            .select('retreat_id')
            .eq('vaishnava_id', vId)
            .eq('is_deleted', false)
            .not('status', 'in', '("cancelled","rejected")');
        const regFits = (data || []).filter(r => retreatIdFits(r.retreat_id, from, to));
        if (regFits.length === 1) {
            fillBookingRetreatSelect(regFits[0].retreat_id);
            hint.textContent = Layout.t('timeline_retreat_auto') || 'подставлено по регистрации';
            return;
        }
    }

    const fits = from
        ? allRetreats.filter(r => retreatFitsDates(r, from, to))
        : [];

    if (fits.length === 1) {
        fillBookingRetreatSelect(fits[0].id);
        hint.textContent = Layout.t('timeline_retreat_by_dates') || 'подставлено по датам';
    } else if (fits.length > 1) {
        fillBookingRetreatSelect('');
        hint.textContent = Layout.t('timeline_retreat_many') || 'подходит несколько — выберите';
    } else {
        fillBookingRetreatSelect('');
    }
}

function fillBookingRetreatSelect(selectedId) {
    const sel = document.getElementById('bookingRetreat');
    if (sel) sel.innerHTML = retreatSelectHtml(selectedId,
        document.getElementById('bookingDateIn').value, document.getElementById('bookingDateOut').value);
    showRetreatWarn('booking');
    applyBookingRetreat();
}

// ===== Ретрит подставляет остальное (ВГ 08.10) =====
// Стороннее мероприятие — это группа: категория «Группа», название брони — имя группы.
// Контактное лицо — из ретрита (имя, телефон, телеграм из карточки). Есть у группы
// «Разовое питание по дням» — кухня считает по нему, галочек прасада у мест нет.
// Вписанное руками не перебиваем; при правке брони ничего не подставляем.
function resetBookingRetreatAuto() {
    const form = document.getElementById('bookingForm');
    delete form.name.dataset.manual;
    delete form.contact_name.dataset.auto;
    document.getElementById('bookingContactId').value = '';
    document.getElementById('bookingContactSuggestions').classList.add('hidden');
    setBookingPrasadByGroup(null);
}

async function applyBookingRetreat() {
    if (modalContext?.editResidentId) return;
    const form = document.getElementById('bookingForm');
    const retreatId = form.retreat_id.value;
    const r = allRetreats.find(x => x.id === retreatId);

    const catSel = document.getElementById('bookingCategory');
    const group = categories.find(c => c.slug === 'group');
    if (group && catSel.dataset.touched !== '1') {
        if (r?.is_external) { catSel.value = group.id; catSel.dataset.auto = '1'; }
        else if (catSel.dataset.auto === '1') { catSel.value = ''; delete catSel.dataset.auto; }
        toggleBookingStaffFields();
    }

    if (form.name.dataset.manual !== '1') form.name.value = r?.is_external ? Layout.getName(r) : '';

    if (!form.contact_name.value.trim() || form.contact_name.dataset.auto === '1') {
        const v = r?.contact_vaishnava_id && vaishnavas.find(x => x.id === r.contact_vaishnava_id);
        setBookingContact(v || null);
        if (v) form.contact_name.dataset.auto = '1';
    }

    let mealGroup = null;
    if (r) {
        const from = form.check_in.value, to = form.check_out.value || from;
        const { data } = await Layout.db.from('meal_groups').select('id, name')
            .eq('retreat_id', r.id).eq('by_day', true).lte('start_date', to).gte('end_date', from).limit(1);
        mealGroup = data?.[0] || null;
    }
    if (form.retreat_id.value === retreatId) setBookingPrasadByGroup(mealGroup);
}

function setBookingPrasadByGroup(mealGroup) {
    const form = document.getElementById('bookingForm');
    const checks = document.getElementById('bookingPrasadChecks');
    const note = document.getElementById('bookingPrasadByGroup');
    // Ушли с группы «по дням» — галочки возвращаем
    if (!mealGroup && checks.dataset.byGroup === '1') form.breakfast.checked = form.lunch.checked = true;
    if (mealGroup) form.breakfast.checked = form.lunch.checked = false;
    checks.dataset.byGroup = mealGroup ? '1' : '';
    checks.classList.toggle('hidden', !!mealGroup);
    note.classList.toggle('hidden', !mealGroup);
    note.innerHTML = mealGroup
        ? `Питание отдельно от проживания: кухня считает по заявке «${e(mealGroup.name)}» в <a class="link link-primary" href="../vaishnavas/groups.html" target="_blank">Разовом питании</a>. Лишний едок — добавьте его в числа заявки.`
        : '';
}

// Контактное лицо: из справочника — телефон и телеграм из карточки; иначе просто имя
function setBookingContact(v) {
    const form = document.getElementById('bookingForm');
    document.getElementById('bookingContactId').value = v?.id || '';
    form.contact_name.value = v ? getVaishnavName(v) : '';
    form.contact_phone.value = v?.phone || '';
    form.contact_telegram.value = v ? (v.telegram || v.telegram_username || '') : '';
    delete form.contact_name.dataset.auto;
}

function searchBookingContact(q) {
    const form = document.getElementById('bookingForm');
    delete form.contact_name.dataset.auto;
    document.getElementById('bookingContactId').value = '';
    const box = document.getElementById('bookingContactSuggestions');
    q = q.trim().toLowerCase();
    if (q.length < 2) { box.classList.add('hidden'); return; }
    const found = vaishnavas.filter(v => getVaishnavName(v).toLowerCase().includes(q)).slice(0, 10);
    if (!found.length) { box.classList.add('hidden'); return; }
    box.innerHTML = found.map(v => `<div class="p-2 hover:bg-base-200 cursor-pointer" data-contact-id="${v.id}">${e(getVaishnavName(v))}</div>`).join('');
    box.classList.remove('hidden');
}

document.getElementById('bookingContactSuggestions')?.addEventListener('click', ev => {
    const el = ev.target.closest('[data-contact-id]');
    if (!el) return;
    setBookingContact(vaishnavas.find(v => v.id === el.dataset.contactId));
    document.getElementById('bookingContactSuggestions').classList.add('hidden');
});
document.addEventListener('click', ev => {
    const box = document.getElementById('bookingContactSuggestions');
    if (box && !box.contains(ev.target) && ev.target.id !== 'bookingContactName') box.classList.add('hidden');
});

// Контакт выбран из справочника, а у группы контакта ещё нет — предложить запомнить
async function offerRetreatContact(retreatId, contactId) {
    const r = allRetreats.find(x => x.id === retreatId);
    if (!r?.is_external || !contactId || r.contact_vaishnava_id) return;
    const v = vaishnavas.find(x => x.id === contactId);
    if (!v || !confirm(`Запомнить ${getVaishnavName(v)} как контактное лицо группы «${Layout.getName(r)}»? В следующей брони подставится само.`)) return;
    const { error } = await Layout.db.from('retreats').update({ contact_vaishnava_id: contactId }).eq('id', retreatId);
    if (error) { Layout.handleError(error, 'Контактное лицо группы'); return; }
    r.contact_vaishnava_id = contactId;
}

function clearVaishnavSelection() {
    document.getElementById('checkinVaishnavId').value = '';
    document.getElementById('checkinVaishnavSearch').value = '';
    document.getElementById('clearVaishnava').classList.add('hidden');
    // Показываем поля нового гостя
    document.getElementById('guestFields').classList.remove('hidden');
    const sel = document.getElementById('checkinRetreat');
    // Заселение по брони с ретритом — ретрит брони не сбрасываем при смене человека
    if (sel && !(modalContext?.isConversion && modalContext.bookingRetreatId)) delete sel.dataset.touched;
    suggestRetreat();
}

// Закрытие подсказок при клике вне
document.addEventListener('click', (e) => {
    const suggestions = document.getElementById('vaishnavaSuggestions');
    const searchInput = document.getElementById('checkinVaishnavSearch');
    if (suggestions && !suggestions.contains(e.target) && e.target !== searchInput) {
        suggestions.classList.add('hidden');
    }
    const bookingSuggestions = document.getElementById('bookingVaishnavaSuggestions');
    const bookingSearch = document.getElementById('bookingVaishnavSearch');
    if (bookingSuggestions && !bookingSuggestions.contains(e.target) && e.target !== bookingSearch) {
        bookingSuggestions.classList.add('hidden');
    }
});

// Делегирование кликов на подсказках вайшнавов
document.getElementById('vaishnavaSuggestions').addEventListener('click', ev => {
    const el = ev.target.closest('[data-action="select-vaishnava"]');
    if (el) selectVaishnava(el.dataset.id);
});

// Сохранение заселения
async function saveCheckin(e) {
    e.preventDefault();
    if (!canEditTimeline()) return;
    const form = e.target;

    if (form.check_out.value && form.check_out.value < form.check_in.value) {
        Layout.showNotification(tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда'), 'error');
        return;
    }
    // Даты вне ретрита — только предупреждение (ТЗ 01.10, п. 4): прошедший ретрит из архива выбирают осознанно
    if (retreatDatesMismatch(form.retreat_id?.value, form.check_in.value, form.check_out.value)) {
        Layout.showNotification(retreatDatesMismatchText(), 'warning');
    }

    const mealTypeVal = form.meal_type.value || 'prasad';
    const data = {
        room_id: modalContext.roomId,
        category_id: form.category_id.value || null,
        vaishnava_id: form.vaishnava_id.value || null,
        guest_name: form.guest_name.value || null,
        guest_phone: form.guest_phone?.value || null,
        check_in: form.check_in.value,
        check_out: form.check_out.value || null,
        early_checkin: form.early_checkin.checked,
        late_checkout: form.late_checkout.checked,
        // Ретрит подставляется по датам, но остаётся на выбор: без него
        // человек не считается участником — не увидим ни долг, ни расселение
        retreat_id: form.retreat_id?.value || null,
        // «Заселить» = человек на пороге: приезд фиксируется всегда.
        // Заранее место держат через «Забронировать» или расселение ретрита.
        arrived_at: new Date().toISOString(),
        meal_type: mealTypeVal,
        // Самостоятельное проживание: без номера, живёт вне ашрама
        // Без номера — живёт вне ашрама (и при вписывании имени в место брони без номера)
        has_housing: !!modalContext.roomId,
        has_meals: mealTypeVal !== 'self',
        // Галочки «Прасад» — основа расчёта порций на кухне
        breakfast: form.breakfast?.checked ?? true,
        lunch: form.lunch?.checked ?? true,
        notes: form.notes.value || null,
        status: 'confirmed'
    };

    // Проверка: должен быть либо вайшнав из БД, либо имя нового гостя
    if (!data.vaishnava_id && !data.guest_name) {
        alert(Layout.t('select_vaishnava_or_enter_name'));
        return;
    }

    let error;

    if (modalContext.isConversion && modalContext.residentId) {
        // Конвертация брони в заселение — обновляем существующую запись
        const result = await Layout.db
            .from('residents')
            .update(data)
            .eq('id', modalContext.residentId);
        error = result.error;
    } else {
        // Новое заселение
        const result = await Layout.db.from('residents').insert(data);
        error = result.error;
    }

    if (error) {
        console.error('Error saving checkin:', error);
        alert(Layout.t('checkin_error') + ': ' + error.message);
        return;
    }

    await offerRetreatOnAdjacent(data.vaishnava_id, data.check_in, data.check_out, data.retreat_id);
    warnOutsideRetreat(data.retreat_id, data.check_in, data.check_out);
    document.getElementById('actionModal').close();
    showActionScreen();
    await loadTimelineData();
    renderTable();
}

// Сохранение бронирования
// Волонтёр или команда: человек есть — дописываем служение, если в карточке пусто;
// нет — заводим черновую карточку со статусом по категории брони (поле статуса —
// «Вайшнавы 1», мигр. 619; is_team_member синхронизирует триггер). null — не вышло.
async function ensureStaffPerson(vaishnavaId, typedName, service, categoryId) {
    if (vaishnavaId) {
        if (service) {
            const { error } = await Layout.db.from('vaishnavas').update({ service })
                .eq('id', vaishnavaId).is('service', null);
            if (error) console.error('service:', error);
        }
        return vaishnavaId;
    }
    const status = categories.find(c => c.id === categoryId)?.slug === 'team' ? 'team' : 'volunteer';
    const { data: draft, error } = await Layout.db.from('vaishnavas')
        .insert({ spiritual_name: typedName, service, status })
        .select('id, spiritual_name, first_name, last_name, gender, phone, birth_date, status')
        .single();
    if (error) { Layout.handleError(error, tf('timeline_draft_card', 'Черновая карточка')); return null; }
    vaishnavas.push(draft);
    Layout.showNotification(tf('timeline_draft_card_created', 'Заведена черновая карточка «{name}» — дополните её, когда будут данные').replace('{name}', typedName), 'info');
    return draft.id;
}

async function saveBooking(e) {
    e.preventDefault();
    if (!canEditTimeline()) return;
    const form = e.target;
    if (modalContext?.editResidentId) return saveBookingEdit(form);

    // Люди брони — каждый на своё место; мест не меньше, чем людей
    const people = bookingPeople();
    const bedsCount = Math.max(parseInt(form.beds_count.value) || 1, people.length);

    // Создаём бронирование
    const earlyCheckin = form.early_checkin.checked;
    const lateCheckout = form.late_checkout.checked;
    const bookingBreakfast = form.breakfast?.checked ?? true;
    const bookingLunch = form.lunch?.checked ?? true;
    const bookingName = form.name.value.trim() || null;

    const bookingRetreatId = form.retreat_id?.value || null;
    if (form.check_out.value && form.check_out.value < form.check_in.value) {
        Layout.showNotification(tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда'), 'error');
        return;
    }
    if (retreatDatesMismatch(bookingRetreatId, form.check_in.value, form.check_out.value)) {
        Layout.showNotification(retreatDatesMismatchText(), 'warning');
    }
    // Свои даты у людей брони: выезд не раньше заезда; бронь — от раннего заезда до позднего выезда
    for (const p of people) {
        p.check_in = p.check_in || form.check_in.value;
        p.check_out = p.check_out || form.check_out.value;
        if (p.check_out && p.check_out < p.check_in) {
            Layout.showNotification(`${p.name || tf('timeline_vaishnava', 'Вайшнав')}: ${tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда')}`, 'error');
            return;
        }
    }
    const bookingCheckIn = people.reduce((m, p) => p.check_in < m ? p.check_in : m, form.check_in.value);
    const bookingCheckOut = people.reduce((m, p) => p.check_out > m ? p.check_out : m, form.check_out.value);
    const bookingCategoryId = form.category_id?.value || null;
    const chosenIds = people.map(p => p.id).filter(Boolean);
    if (new Set(chosenIds).size !== chosenIds.length) {
        Layout.showNotification(tf('timeline_person_twice', 'Один и тот же человек выбран дважды'), 'error');
        return;
    }

    // Волонтёр и команда (ВГ 02.10): департамент обязателен; человек — из справочника,
    // а если его там нет, по вписанному имени заводим черновую карточку
    const staff = isStaffCategory(bookingCategoryId);
    const departmentId = staff ? (form.department_id?.value || null) : null;
    const service = staff ? (form.service?.value.trim() || null) : null;
    if (staff && !departmentId) {
        Layout.showNotification(tf('timeline_department_required', 'Выберите департамент: у волонтёра и команды он обязателен'), 'error');
        return;
    }
    if (staff && !people[0].id && !people[0].name) {
        Layout.showNotification(tf('timeline_person_required', 'Укажите человека: выберите из справочника или впишите имя — заведём черновую карточку'), 'error');
        return;
    }
    // Команда и волонтёры — у каждого вписанного имени черновая карточка; гость — имя в месте
    if (staff) {
        for (const p of people) {
            p.id = await ensureStaffPerson(p.id, p.name, service, bookingCategoryId);
            if (!p.id) return;
        }
    }
    const bookingVaishnavaId = people[0].id;

    const bookingData = {
        name: bookingName,
        contact_name: form.contact_name.value,
        contact_phone: form.contact_phone.value || null,
        contact_telegram: form.contact_telegram.value.trim() || null,
        check_in: bookingCheckIn,
        check_out: bookingCheckOut,
        beds_count: bedsCount,
        retreat_id: bookingRetreatId,
        early_checkin: earlyCheckin,
        late_checkout: lateCheckout,
        notes: form.notes.value || null,
        status: 'confirmed'
    };

    const { data: booking, error: bookingError } = await Layout.db
        .from('bookings')
        .insert(bookingData)
        .select()
        .single();

    if (bookingError) {
        console.error('Error saving booking:', bookingError);
        alert(Layout.t('booking_error') + ': ' + bookingError.message);
        return;
    }

    // Создаём placeholder резидентов для бронирования.
    // Места по порядку — за указанными людьми, остальные безымянные.
    const residents = [];
    for (let i = 0; i < bedsCount; i++) {
        const person = people[i];
        residents.push({
            room_id: modalContext.roomId,
            booking_id: booking.id,
            vaishnava_id: person?.id || null,
            guest_name: person && !person.id ? (person.name || null) : null,
            // Пусто — не передаём, чтобы сработал default колонки («Гость»)
            ...(bookingCategoryId ? { category_id: bookingCategoryId } : {}),
            // Департамент — у каждого места; у места с человеком база пишет его в историю служения
            department_id: departmentId,
            // Ретрит с брони: без него место не свяжется ни с регистрацией,
            // ни с долгом при выезде
            retreat_id: bookingRetreatId,
            check_in: person?.check_in || form.check_in.value,
            check_out: person?.check_out || form.check_out.value,
            early_checkin: earlyCheckin,
            late_checkout: lateCheckout,
            // Без номера — живёт вне ашрама, только питание (окно «Начислить группе» не берёт ночи)
            has_housing: !!modalContext.roomId,
            // В номере «питается?» уточняют при заселении; без номера бронь и есть питание
            has_meals: modalContext.roomId ? null : (bookingBreakfast || bookingLunch),
            // Питание считается уже с брони, не дожидаясь заселения
            breakfast: bookingBreakfast,
            lunch: bookingLunch,
            status: 'confirmed'
        });
    }

    const { error: residentsError } = await Layout.db.from('residents').insert(residents);

    if (residentsError) {
        console.error('Error saving booking residents:', residentsError);
        Layout.showNotification(residentsError.message, 'error');
    } else {
        await offerRetreatOnAdjacent(bookingVaishnavaId, form.check_in.value, form.check_out.value, bookingRetreatId);
        warnOutsideRetreat(bookingRetreatId, bookingCheckIn, bookingCheckOut);
        await offerRetreatContact(bookingRetreatId, document.getElementById('bookingContactId').value);
    }

    document.getElementById('actionModal').close();
    showActionScreen();
    await loadTimelineData();
    renderTable();
}

// Обработчик других действий
async function handleAction(action) {
    const startDate = document.getElementById('modalCheckIn').value;
    const endDate = document.getElementById('modalCheckOut').value;

    if (action === 'cleaning' || action === 'linen') {
        // Для белья: только половина ячейки (end_date = start_date)
        const finalEndDate = action === 'linen' ? startDate : endDate;

        const { error } = await Layout.db.from('room_cleanings').insert({
            room_id: modalContext.roomId,
            start_date: startDate,
            end_date: finalEndDate,
            type: action
        });

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('actionModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    if (action === 'repair') {
        // TODO: Закрытие на ремонт
        alert(Layout.t('feature_in_development'));
    }

    document.getElementById('actionModal').close();
}

// Текущий резидент для модалки
let currentResident = null;
// День, на который кликнули (для выселения)
let clickedDayIndex = null;

// Открыть модалку резидента из хранилища
function openResidentFromMap(guestId, event) {
    const guestData = guestsMap.get(guestId);
    if (!guestData) {
        console.error('Guest not found:', guestId);
        return;
    }

    // Вычисляем день клика по позиции мыши на плашке
    // Используем полудни (колонки) для точного расчёта
    if (event) {
        const bar = event.target.closest('.guest-bar');
        if (bar) {
            const rect = bar.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            const barWidth = rect.width;
            // Считаем в полуднях (колонках) для точности
            const startCol = guestData.startDay * 2 + guestData.startHalf;
            const endCol = guestData.endDay * 2 + guestData.endHalf;
            const totalCols = endCol - startCol + 1;
            const colOffset = Math.floor((clickX / barWidth) * totalCols);
            const clickedCol = startCol + colOffset;
            // Конвертируем колонку обратно в день
            clickedDayIndex = Math.floor(clickedCol / 2);
        } else {
            clickedDayIndex = guestData.endDay;
        }
    } else {
        clickedDayIndex = guestData.endDay;
    }

    openResidentModal(guestData, guestData.buildingName, guestData.roomName);
}

// Открыть модалку резидента
function openResidentModal(guestData, buildingName, roomName) {
    currentResident = guestData;
    const res = guestData.rawData;
    const isBooking = guestData.isBooking;
    const isCheckedOut = res.status === 'checked_out';

    // Заголовок
    let title = isBooking ? t('timeline_booking') : t('timeline_stay');
    if (isCheckedOut) title = t('timeline_checked_out');
    document.getElementById('residentModalTitle').textContent = title;

    // Локация
    document.getElementById('residentModalLocation').textContent = res.room_id
        ? `${buildingName} → ${t('timeline_room')} ${roomName}`
        : selfBlockLabel(selfKind(res));

    // Информация
    let infoHtml = '';

    // Имя (с ссылкой на профиль, если есть vaishnava_id)
    const nameLink = res.vaishnava_id
        ? `<a href="../vaishnavas/person.html?id=${res.vaishnava_id}" class="link link-primary">${guestData.name}</a>`
        : guestData.name;
    infoHtml += `<div class="flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_guest')}:</span>
        <span class="font-medium">${nameLink}</span>
    </div>`;

    // Особые потребности из CRM — видны при заселении, без перехода в другой раздел (ТЗ 2.3)
    {
        const нужды = res.vaishnava_id && res.retreat_id
            && specialNeedsMap.get(`${res.vaishnava_id}_${res.retreat_id}`);
        if (нужды) {
            infoHtml += `<div class="flex justify-between py-1 border-b">
                <span class="text-gray-500">${t('special_needs_col')}:</span>
                <span class="font-medium text-amber-700">${Layout.escapeHtml(нужды)}</span>
            </div>`;
        }
    }

    // Долг по финмодулю: шахматка знает только факт, суммы — в карточке финмодуля
    // (страница сама проверит права; ресепшену без fin-прав покажет отказ)
    if (guestData.hasDebt) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_finance_card')}:</span>
            <span class="font-medium text-error">
                ${t('timeline_has_debt')}
                <a href="${finHref(res)}" class="link link-primary ml-1">→</a>
            </span>
        </div>`;
    }

    if (!guestData.hasDebt && guestData.hasCredit) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_finance_card')}:</span>
            <span class="font-medium text-success">
                ${t('timeline_we_owe')}
                <a href="${finHref(res)}" class="link link-primary ml-1">→</a>
            </span>
        </div>`;
    }

    // Гость без события: начислить и принять оплату — в Финансах по этому визиту (ВГ, 29.09)
    if (!guestData.hasDebt && !guestData.hasCredit && !res.retreat_id && res.category_id === GUEST_CATEGORY_ID
        && (window.hasPermission?.('fin_admin') || window.hasPermission?.('fin_observer'))) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_finance_card')}:</span>
            <span>${uncharged.has(res.id) ? `<span class="text-gray-500 mr-1">${Layout.escapeHtml(tf('timeline_not_charged', 'Не начислено и не оплачено'))} ·</span>` : ''}<a href="${finHref(res)}" class="link link-primary font-medium">${Layout.escapeHtml(tf('timeline_charge_payment', 'Начисление и оплата'))} →</a></span>
        </div>`;
    }

    // Больше 3 дней до/после ретрита — подсказка вынести хвост в «Гости без события» (вариант 2, ВГ 01.10)
    {
        const o = outsideRetreat(res.retreat_id, res.check_in, res.check_out);
        if (o && !isBooking && !outsideDismissed(res.id)) {
            const кнопка = (side, n, label) => n && canEditTimeline()
                ? `<button type="button" class="btn btn-xs btn-warning btn-outline" data-action="split-retreat" data-side="${side}">${label}</button>` : '';
            infoHtml += `<div class="alert alert-warning py-2 px-3 my-2 text-sm flex flex-wrap items-center gap-2" id="outsideRetreatAlert">
                <span class="flex-1">${Layout.escapeHtml(outsideRetreatText(o))}</span>
                ${кнопка('before', o.before, tf('timeline_split_before', 'Разделить: до ретрита'))}
                ${кнопка('after', o.after, tf('timeline_split_after', 'Разделить: после ретрита'))}
                <button type="button" class="btn btn-xs btn-ghost" data-action="dismiss-outside" title="${Layout.escapeHtml(tf('close', 'Закрыть'))}">✕</button>
            </div>`;
        }
    }

    // Категория
    if (res.resident_categories) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_category')}:</span>
            <span class="font-medium">${Layout.getName(res.resident_categories)}</span>
        </div>`;
    }

    // Департамент места (ВГ 02.10): виден у всех, у волонтёра и команды — обязателен;
    // меняется на месте, без пересоздания брони. Место с человеком — база пишет его
    // в историю служения на даты места (миграция 614)
    if (res.department_id || isStaffCategory(res.category_id)) {
        const control = canEditTimeline()
            ? `<select class="select select-bordered select-sm max-w-[16rem]${res.department_id ? '' : ' border-error'}" onchange="setResidentDepartment(this)">
                   <option value="">—</option>
                   ${departments.map(d => `<option value="${d.id}" ${d.id === res.department_id ? 'selected' : ''}>${e(Layout.getName(d))}</option>`).join('')}
               </select>`
            : `<span class="font-medium">${e(departmentName(res.department_id) || '—')}</span>`;
        infoHtml += `<div class="flex justify-between items-center gap-2 py-1 border-b">
            <span class="text-gray-500">${tf('department', 'Департамент')}:</span>
            ${control}
        </div>`;
    }
    if (res.vaishnavas?.service) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${tf('service', 'Служение')}:</span>
            <span class="font-medium">${e(res.vaishnavas.service)}</span>
        </div>`;
    }

    // Ретрит брони — виден всегда, при правах меняется на месте. Бронь с ретритом
    // делает человека участником (регистрацию создаёт база, миграция 524)
    if (res.vaishnava_id || res.retreat_id) {
        const known = allRetreats.find(r => r.id === res.retreat_id) || periodRetreats.find(r => r.id === res.retreat_id);
        let control;
        if (canEditTimeline()) {
            let options = retreatSelectHtml(res.retreat_id || '', res.check_in, res.check_out || res.check_in);
            if (res.retreat_id && !allRetreats.some(r => r.id === res.retreat_id)) {
                options += `<option value="${res.retreat_id}" selected>${e(known ? Layout.getName(known) : '—')}</option>`;
            }
            control = `<select class="select select-bordered select-sm max-w-[16rem]" onchange="setResidentRetreat(this)">${options}</select>`;
        } else {
            control = `<span class="font-medium">${known ? e(Layout.getName(known)) : (Layout.t('timeline_no_retreat') || '— без ретрита —')}</span>`;
        }
        infoHtml += `<div class="flex justify-between items-center gap-2 py-1 border-b">
            <span class="text-gray-500">${Layout.t('nav_retreats') || 'Ретрит'}:</span>
            ${control}
        </div>`;
    }

    // Даты
    infoHtml += `<div class="flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_checkin')}:</span>
        <span class="font-medium">${formatDisplayDate(res.check_in)}${res.early_checkin ? ` (${t('timeline_early')})` : ''}</span>
    </div>`;
    // Плейсхолдер для времени приезда (заполняется асинхронно)
    infoHtml += `<div id="residentArrivalTime" class="hidden flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_arrival_time')}:</span>
        <span class="font-medium" id="residentArrivalTimeValue"></span>
    </div>`;

    if (res.check_out) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_checkout')}:</span>
            <span class="font-medium">${formatDisplayDate(res.check_out)}${res.late_checkout ? ` (${t('timeline_late')})` : ''}</span>
        </div>`;
    }
    // Плейсхолдер для времени отъезда
    infoHtml += `<div id="residentDepartureTime" class="hidden flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_departure_time')}:</span>
        <span class="font-medium" id="residentDepartureTimeValue"></span>
    </div>`;

    // Телефон
    if (res.guest_phone) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_phone')}:</span>
            <span class="font-medium">${e(res.guest_phone)}</span>
        </div>`;
    }

    // Питание
    if (!isBooking) {
        const mealsLabel = res.has_meals === true ? t('timeline_meals_yes') : res.has_meals === false ? t('timeline_meals_no') : t('timeline_meals_unknown');
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_meals')}:</span>
            <span class="font-medium">${mealsLabel}</span>
        </div>`;
    }

    // Питание по дням — отлучки без разрезания проживания (мигр. 627)
    if (res.has_meals !== false && res.check_out && canEditTimeline()) {
        const nSkips = mealSkipsMap.get(res.id)?.size || 0;
        infoHtml += `<div class="flex justify-between items-center gap-2 py-1 border-b">
            <span class="text-gray-500">${e(tf('timeline_meal_days', 'Питание по дням'))}${nSkips ? ` <span class="badge badge-warning badge-sm">${e(tf('timeline_meal_skipped_n', 'пропусков: {n}').replace('{n}', nSkips))}</span>` : ''}</span>
            <button class="btn btn-xs btn-outline" data-action="meal-days">${e(tf('timeline_away', 'Уезжает на время'))} / ${e(tf('edit', 'Изменить'))}</button>
        </div>`;
    }

    // Примечания
    if (res.notes) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_notes')}:</span>
            <span class="font-medium">${e(res.notes)}</span>
        </div>`;
    }

    // Бронирование
    if (res.bookings) {
        if (res.bookings.name) {
            infoHtml += `<div class="flex justify-between py-1 border-b">
                <span class="text-gray-500">${t('timeline_booking')}:</span>
                <span class="font-medium">${e(res.bookings.name)}</span>
            </div>`;
        }
        if (res.bookings.contact_name) {
            infoHtml += `<div class="flex justify-between py-1 border-b">
                <span class="text-gray-500">${t('timeline_contact')}:</span>
                <span class="font-medium">${e(res.bookings.contact_name)}</span>
            </div>`;
        }
        // Примечание брони (ТЗ 01.10, п. 6): пишется в форме брони, а раньше не было видно нигде
        if (res.bookings.notes && res.bookings.notes !== res.notes) {
            infoHtml += `<div class="flex justify-between gap-3 py-1 border-b">
                <span class="text-gray-500 shrink-0">${tf('timeline_booking_notes', 'Примечание брони')}:</span>
                <span class="font-medium text-right whitespace-pre-line">${e(res.bookings.notes)}</span>
            </div>`;
        }
    }

    document.getElementById('residentInfo').innerHTML = infoHtml;

    // Кнопки действий (только если есть права на редактирование)
    let actionsHtml = '';
    const canEdit = canEditTimeline();

    if (canEdit) {
        // Правка всех полей брони/проживания в форме «Бронирование» (ТЗ 01.10, п. 7)
        actionsHtml += `<button class="btn btn-outline" data-action="edit-booking">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536M9 13l6.232-6.232a2.5 2.5 0 113.536 3.536L12.536 16.536A4 4 0 0110 17.5H7v-3a4 4 0 011-2.5z" />
            </svg>
            ${e(tf('edit', 'Изменить'))}
        </button>`;
        if (isBooking) {
            // Действия для бронирования
            actionsHtml += `<button class="btn btn-primary" data-action="convert-to-checkin">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
                ${t('timeline_checkin_action')}
            </button>`;
            actionsHtml += `<button class="btn btn-outline" data-action="show-edit-dates-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                ${t('timeline_dates')}
            </button>`;
            actionsHtml += `<button class="btn btn-info btn-outline" data-action="show-move-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                ${t('timeline_move')}
            </button>`;
            actionsHtml += `<button class="btn btn-error btn-outline" data-action="no-show">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
                ${e(tf('timeline_no_show', 'Не приехал / отказ'))}
            </button>`;
        } else if (!isCheckedOut) {
            // Действия для заселённого гостя (не выселенного)
            actionsHtml += `<button class="btn btn-warning" data-action="checkout-resident">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                ${t('timeline_checkout_action')}
            </button>`;
            actionsHtml += `<button class="btn btn-outline" data-action="show-edit-dates-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                ${t('timeline_dates')}
            </button>`;
            actionsHtml += `<button class="btn btn-info btn-outline" data-action="show-move-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                ${t('timeline_move')}
            </button>`;
        }
        // Для выселенных (isCheckedOut) — только кнопка удаления

        // Кнопка удаления для всех
        actionsHtml += `<button class="btn btn-error btn-outline" data-action="delete-resident">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            ${t('timeline_delete')}
        </button>`;
    } else {
        actionsHtml = `<p class="text-sm opacity-60">${t('timeline_view_only')}</p>`;
    }

    document.getElementById('residentActions').innerHTML = actionsHtml;

    // Показываем экран информации (сбрасываем если был на экране перемещения)
    showResidentInfoScreen();

    // Открываем модалку
    document.getElementById('residentModal').showModal();

    // Подгружаем время приезда/отъезда из retreat_registrations
    if (res.retreat_id && res.vaishnava_id) {
        loadRetreatTimes(res.retreat_id, res.vaishnava_id);
    }
}

// Подгрузка arrival/departure datetime из retreat_registrations
async function loadRetreatTimes(retreatId, vaishnavId) {
    const { data } = await Layout.db
        .from('retreat_registrations')
        .select('arrival_datetime, departure_datetime')
        .eq('retreat_id', retreatId)
        .eq('vaishnava_id', vaishnavId)
        .eq('is_deleted', false)
        .maybeSingle();

    if (!data) return;

    if (data.arrival_datetime) {
        const el = document.getElementById('residentArrivalTime');
        const val = document.getElementById('residentArrivalTimeValue');
        if (el && val) {
            val.textContent = formatTimestampShort(data.arrival_datetime);
            el.classList.remove('hidden');
        }
    }
    if (data.departure_datetime) {
        const el = document.getElementById('residentDepartureTime');
        const val = document.getElementById('residentDepartureTimeValue');
        if (el && val) {
            val.textContent = formatTimestampShort(data.departure_datetime);
            el.classList.remove('hidden');
        }
    }
}

// Форматирует TIMESTAMPTZ в читаемый вид: "7 фев, 10:35"
function formatTimestampShort(datetimeStr) {
    if (!datetimeStr) return '—';
    const d = new Date(datetimeStr.slice(0, 16));
    const months = DateUtils.monthNamesShort.ru;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getDate()} ${months[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Форматирование даты для отображения
function formatDisplayDate(dateStr) {
    const date = DateUtils.parseDate(dateStr);
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Форматирование даты в YYYY-MM-DD без сдвига часового пояса
function formatDateYMD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Выселить резидента — читает дату и поздний выезд из формы checkoutScreen
async function checkoutResident() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const res = currentResident.rawData;
    const checkoutDate = document.getElementById('checkoutDate').value;
    const lateCheckout = document.getElementById('checkoutLate').checked;

    if (!checkoutDate) {
        alert(Layout.t('specify_checkout_date') || 'Укажите дату выезда');
        return;
    }

    if (checkoutDate < res.check_in) {
        alert(Layout.t('checkout_before_checkin') || 'Дата выезда не может быть раньше заезда');
        return;
    }

    // Долг по финмодулю: предупреждаем, но не блокируем — решать долг проще,
    // пока гость ещё на месте (вопрос 9 интеграционных ответов). Флаг спрашиваем
    // свежий: подсветка могла устареть с момента загрузки шахматки.
    if (res.vaishnava_id && res.retreat_id) {
        const { data: hasDebt } = await Layout.db.rpc('fin_has_debt', {
            p_participant: res.vaishnava_id, p_retreat: res.retreat_id
        });
        if (hasDebt === true && !confirm(t('timeline_debt_warning'))) return;
    } else if (res.vaishnava_id) {
        const { data: флаги } = await Layout.db.rpc('fin_no_event_debt_flags', { p_participant: res.vaishnava_id });
        if (флаги?.some(f => f.is_debt) && !confirm(t('timeline_debt_warning'))) return;
    }

    const { error } = await Layout.db
        .from('residents')
        .update({ check_out: checkoutDate, late_checkout: lateCheckout, status: 'checked_out' })
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Удалить резидента
async function deleteResident() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;
    if (!confirm(Layout.t('confirm_delete_entry'))) return;

    const { error } = await Layout.db
        .from('residents')
        .delete()
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Сменить департамент места прямо из окна проживания (ВГ 02.10).
// У брони на несколько мест меняем у всех её мест — департамент у брони один
async function setResidentDepartment(sel) {
    if (!currentResident || !canEditTimeline()) return;
    const res = currentResident.rawData;
    const departmentId = sel.value || null;
    if (departmentId === (res.department_id || null)) return;
    if (!departmentId && isStaffCategory(res.category_id)) {
        Layout.showNotification(tf('timeline_department_required', 'Выберите департамент: у волонтёра и команды он обязателен'), 'error');
        sel.value = res.department_id || '';
        return;
    }
    sel.disabled = true;
    const q = Layout.db.from('residents').update({ department_id: departmentId });
    const { error } = await (res.booking_id ? q.eq('booking_id', res.booking_id) : q.eq('id', currentResident.id));
    sel.disabled = false;
    if (error) {
        sel.value = res.department_id || '';
        Layout.handleError(error, tf('department', 'Департамент'));
        return;
    }
    res.department_id = departmentId;
    sel.classList.toggle('border-error', !departmentId);
    Layout.showNotification(tf('timeline_department_saved', 'Департамент изменён'), 'success');
    await loadTimelineData();
    renderTable();
}

// Сменить ретрит брони прямо из окна проживания
async function setResidentRetreat(sel) {
    if (!currentResident || !canEditTimeline()) return;
    const res = currentResident.rawData;
    const retreatId = sel.value || null;
    if (retreatId === (res.retreat_id || null)) return;
    if (retreatId && retreatDatesMismatch(retreatId, res.check_in, res.check_out || res.check_in)
        && !confirm(retreatDatesMismatchText() + '. ' + (Layout.t('continue') || 'Продолжить?'))) {
        sel.value = res.retreat_id || '';
        return;
    }
    sel.disabled = true;
    const { error } = await Layout.db.from('residents').update({ retreat_id: retreatId }).eq('id', currentResident.id);
    sel.disabled = false;
    if (error) {
        sel.value = res.retreat_id || '';
        Layout.handleError(error, Layout.t('nav_retreats') || 'Ретрит');
        return;
    }
    res.retreat_id = retreatId;
    await offerRetreatOnAdjacent(res.vaishnava_id, res.check_in, res.check_out, retreatId);
    warnOutsideRetreat(retreatId, res.check_in, res.check_out);
    const msg = Layout.t('timeline_retreat_saved');
    Layout.showNotification(msg === 'timeline_retreat_saved' ? 'Ретрит брони изменён' : msg, 'success');
    await loadTimelineData();
    renderTable();
}

// «Не приехал / отказ»: экран с тем, что произойдёт, причиной и комментарием.
// Само действие — одна функция в базе (миграция 570): бронь, регистрация и сделка
// снимаются вместе и без удаления, человек перестаёт считаться вкушающим.
let cancellationReasons = null;

async function showNoShowScreen() {
    if (!currentResident || !canEditTimeline()) return;
    const res = currentResident.rawData;

    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('noShowScreen').classList.remove('hidden');
    document.getElementById('noShowGuestName').textContent = currentResident.name;
    document.getElementById('noShowNote').value = '';
    const list = document.getElementById('noShowWill');
    list.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';

    const withRetreat = res.vaishnava_id && res.retreat_id;
    const [reasonsRes, otherRes, dealsRes] = await Promise.all([
        cancellationReasons ? { data: cancellationReasons }
            : Layout.db.from('crm_cancellation_reasons').select('id, code, name_ru, name_en, name_hi').order('sort_order'),
        withRetreat ? Layout.db.from('residents').select('id', { count: 'exact', head: true })
            .eq('vaishnava_id', res.vaishnava_id).eq('retreat_id', res.retreat_id)
            .neq('id', res.id).neq('status', 'cancelled') : { count: 0 },
        withRetreat ? Layout.db.from('crm_deals').select('status, total_paid')
            .eq('vaishnava_id', res.vaishnava_id).eq('retreat_id', res.retreat_id)
            .not('status', 'in', '(cancelled,completed)') : { data: [] }
    ]);
    cancellationReasons = reasonsRes.data || [];

    const items = [tf('timeline_no_show_booking', 'Бронь снимается (остаётся в истории)')];
    const deals = dealsRes.data || [];
    if (withRetreat) {
        if (otherRes.count) {
            items.push(tf('timeline_no_show_reg_kept', 'Регистрация остаётся — есть другая бронь на этот ретрит'));
        } else {
            items.push(tf('timeline_no_show_reg', 'Регистрация на ретрит отменяется'));
            if (deals.length) items.push(tf('timeline_no_show_deal', 'Сделка в CRM → «Отменена»'));
        }
    }
    items.push(tf('timeline_no_show_eating', 'Больше не считается вкушающим'));
    let html = items.map(s => `<li>${e(s)}</li>`).join('');
    if (!otherRes.count && deals.some(d => Number(d.total_paid) > 0)) {
        html += `<li class="text-warning font-medium">${e(tf('timeline_no_show_paid', 'По сделке оплачено — возврат или перенос оформляется в финансах'))}</li>`;
    }
    list.innerHTML = html;

    // Причина нужна только для сделки в CRM
    const showReason = withRetreat && !otherRes.count && deals.length > 0;
    document.getElementById('noShowReasonWrap').classList.toggle('hidden', !showReason);
    document.getElementById('noShowReason').innerHTML = cancellationReasons
        .map(r => `<option value="${r.id}" ${r.code === 'no_show' ? 'selected' : ''}>${e(Layout.getName(r))}</option>`).join('');
}

async function submitNoShow(btn) {
    if (!currentResident || !canEditTimeline()) return;
    const reasonWrap = document.getElementById('noShowReasonWrap');
    btn.disabled = true;
    const { error } = await Layout.db.rpc('resident_no_show', {
        p_resident_id: currentResident.id,
        p_reason_id: reasonWrap.classList.contains('hidden') ? null : (document.getElementById('noShowReason').value || null),
        p_note: document.getElementById('noShowNote').value.trim() || null
    });
    btn.disabled = false;
    if (error) {
        Layout.handleError(error, tf('timeline_no_show', 'Не приехал / отказ'));
        return;
    }
    Layout.showNotification(tf('timeline_no_show_done', 'Отмечено: не приехал'), 'success');
    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
    loadStayAlerts();
}

// Показать экран информации о резиденте
function showResidentInfoScreen() {
    document.getElementById('noShowScreen').classList.add('hidden');
    document.getElementById('mealDaysScreen').classList.add('hidden');
    document.getElementById('residentInfoScreen').classList.remove('hidden');
    document.getElementById('moveScreen').classList.add('hidden');
    document.getElementById('editDatesScreen').classList.add('hidden');
    document.getElementById('checkoutScreen').classList.add('hidden');
}

// ==================== ПИТАНИЕ ПО ДНЯМ ====================
// Отлучка (ВГ, 03.10): человек живёт одной записью, номер за ним; снятые приёмы — пропуски
// resident_meal_skips, их учитывает eating_detail → кухня, Себестоимость и бот видят сами.
// База дня — что кухня считает без пропусков этого места; приёмы, которых кухня не считает
// (завтрак в день заезда и т.п.), здесь не включаются — это края проживания.
let mealDays = [];   // [{d, baseB, baseL, b, l}]

async function showMealDaysScreen() {
    if (!currentResident || !canEditTimeline()) return;
    const res = currentResident.rawData;
    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('mealDaysScreen').classList.remove('hidden');
    document.getElementById('mealDaysGuestName').textContent = currentResident.name;
    const list = document.getElementById('mealDaysList');
    list.innerHTML = `<div class="text-center py-4">${t('timeline_loading')}</div>`;
    list._scrolled = false;

    const from = res.meal_start_date || res.check_in;
    const to = res.meal_end_date || res.check_out;
    const [{ data: ed, error }, { data: sk }] = await Promise.all([
        Layout.db.rpc('eating_detail', { p_from: from, p_to: to }).eq('ref_id', res.id),
        Layout.db.from('resident_meal_skips').select('d, breakfast, lunch').eq('resident_id', res.id)
    ]);
    if (error) { Layout.handleError(error, tf('timeline_meal_days', 'Питание по дням')); return; }
    const byDay = new Map();
    for (const r of (ed || [])) {
        const x = byDay.get(r.d) || { b: false, l: false };
        byDay.set(r.d, { b: x.b || !!r.breakfast, l: x.l || !!r.lunch });
    }
    const skips = new Map((sk || []).map(x => [x.d, x]));
    mealDays = [];
    for (let d = DateUtils.parseDate(from); formatDateYMD(d) <= to; d.setDate(d.getDate() + 1)) {
        const ds = formatDateYMD(d);
        const eat = byDay.get(ds) || { b: false, l: false };
        const s = skips.get(ds);
        const baseB = eat.b || !!s?.breakfast, baseL = eat.l || !!s?.lunch;
        mealDays.push({ d: ds, baseB, baseL, b: eat.b, l: eat.l });
    }

    // Отлучка по умолчанию — с завтрашнего дня (если он внутри проживания)
    const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
    let def = formatDateYMD(tomorrow);
    if (def < from) def = from;
    if (def > to) def = to;
    for (const id of ['awayFrom', 'awayTo']) {
        const el = document.getElementById(id);
        el.min = from; el.max = to; el.value = def;
    }
    renderMealDays();
}

function renderMealDays() {
    const list = document.getElementById('mealDaysList');
    const today = formatDateYMD(new Date());
    const lang = { en: 'en-GB', hi: 'hi-IN' }[localStorage.getItem('srsk_lang')] || 'ru-RU';
    const cell = (i, k, base, on) => base
        ? `<input type="checkbox" class="checkbox checkbox-sm checkbox-primary" data-meal-i="${i}" data-meal-k="${k}"${on ? ' checked' : ''}>`
        : '<span class="opacity-30">—</span>';
    list.innerHTML = `<table class="table table-xs">
        <thead class="sticky top-0 bg-base-100 z-10"><tr><th></th><th class="text-center">${e(Layout.t('breakfast'))}</th><th class="text-center">${e(Layout.t('lunch'))}</th></tr></thead>
        <tbody>${mealDays.map((m, i) => {
            const dt = DateUtils.parseDate(m.d);
            const off = (m.baseB && !m.b) || (m.baseL && !m.l);
            return `<tr class="${m.d === today ? 'bg-primary/10 font-medium' : ''}${off ? ' text-warning' : ''}" ${m.d === today ? 'data-today' : ''}>
                <td>${e(dt.toLocaleDateString(lang, { weekday: 'short' }))} ${m.d.slice(8, 10)}.${m.d.slice(5, 7)}</td>
                <td class="text-center">${cell(i, 'b', m.baseB, m.b)}</td>
                <td class="text-center">${cell(i, 'l', m.baseL, m.l)}</td>
            </tr>`;
        }).join('')}</tbody></table>`;
    if (!list._delegated) {
        list._delegated = true;
        list.addEventListener('change', ev => {
            const cb = ev.target.closest('[data-meal-i]');
            if (!cb) return;
            mealDays[+cb.dataset.mealI][cb.dataset.mealK] = cb.checked;
            renderMealDays();
        });
    }
    const todayRow = list.querySelector('[data-today]');
    if (todayRow && !list._scrolled) { list._scrolled = true; list.scrollTop = Math.max(0, todayRow.offsetTop - 60); }
}

// «Уезжает на время»: в день отъезда — что успевает съесть, в день возвращения — к чему
// успевает, дни между — без питания. Только меняет список, сохраняет кнопка «Сохранить»
function applyAway() {
    const from = document.getElementById('awayFrom').value;
    const to = document.getElementById('awayTo').value;
    if (!from || !to || to < from || from < mealDays[0]?.d || to > mealDays[mealDays.length - 1]?.d) {
        Layout.showNotification(tf('timeline_away_bad_dates', 'Даты отлучки должны быть внутри проживания'), 'warning');
        return;
    }
    const fB = document.getElementById('awayFromB').checked, fL = document.getElementById('awayFromL').checked;
    const tB = document.getElementById('awayToB').checked, tL = document.getElementById('awayToL').checked;
    for (const m of mealDays) {
        if (m.d < from || m.d > to) continue;
        let b = false, l = false;
        if (m.d === from) { b = fB; l = fL; }
        // Отъезд и возвращение в один день — ест то, что отмечено хотя бы в одной строке
        if (m.d === to) { b = from === to ? b || tB : tB; l = from === to ? l || tL : tL; }
        m.b = m.baseB && b;
        m.l = m.baseL && l;
    }
    renderMealDays();
}

async function saveMealDays(btn) {
    if (!currentResident || !mealDays.length) return;
    const skips = mealDays
        .map(m => ({ d: m.d, b: m.baseB && !m.b, l: m.baseL && !m.l }))
        .filter(s => s.b || s.l);
    btn.disabled = true;
    const { error } = await Layout.db.rpc('resident_set_meal_skips', {
        p_resident_id: currentResident.id,
        p_from: mealDays[0].d,
        p_to: mealDays[mealDays.length - 1].d,
        p_skips: skips
    });
    btn.disabled = false;
    if (error) { Layout.handleError(error, tf('timeline_meal_days', 'Питание по дням')); return; }
    Layout.showNotification(tf('timeline_meal_days_saved', 'Питание сохранено — кухня видит изменения'), 'success');
    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Показать экран выселения
function showCheckoutScreen() {
    if (!currentResident) return;

    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('moveScreen').classList.add('hidden');
    document.getElementById('editDatesScreen').classList.add('hidden');
    document.getElementById('checkoutScreen').classList.remove('hidden');

    document.getElementById('checkoutGuestName').textContent = currentResident.name;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let defaultDate = formatDateYMD(today);
    const res = currentResident.rawData;
    if (defaultDate < res.check_in) defaultDate = res.check_in;

    document.getElementById('checkoutDate').value = defaultDate;
    document.getElementById('checkoutLate').checked = res.late_checkout || false;
}

// Показать экран редактирования дат
function showEditDatesScreen() {
    if (!currentResident) return;

    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('moveScreen').classList.add('hidden');
    document.getElementById('editDatesScreen').classList.remove('hidden');
    document.getElementById('checkoutScreen').classList.add('hidden');

    document.getElementById('editDatesGuestName').textContent = currentResident.name;

    const res = currentResident.rawData;
    document.getElementById('editCheckIn').value = res.check_in || '';
    document.getElementById('editCheckOut').value = res.check_out || '';
    document.getElementById('editEarlyCheckin').checked = res.early_checkin || false;
    document.getElementById('editLateCheckout').checked = res.late_checkout || false;
}

// Сохранить изменённые даты
async function saveDates() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const checkIn = document.getElementById('editCheckIn').value;
    const checkOut = document.getElementById('editCheckOut').value;
    const earlyCheckin = document.getElementById('editEarlyCheckin').checked;
    const lateCheckout = document.getElementById('editLateCheckout').checked;

    if (!checkIn) {
        alert(Layout.t('specify_checkin_date'));
        return;
    }
    // Выезд раньше заезда — бронь пропадает из шахматки и из подсчёта вкушающих
    if (checkOut && checkOut < checkIn) {
        alert(tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда'));
        return;
    }

    // Новые даты совсем не пересекаются с ретритом брони — ретрит уже не тот.
    // Предлагаем снять его (другой ретрит выбирается потом в окне брони), иначе не сохраняем
    const update = { check_in: checkIn, check_out: checkOut || null, early_checkin: earlyCheckin, late_checkout: lateCheckout };
    const oldRetreatId = currentResident.rawData.retreat_id;
    if (retreatDatesMismatch(oldRetreatId, checkIn, checkOut || checkIn)) {
        const r = allRetreats.find(x => x.id === oldRetreatId);
        const q = Layout.t('timeline_dates_retreat_clear');
        const text = (q === 'timeline_dates_retreat_clear'
            ? 'Новые даты не пересекаются с ретритом «{retreat}» ({dates}). Снять ретрит с брони? Другой ретрит можно выбрать потом в окне брони.'
            : q).replace('{retreat}', Layout.getName(r)).replace('{dates}', DateUtils.formatRange(r.start_date, r.end_date));
        if (!confirm(text)) return;
        update.retreat_id = null;
    }

    const { error } = await Layout.db
        .from('residents')
        .update(update)
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }
    warnOutsideRetreat(update.retreat_id === null ? null : oldRetreatId, checkIn, checkOut);

    // Даты брони — охват всех её мест, иначе список броней покажет старые даты
    const bookingId = currentResident.rawData.booking_id;
    if (bookingId) {
        const { data: beds } = await Layout.db
            .from('residents')
            .select('check_in, check_out')
            .eq('booking_id', bookingId)
            .neq('status', 'cancelled');
        if (beds?.length) {
            const ins = beds.map(b => b.check_in).filter(Boolean).sort();
            const outs = beds.map(b => b.check_out).filter(Boolean).sort();
            await Layout.db
                .from('bookings')
                .update({ check_in: ins[0], ...(outs.length ? { check_out: outs[outs.length - 1] } : {}) })
                .eq('id', bookingId);
        }
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Показать экран выбора номера для перемещения
async function showMoveScreen() {
    if (!currentResident) return;

    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('moveScreen').classList.remove('hidden');
    document.getElementById('editDatesScreen').classList.add('hidden');
    document.getElementById('checkoutScreen').classList.add('hidden');
    document.getElementById('moveGuestName').textContent = currentResident.name;

    // Загружаем список номеров
    const roomsList = document.getElementById('roomsList');
    roomsList.innerHTML = `<div class="text-center py-4">${t('timeline_loading')}</div>`;

    const res = currentResident.rawData;
    const checkIn = res.check_in;
    const checkOut = res.check_out || '2099-12-31'; // если нет даты выезда

    // Получаем здания, номера и текущих резидентов
    const [buildingsData, residentsRes] = await Promise.all([
        Cache.getOrLoad('buildings_with_rooms', async () => {
            const { data, error } = await Layout.db.from('buildings')
                .select('*, rooms(*)')
                .eq('is_active', true)
                .order('sort_order');
            if (error) { console.error('Error loading buildings:', error); return null; }
            return data;
        }, 3600000),
        Layout.db
            .from('residents')
            .select('room_id, check_in, check_out')
            .in('status', ['confirmed', 'booked'])
            .neq('id', currentResident.id) // исключаем текущего резидента
            .lte('check_in', checkOut)
            .or(`check_out.is.null,check_out.gte.${checkIn}`)
    ]);

    // Порядок и набор — как в сетке шахматки: сначала наши здания, потом временные,
    // и временные — только если их аренда пересекается с датами гостя
    const buildings = (buildingsData || [])
        .filter(b => !b.is_temporary || (b.available_from <= checkOut && b.available_until >= checkIn))
        .sort((a, b) => (a.is_temporary ? 1 : 0) - (b.is_temporary ? 1 : 0) || (a.sort_order || 0) - (b.sort_order || 0));
    const residents = residentsRes.data || [];

    if (buildings.length === 0) {
        roomsList.innerHTML = `<div class="text-center py-4 text-gray-500">${t('timeline_no_rooms')}</div>`;
        return;
    }

    // Считаем пиковую одновременную занятость через sweep line
    const roomResidents = {};
    residents.forEach(r => {
        if (!roomResidents[r.room_id]) roomResidents[r.room_id] = [];
        roomResidents[r.room_id].push(r);
    });
    const roomOccupancy = {};
    for (const [roomId, resList] of Object.entries(roomResidents)) {
        const events = [];
        resList.forEach(r => {
            events.push({ date: r.check_in, delta: 1 });
            events.push({ date: r.check_out || '2099-12-31', delta: -1 });
        });
        // По дате, при равенстве сначала выезды (-1) потом заезды (+1)
        events.sort((a, b) => a.date.localeCompare(b.date) || a.delta - b.delta);
        let cur = 0, peak = 0;
        for (const e of events) {
            cur += e.delta;
            if (cur > peak) peak = cur;
        }
        roomOccupancy[roomId] = peak;
    }

    const currentRoomId = res.room_id;

    let html = '';
    buildings.forEach(building => {
        const rooms = (building.rooms?.filter(r => r.is_active) || [])
            .sort((a, b) => {
                if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
                return a.number.localeCompare(b.number, undefined, { numeric: true });
            });
        if (rooms.length === 0) return;

        html += `<div class="collapse collapse-arrow bg-base-200 rounded-lg">
            <input type="checkbox" checked />
            <div class="collapse-title font-medium py-2">${Layout.getName(building)}</div>
            <div class="collapse-content p-0">
                <div class="grid grid-cols-3 gap-1 p-2">`;

        rooms.forEach(room => {
            const isCurrent = room.id === currentRoomId;
            const occupied = roomOccupancy[room.id] || 0;
            const capacity = room.capacity || 1;
            const isFull = occupied >= capacity;

            let btnClass, label, disabled;

            if (isCurrent) {
                btnClass = 'btn-disabled bg-gray-200';
                label = `${room.number} ←`;
                disabled = true;
            } else if (isFull) {
                btnClass = 'btn-disabled bg-red-100 text-red-400';
                label = `${room.number} (${occupied}/${capacity})`;
                disabled = true;
            } else if (occupied > 0) {
                btnClass = 'btn-outline btn-warning';
                label = `${room.number} (${occupied}/${capacity})`;
                disabled = false;
            } else {
                btnClass = 'btn-outline btn-success';
                label = room.number;
                disabled = false;
            }

            html += `<button class="btn btn-sm ${btnClass}"
                ${disabled ? 'disabled' : `data-action="move-to-room" data-id="${room.id}"`}>
                ${label}
            </button>`;
        });

        html += `</div></div></div>`;
    });

    roomsList.innerHTML = html;
}

// Перенос резидента в другой номер
async function moveToRoom(newRoomId) {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const { error } = await Layout.db
        .from('residents')
        .update({ room_id: newRoomId, has_housing: true })
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// === Модалка управления уборкой ===
let currentCleaning = null;

function openCleaningModal(cleaningId) {
    const cleaningData = cleaningsMap.get(cleaningId);
    if (!cleaningData) {
        console.error('Cleaning not found:', cleaningId);
        return;
    }

    currentCleaning = cleaningData;
    const raw = cleaningData.rawData;

    // Локация
    document.getElementById('cleaningModalLocation').textContent =
        `${cleaningData.buildingName} → ${t('timeline_room')} ${cleaningData.roomName}`;

    // Даты
    document.getElementById('cleaningStartDate').value = raw.start_date;
    document.getElementById('cleaningEndDate').value = raw.end_date;

    // Показываем/скрываем элементы в зависимости от статуса и прав
    const isCompleted = cleaningData.isCompleted;
    const canManageCleaning = window.hasPermission?.('manage_cleaning') ?? false;
    document.getElementById('cleaningCompletedStatus').classList.toggle('hidden', !isCompleted);
    // Скрываем действия если нет прав или уборка уже выполнена
    document.getElementById('cleaningActions').classList.toggle('hidden', isCompleted || !canManageCleaning);

    document.getElementById('cleaningModal').showModal();
}

// Уборка выполнена — помечаем как выполненную (перекрашивается в зелёный)
async function completeCleaning() {
    if (!currentCleaning) return;
    if (!window.hasPermission?.('manage_cleaning')) return;

    // Для автоуборки — ставим флаг cleaning_done в residents
    if (currentCleaning.isAuto || currentCleaning.isAutoCleaning) {
        const { error } = await Layout.db
            .from('residents')
            .update({ cleaning_done: true })
            .eq('id', currentCleaning.residentId);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('cleaningModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    // Для ручной уборки — помечаем как выполненную
    const { error } = await Layout.db
        .from('room_cleanings')
        .update({ completed: true, completed_at: new Date().toISOString() })
        .eq('id', currentCleaning.cleaningId);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('cleaningModal').close();
    await loadTimelineData();
    renderTable();
}

// Продлить уборку — обновляем дату окончания (ручная) или создаём новую запись (авто)
async function extendCleaning() {
    if (!currentCleaning) return;
    if (!window.hasPermission?.('manage_cleaning')) return;

    const newEndDate = document.getElementById('cleaningEndDate').value;
    if (!newEndDate) {
        alert(Layout.t('select_new_checkout_date'));
        return;
    }

    const raw = currentCleaning.rawData;

    // Для автоуборки — создаём новую запись в room_cleanings
    if (currentCleaning.isAuto || currentCleaning.isAutoCleaning) {
        const { error } = await Layout.db
            .from('room_cleanings')
            .insert({
                room_id: raw.room_id,
                start_date: raw.start_date,
                end_date: newEndDate
            });

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }
    } else {
        // Для ручной уборки — обновляем существующую запись
        const { error } = await Layout.db
            .from('room_cleanings')
            .update({ end_date: newEndDate })
            .eq('id', currentCleaning.cleaningId);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }
    }

    document.getElementById('cleaningModal').close();
    await loadTimelineData();
    renderTable();
}

// Удалить уборку (скрыть совсем, в отличие от "Выполнена" которая делает зелёной)
async function deleteCleaning() {
    if (!currentCleaning) return;
    if (!window.hasPermission?.('manage_cleaning')) return;

    // Для автоуборки — помечаем как пропущенную (скрываем)
    if (currentCleaning.isAuto || currentCleaning.isAutoCleaning) {
        const { error } = await Layout.db
            .from('residents')
            .update({ cleaning_skipped: true })
            .eq('id', currentCleaning.residentId);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('cleaningModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    // Для ручной уборки — удаляем из БД
    const { error } = await Layout.db
        .from('room_cleanings')
        .delete()
        .eq('id', currentCleaning.cleaningId);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('cleaningModal').close();
    await loadTimelineData();
    renderTable();
}

// Превратить бронирование в заселение
async function convertToCheckin() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const res = currentResident.rawData;

    // Если это бронирование с уже привязанным человеком (status='booked') —
    // просто меняем статус на confirmed без открытия формы
    // Человек в броне уже назван — заселение сводится к отметке о приезде,
    // переспрашивать имя незачем.
    if (!res.arrived_at && (res.vaishnava_id || res.guest_name)) {
        const update = { status: 'confirmed', arrived_at: new Date().toISOString() };
        // Приехал позже брони — дни до приезда он не жил и не ел: предлагаем сдвинуть начало
        const today = DateUtils.toISO(new Date());
        if (res.check_in < today && (!res.check_out || res.check_out >= today)) {
            const q = tf('timeline_late_arrival_shift', 'По плану заезд %s. Сдвинуть начало проживания на сегодня?')
                .replace('%s', formatDisplayDate(res.check_in));
            if (confirm(q)) {
                update.check_in = today;
                if (res.meal_start_date && res.meal_start_date < today) update.meal_start_date = today;
            }
        }
        const { error } = await Layout.db
            .from('residents')
            .update(update)
            .eq('id', currentResident.id);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('residentModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    // Закрываем модалку резидента
    document.getElementById('residentModal').close();

    // Открываем модалку заселения с предзаполненными данными
    modalContext = {
        roomId: res.room_id,
        residentId: currentResident.id,
        isConversion: true,
        bookingRetreatId: res.retreat_id || null
    };

    // Показываем форму заселения
    document.getElementById('actionScreen').classList.add('hidden');
    document.getElementById('checkinScreen').classList.remove('hidden');
    document.getElementById('bookingScreen').classList.add('hidden');

    // Источник виден в форме (ТЗ 01.10, п. 8): «Заселение по брони: Группа …»
    const bookingName = res.bookings?.name || res.bookings?.contact_name;
    document.getElementById('checkinLocation').textContent =
        document.getElementById('residentModalLocation').textContent
        + (bookingName ? ` · ${tf('timeline_checkin_by_booking', 'Заселение по брони')}: ${bookingName}` : '');
    document.getElementById('checkinDateIn').value = res.check_in;
    document.getElementById('checkinDateOut').value = res.check_out || '';

    // Сбрасываем форму
    document.getElementById('checkinForm').reset();
    // Заселяют позже брони — начало с сегодняшнего дня (дата в форме видна и правится)
    const todayIso = DateUtils.toISO(new Date());
    document.getElementById('checkinDateIn').value =
        res.check_in < todayIso && (!res.check_out || res.check_out >= todayIso) ? todayIso : res.check_in;
    document.getElementById('checkinDateOut').value = res.check_out || '';

    if (res.early_checkin) {
        document.querySelector('#checkinForm [name="early_checkin"]').checked = true;
    }
    if (res.late_checkout) {
        document.querySelector('#checkinForm [name="late_checkout"]').checked = true;
    }
    // Питание перенеслось с брони: если при бронировании завтрак сняли,
    // заселение не должно втихую вернуть его обратно.
    document.querySelector('#checkinForm [name="breakfast"]').checked = res.breakfast !== false;
    document.querySelector('#checkinForm [name="lunch"]').checked = res.lunch !== false;

    clearVaishnavSelection();
    // Ретрит, категория и примечание — с брони (ТЗ 01.10, п. 8). Ставим после сброса
    // выбора вайшнава: тот пересчитывал ретрит и стирал ретрит брони — отсюда путаница.
    // «Выбран вручную», чтобы подсказка по регистрации его не перебила; поля правятся.
    const retreatSel = document.getElementById('checkinRetreat');
    fillRetreatSelect(res.retreat_id || '');
    if (res.retreat_id) retreatSel.dataset.touched = '1';
    else delete retreatSel.dataset.touched;
    const catSel = document.getElementById('checkinCategory');
    if (res.category_id && catSel?.querySelector(`option[value="${res.category_id}"]`)) catSel.value = res.category_id;
    const notes = res.notes || res.bookings?.notes;
    if (notes) document.querySelector('#checkinForm [name="notes"]').value = notes;
    const hint = document.getElementById('checkinRetreatHint');
    if (hint && res.retreat_id) hint.textContent = tf('timeline_retreat_from_booking', 'из брони');

    document.getElementById('actionModal').showModal();
}

// ==================== ПОИСК ПО ШАХМАТКЕ ====================

// Текущий запрос поиска
let _searchQuery = '';
// Ищем по имени и по департаменту: «кухня» подсветит всех, кто едет в Кухню, и покажет их число
const guestMatchesSearch = guest => `${guest.name} ${guest.dept || ''}`.toLowerCase().includes(_searchQuery);

function onTimelineSearch(query) {
    _searchQuery = query.trim().toLowerCase();
    if (_searchQuery.length < 2) {
        clearTimelineSearch();
        return;
    }

    // Собираем ID совпавших гостей
    const matchedIds = new Set();
    for (const [id, guest] of guestsMap) {
        if (guestMatchesSearch(guest)) {
            matchedIds.add(id);
        }
    }

    // Разворачиваем свёрнутые здания/комнаты, если в них есть совпадения
    let needRerender = false;
    for (const id of matchedIds) {
        const guest = guestsMap.get(id);
        if (!guest?.rawData?.room_id) continue;
        const roomId = guest.rawData.room_id;

        // Ищем building по room_id
        for (const building of timelineData.buildings) {
            const room = building.rooms.find(r => r.id === roomId);
            if (room) {
                if (collapsedBuildings.has(building.id)) {
                    collapsedBuildings.delete(building.id);
                    needRerender = true;
                }
                if (collapsedRooms.has(room.id)) {
                    collapsedRooms.delete(room.id);
                    needRerender = true;
                }
                break;
            }
        }
    }

    if (needRerender) {
        renderTable(); // applySearchHighlight вызовется внутри
    } else {
        applySearchHighlight();
    }
}

function applySearchHighlight() {
    if (!_searchQuery || _searchQuery.length < 2) return;

    const matchedIds = new Set();
    for (const [id, guest] of guestsMap) {
        if (guestMatchesSearch(guest)) {
            matchedIds.add(id);
        }
    }

    const bars = document.querySelectorAll('.guest-bar');
    let firstMatch = null;

    bars.forEach(bar => {
        const id = bar.dataset.id;
        if (matchedIds.has(id)) {
            bar.classList.add('search-highlight');
            bar.classList.remove('search-dim');
            if (!firstMatch) firstMatch = bar;
        } else {
            bar.classList.add('search-dim');
            bar.classList.remove('search-highlight');
        }
    });

    // Счётчик
    const countEl = document.getElementById('searchCount');
    if (countEl) {
        if (matchedIds.size > 0) {
            countEl.textContent = matchedIds.size;
            countEl.classList.remove('hidden');
        } else {
            countEl.textContent = '0';
            countEl.classList.remove('hidden');
        }
    }

    // Прокрутка к первому совпадению
    if (firstMatch) {
        firstMatch.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
}

function clearTimelineSearch() {
    _searchQuery = '';
    document.querySelectorAll('.guest-bar.search-highlight, .guest-bar.search-dim').forEach(bar => {
        bar.classList.remove('search-highlight', 'search-dim');
    });
    const countEl = document.getElementById('searchCount');
    if (countEl) countEl.classList.add('hidden');
}

// Рендер таблицы
// Рендер полосы ретритов (отдельно от таблицы)
function renderRetreats() {
    const container = document.getElementById('retreatsScroll');
    if (!container) return;

    let html = '';

    // Половинки дней (как в таблице — 2 на день)
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        html += '<div class="retreat-half day-start"></div>';
        html += '<div class="retreat-half"></div>';
    }

    // Плашки ретритов (ВГ 08.10): цвет — из настроек ретрита, без цвета — прежний зелёный.
    // Ретрит, который ни с кем не пересекается, — во всю высоту. Пересекающиеся — каждый
    // одной сплошной полосой на своей дорожке, дорожки делят высоту поровну.
    const BAND_HEIGHT = 34;
    const sorted = [...timelineData.retreats].sort((a, b) => a.startDay - b.startDay || b.endDay - a.endDay);
    const laneEnds = [];       // последний занятый день каждой дорожки
    let cluster = [], clusterEnd = -1;
    const closeCluster = () => {
        const lanes = Math.max(...cluster.map(r => r.lane)) + 1;
        cluster.forEach(r => { r.lanes = lanes; });
        cluster = []; laneEnds.length = 0;
    };
    sorted.forEach(r => {
        if (cluster.length && r.startDay > clusterEnd) closeCluster();
        let lane = laneEnds.findIndex(end => end < r.startDay);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(r.endDay); } else laneEnds[lane] = r.endDay;
        r.lane = lane;
        cluster.push(r);
        clusterEnd = Math.max(clusterEnd, r.endDay);
    });
    if (cluster.length) closeCluster();
    sorted.forEach(r => {
        // Позиция: каждая половина = 24px + 1px border, первая половина ещё +2px border-left
        // Упрощённо: startDay * (24+1+24+1) + 2 для border-left
        const left = r.startDay * CELL_WIDTH * 2 + 2; // +2 для первой границы
        const spanDays = r.endDay - r.startDay + 1;
        const width = spanDays * CELL_WIDTH * 2 - 4;
        const h = Math.floor(BAND_HEIGHT / r.lanes);
        const gap = r.lanes > 1 ? 1 : 0;
        const font = r.lanes > 1 ? 'font-size: 12px;' : '';
        html += `<div class="retreat-chip" title="${e(r.name)} · ${e(r.dates)}" style="left: ${left}px; width: ${width}px; top: ${r.lane * h}px; height: ${h - gap}px; line-height: ${h - gap}px; ${font} background: ${Utils.safeColor(r.color, '#10b981')};">${e(r.name)}</div>`;
    });

    // Названия месяцев на первых числах
    const monthNamesArr = DateUtils.monthNames[Layout.currentLang] || DateUtils.monthNames.ru;
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        const date = getDateForDay(day);
        if (date.getDate() === 1) {
            const left = day * CELL_WIDTH * 2 + 2;
            html += `<div class="month-label" style="left: ${left}px;">${monthNamesArr[date.getMonth()].toUpperCase()}</div>`;
        }
    }

    container.innerHTML = html;
}

// Синхронизация скролла ретритов с таблицей
function syncScroll() {
    const tableContainer = document.getElementById('tableContainer');
    const retreatsScroll = document.getElementById('retreatsScroll');
    if (!tableContainer || !retreatsScroll) return;

    tableContainer.addEventListener('scroll', () => {
        retreatsScroll.style.transform = `translateX(-${tableContainer.scrollLeft}px)`;
    });
}

function renderTable() {
    const table = document.getElementById('timelineTable');

    let html = '<thead>';

    // Строка с числами
    html += `<tr class="row-dates"><th class="sticky-col">
        <div class="flex gap-1">
            <button class="btn btn-xs btn-ghost opacity-60 hover:opacity-100" data-action="collapse-all-buildings" title="${t('timeline_collapse_all')}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 9H4m16 6H4" /></svg>
            </button>
            <button class="btn btn-xs btn-ghost opacity-60 hover:opacity-100" data-action="collapse-all-rooms" title="${t('timeline_collapse_rooms')}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" /></svg>
            </button>
            <button class="btn btn-xs btn-ghost opacity-60 hover:opacity-100" data-action="expand-all" title="${t('timeline_expand_all')}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
            </button>
        </div>
    </th>`;
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        const date = getDateForDay(day);
        const weekend = isWeekend(day) ? 'weekend' : '';
        const today = day === TODAY_INDEX ? 'today' : '';
        const ekadashi = isEkadashi(day) ? 'ekadashi' : '';
        html += `<th colspan="2" class="day-start ${weekend} ${today} ${ekadashi}">${date.getDate()}</th>`;
    }
    html += '</tr>';

    // Строка с днями недели
    html += '<tr class="row-weekdays"><th class="sticky-col"></th>';
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        const weekend = isWeekend(day) ? 'weekend' : '';
        const today = day === TODAY_INDEX ? 'today' : '';
        const ekadashi = isEkadashi(day) ? 'ekadashi' : '';
        html += `<th colspan="2" class="day-start ${weekend} ${today} ${ekadashi}">${getWeekdayName(day)}</th>`;
    }
    html += '</tr>';

    html += '</thead><tbody>';

    // Калибровочная строка для фиксации ширины колонок
    html += '<tr class="row-calibration"><td class="sticky-col"></td>';
    for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
        html += '<td class="half-day"></td>';
    }
    html += '</tr>';

    // Здания
    timelineData.buildings.forEach(building => {
        const buildingCollapsed = collapsedBuildings.has(building.id);
        const arrowClass = buildingCollapsed ? 'collapsed' : '';

        // Заголовок здания
        const tempBadge = building.isTemporary ? ' <span style="font-size: 10px; color: #d97706;">⏱</span>' : '';
        const tempClass = building.isTemporary ? ' temporary' : '';
        html += `<tr class="row-building${tempClass}">`;
        html += `<td class="sticky-col" data-action="toggle-building" data-id="${building.id}">`;
        html += `<span class="toggle-arrow ${arrowClass}">▼</span> ${building.name}${tempBadge}</td>`;
        for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
            const dayIndex = Math.floor(col / 2);
            const isFirstHalf = col % 2 === 0;
            const dayStart = isFirstHalf ? 'day-start' : '';

            // Для временных зданий закрашиваем ячейки вне периода аренды
            const isOutsideRental = building.isTemporary &&
                ((building.availableFromDay !== null && dayIndex < building.availableFromDay)
                 || (building.availableUntilDay !== null && dayIndex > building.availableUntilDay));

            if (isOutsideRental) {
                html += `<td class="${dayStart}" style="background: #d1d5db;"></td>`;
            } else {
                html += `<td class="${dayStart}"></td>`;
            }
        }
        html += '</tr>';

        // Номера (скрыты если здание свёрнуто)
        building.rooms.forEach(room => {
            const roomCollapsed = collapsedRooms.has(room.id);
            const roomArrowClass = roomCollapsed ? 'collapsed' : '';
            const hiddenClass = buildingCollapsed ? 'collapsed' : '';

            // Заголовок номера — показываем сводку по занятости
            html += `<tr class="row-room ${hiddenClass}">`;
            html += `<td class="sticky-col" data-action="toggle-room" data-id="${room.id}">`;
            html += `<span class="toggle-arrow ${roomArrowClass}">▼</span> ${t('timeline_room')} ${room.name}</td>`;

            // Вычисляем сегменты занятости только для свёрнутых номеров
            let segments = [];
            let totalBeds = room.beds.length;

            if (roomCollapsed) {
                const allGuests = room.beds.flatMap(bed =>
                    bed.guests.filter(g => !g.isCleaning)
                );

                let currentSegment = null;

                for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
                    const occupying = allGuests.filter(g => {
                        const gStart = g.startDay * 2 + g.startHalf;
                        const gEnd = g.endDay * 2 + g.endHalf;
                        return col >= gStart && col <= gEnd;
                    });

                    const occupiedCount = occupying.length;
                    const ids = occupying.map(g => g.id).sort().join(',');

                    if (currentSegment && currentSegment.ids === ids) {
                        currentSegment.endCol = col;
                    } else {
                        if (currentSegment && currentSegment.count > 0) {
                            segments.push(currentSegment);
                        }
                        if (occupiedCount > 0) {
                            currentSegment = {
                                startCol: col,
                                endCol: col,
                                count: occupiedCount,
                                ids: ids,
                                guests: occupying
                            };
                        } else {
                            currentSegment = null;
                        }
                    }
                }
                if (currentSegment && currentSegment.count > 0) {
                    segments.push(currentSegment);
                }
            }

            // Рендерим ячейки строки номера
            for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
                const dayIndex = Math.floor(col / 2);
                const halfIndex = col % 2;
                const isFirstHalf = halfIndex === 0;
                const dayStart = isFirstHalf ? 'day-start' : '';

                // Проверка: для временных зданий закрашиваем ячейки вне периода аренды
                const isOutsideRental = building.isTemporary &&
                    ((building.availableFromDay !== null && dayIndex < building.availableFromDay) || (building.availableUntilDay !== null && dayIndex > building.availableUntilDay));

                if (isOutsideRental) {
                    html += `<td class="${dayStart}" style="background: #e5e7eb; pointer-events: none;"></td>`;
                    continue;
                }

                html += `<td class="${dayStart}">`;

                // Показываем сводку только когда номер свёрнут
                if (roomCollapsed) {
                    const segment = segments.find(s => s.startCol === col);
                    if (segment) {
                        const spanCells = segment.endCol - segment.startCol + 1;
                        const width = spanCells * CELL_WIDTH - 2;

                        const firstGuest = segment.guests[0];
                        const bgColor = firstGuest?.color || '#3b82f6';
                        const isBooking = segment.guests.some(g => g.isBooking);
                        const isCheckedOut = segment.guests.some(g => g.isCheckedOut);
                        const isPartial = segment.count < totalBeds;

                        let label = '';
                        if (totalBeds === 1) {
                            // Одноместный номер — показываем имя
                            label = firstGuest.name;
                        } else {
                            // Многоместный номер — всегда показываем дробь
                            label = `<span class="fraction">${segment.count}/${totalBeds}</span>`;
                        }

                        const bookingClass = isBooking ? 'booking' : '';
                        const checkedOutClass = isCheckedOut ? ' checked-out' : '';
                        const style = isBooking
                            ? `width: ${width}px; --bar-color: ${bgColor}; border-color: ${bgColor};`
                            : `width: ${width}px; background: ${bgColor};`;

                        html += `<div class="room-summary-bar ${bookingClass}${checkedOutClass}" style="${style}">${label}</div>`;
                    }
                }

                // Рендерим уборки на строке номера (всегда, независимо от сворачивания)
                const cleaning = (room.cleanings || []).find(c =>
                    c.startDay === dayIndex && c.startHalf === halfIndex
                );
                if (cleaning) {
                    const startCol = cleaning.startDay * 2 + cleaning.startHalf;
                    const endCol = cleaning.endDay * 2 + cleaning.endHalf;
                    const spanCells = Math.max(1, endCol - startCol + 1);
                    const width = spanCells * CELL_WIDTH - 2;
                    const completedClass = cleaning.isCompleted ? ' completed' : '';
                    const typeClass = cleaning.type === 'linen' ? ' linen' : '';
                    html += `<div class="cleaning-bar clickable${completedClass}${typeClass}" style="width: ${width}px;" data-action="open-cleaning-modal" data-id="${cleaning.cleaningId}">${cleaning.name}</div>`;
                }

                html += '</td>';
            }
            html += '</tr>';

            // Места (скрыты если здание или номер свёрнуты)
            const bedsHiddenClass = (buildingCollapsed || roomCollapsed) ? 'collapsed' : '';

            room.beds.forEach(bed => {
                const bedLabel = bed.name ? `${t('timeline_bed')} ${bed.name}` : '';
                html += `<tr class="row-bed ${bedsHiddenClass}"><td class="sticky-col">${bedLabel}</td>`;

                // Всегда рендерим все ячейки (DAYS_TO_SHOW * 2)
                for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
                    const dayIndex = Math.floor(col / 2);
                    const halfIndex = col % 2;
                    const isFirstHalf = halfIndex === 0;
                    const dayStart = isFirstHalf ? 'day-start' : '';
                    const weekend = isWeekend(dayIndex) ? 'weekend' : '';
                    const today = dayIndex === TODAY_INDEX ? 'today' : '';
                    const ekadashi = isEkadashi(dayIndex) ? 'ekadashi' : '';

                    // Проверка: для временных зданий закрашиваем ячейки вне периода аренды
                    const isOutsideRental = building.isTemporary &&
                        ((building.availableFromDay !== null && dayIndex < building.availableFromDay) || (building.availableUntilDay !== null && dayIndex > building.availableUntilDay));

                    if (isOutsideRental) {
                        html += `<td class="half-day ${dayStart}" style="background: #e5e7eb; pointer-events: none;"></td>`;
                        continue;
                    }

                    // Проверяем есть ли гость начинающийся здесь
                    const guest = bed.guests.find(g =>
                        g.startDay === dayIndex && g.startHalf === halfIndex
                    );

                    // Экранируем кавычки в именах
                    const bName = building.name.replace(/'/g, "\\'");
                    const rName = room.name.replace(/'/g, "\\'");
                    const bedName = bed.name.replace(/'/g, "\\'");

                    html += `<td class="half-day clickable ${dayStart} ${weekend} ${today} ${ekadashi}" data-action="open-action-modal" data-day-index="${dayIndex}" data-room-id="${room.id}" data-building-name="${bName}" data-room-name="${rName}" data-bed-name="${bedName}" data-half-index="${halfIndex}">`;

                    // Если здесь начинается гость — добавляем плашку
                    // (уборки теперь рендерятся на строке номера, не на строке места)
                    if (guest && !guest.isCleaning) {
                        const startCol = guest.startDay * 2 + guest.startHalf;
                        const endCol = guest.endDay * 2 + guest.endHalf;
                        const spanCells = Math.max(1, endCol - startCol + 1);
                        const width = spanCells * CELL_WIDTH - 2; // минус отступы
                        const checkedOutClass = guest.isCheckedOut ? ' checked-out' : '';

                        const debtClass = (guest.hasDebt ? ' has-debt' : '') + (guest.isDealCancelled ? ' deal-cancelled' : '');
                        const cancelRaw = t('timeline_deal_cancelled');
                        const cancelHtml = guest.isDealCancelled
                            ? `<span class="cancel-badge" title="${e(t('timeline_deal_cancelled_hint') === 'timeline_deal_cancelled_hint' ? 'Сделка в CRM отменена — освободите место' : t('timeline_deal_cancelled_hint'))}">${e(cancelRaw === 'timeline_deal_cancelled' ? 'Отмена' : cancelRaw)}</span>`
                            : '';
                        const selfLabelRaw = t('timeline_self_guest');
                        const selfLabel = selfLabelRaw === 'timeline_self_guest' ? 'Гость без события — приехал не на ретрит и не на мероприятие' : selfLabelRaw;
                        // Место после «$» и «◆» — там же, где буквы ретрита: у гостя без ретрита вместо них человечек
                        const selfHtml = guest.isSelf
                            ? `<span class="self-mark" title="${Layout.escapeHtml(selfLabel)}">${SELF_ICON}</span>`
                            : '';
                        // Значок «$»: красный — участник должен, зелёный — должны мы.
                        // Клик ведёт в финансы участника (суммы шахматке недоступны)
                        const debtDot = balanceBadge(guest.rawData, guest.hasDebt, guest.hasCredit);
                        // Бытовые потребности — не финансовый маркер: ромбик с подсказкой (ТЗ 2.3)
                        const needsDot = guest.specialNeeds ? `<span class="needs-dot" title="${Layout.escapeHtml(guest.specialNeeds)}">◆</span>` : '';
                        const tagHtml = guest.retreatTag
                            ? `<span class="retreat-tag" title="${Layout.escapeHtml(guest.retreatTag.name)}">${Layout.escapeHtml(guest.retreatTag.tag)}</span>`
                            : '';
                        // «Имя · Кухня» и значок примечания с текстом в подсказке
                        const barLabel = e(guest.name)
                            + (guest.dept ? `<span class="opacity-80"> · ${e(guest.dept)}</span>` : '')
                            + (guest.note ? NOTE_ICON : '');
                        const noteTitle = guest.note ? ` title="${e(guest.note)}"` : '';
                        const awayHtml = awayHatchHtml(guest.rawData?.id, startCol, spanCells);
                        if (guest.isBooking) {
                            // Бронирование — штриховка
                            const bgColor = guest.color || '#3b82f6';
                            html += `<div class="guest-bar booking${checkedOutClass}${debtClass}" style="width: ${width}px; --bar-color: ${bgColor}; border-color: ${bgColor};" data-action="open-resident-from-map" data-id="${guest.id}"${noteTitle}>${cancelHtml}${debtDot}${needsDot}${tagHtml}${selfHtml}${barLabel}${awayHtml}</div>`;
                        } else {
                            // Обычное заселение
                            const bgColor = guest.color || '#3b82f6';
                            const borderColor = guest.border || '#facc15';
                            html += `<div class="guest-bar${checkedOutClass}${debtClass}" style="width: ${width}px; background: ${bgColor}; border-color: ${borderColor};" data-action="open-resident-from-map" data-id="${guest.id}"${noteTitle}>${cancelHtml}${debtDot}${needsDot}${tagHtml}${selfHtml}${barLabel}${awayHtml}</div>`;
                        }
                    }

                    html += '</td>';
                }

                html += '</tr>';
            });
        });
    });

    // Разделитель «Самостоятельное проживание» на всю ширину: отделяет живущих в номерах
    // от живущих вне ашрама; надпись прилеплена слева и не уезжает при прокрутке вбок
    html += `<tr class="row-self-divider"><td colspan="${DAYS_TO_SHOW * 2 + 1}"><div class="self-divider-label">${e(tf('timeline_self_block', 'Самостоятельное проживание'))}</div></td></tr>`;
    html += SELF_BLOCKS.map(([kind]) => renderSelfGroupHtml(kind)).join('');

    html += '</tbody>';
    table.innerHTML = html;

    // Повторно применить подсветку поиска после перерисовки
    if (_searchQuery) applySearchHighlight();

    // Полоса ретритов — отдельный div: левый отступ = фактической ширине колонки номеров,
    // иначе при широкой колонке плашки ретритов съезжают относительно дат
    const firstCol = table.querySelector('th.sticky-col');
    const label = document.querySelector('.retreats-label');
    if (firstCol && label) {
        const w = firstCol.getBoundingClientRect().width + 'px';
        label.style.width = w;
        label.style.minWidth = w;
    }
}

// Перезагрузка данных и рендеринг
async function reload() {
    Layout.showLoader();
    await Promise.all([
        loadTimelineData(),
        loadDictionaries()
    ]);
    renderRetreats();
    renderTable();
    syncScroll();
    renderMonthPicker();
    Layout.hideLoader();
}

// Выбор месяца: от года назад до двух лет вперёд от сегодняшнего дня; текущий месяц
// шахматки (baseDate) всегда есть в списке, даже если ушли за эти границы стрелками
function renderMonthPicker() {
    const sel = document.getElementById('monthPicker');
    if (!sel) return;
    const keyOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const now = new Date();
    const keys = new Map();
    for (let i = -12; i <= 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        keys.set(keyOf(d), d);
    }
    const current = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
    keys.set(keyOf(current), current);
    const locale = Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU';
    sel.innerHTML = [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, d]) => {
        const month = d.toLocaleDateString(locale, { month: 'short' }).replace('.', '');
        const label = `${month} ${d.getFullYear()}`;
        return `<option value="${key}" ${key === keyOf(current) ? 'selected' : ''}>${label.charAt(0).toUpperCase() + label.slice(1)}</option>`;
    }).join('');
}

function pickMonth(value) {
    const [y, m] = value.split('-').map(Number);
    baseDate = new Date(y, m - 1, 1);
    reload().then(() => {
        const tableContainer = document.getElementById('tableContainer');
        if (tableContainer) tableContainer.scrollLeft = 0;
    });
}

// Сдвиг на месяц вперёд или назад
function shiftMonth(direction) {
    baseDate.setMonth(baseDate.getMonth() + direction);
    reload();
}

// Сброс к сегодняшнему дню
async function resetToToday() {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
    baseDate.setDate(baseDate.getDate() - 2);

    await reload();

    // Сбросить скролл к началу ПОСЛЕ перерисовки
    setTimeout(() => {
        const tableContainer = document.getElementById('tableContainer');
        if (tableContainer) {
            tableContainer.scrollLeft = 0;
        }
    }, 100);
}

// Инициализация
// ==================== ДЕЛЕГИРОВАНИЕ КЛИКОВ ====================
function setupTimelineDelegation() {
    // Окно проживания: подсказка «вне дат ретрита»
    const info = document.getElementById('residentInfo');
    if (info && !info._delegated) {
        info._delegated = true;
        info.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action]');
            if (!el) return;
            if (el.dataset.action === 'split-retreat') splitOffRetreat(el.dataset.side);
            if (el.dataset.action === 'dismiss-outside' && currentResident) {
                dismissOutside(currentResident.id);
                document.getElementById('outsideRetreatAlert')?.remove();
            }
            // Кнопка «Уезжает на время / Изменить» стоит в строке «Питание по дням», не в блоке действий
            if (el.dataset.action === 'meal-days') showMealDaysScreen();
        });
    }
    // Делегирование для таблицы таймлайна
    const table = document.getElementById('timelineTable');
    if (table && !table._delegated) {
        table._delegated = true;
        table.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action]');
            if (!el) return;
            ev.stopPropagation();
            const { action, id } = el.dataset;
            switch (action) {
                case 'toggle-building': toggleBuilding(id); break;
                case 'toggle-room': toggleRoom(id); break;
                case 'collapse-all-buildings': collapseAllBuildings(); break;
                case 'collapse-all-rooms': collapseAllRooms(); break;
                case 'expand-all': expandAll(); break;
                case 'open-action-modal':
                    openActionModal(
                        Number(el.dataset.dayIndex),
                        el.dataset.roomId,
                        el.dataset.buildingName,
                        el.dataset.roomName,
                        el.dataset.bedName,
                        Number(el.dataset.halfIndex)
                    );
                    break;
                case 'open-resident-from-map': openResidentFromMap(id, ev); break;
                case 'add-self-stay': openSelfStayModal(el.dataset.kind); break;
                case 'open-self-stay': openSelfStay(id); break;
                case 'toggle-self-group':
                    if (expandedSelfGroups.has(id)) expandedSelfGroups.delete(id); else expandedSelfGroups.add(id);
                    renderTable();
                    break;
                case 'self-group-arrived': markSelfGroupArrived(id); break;
                case 'open-meal-group': openMealGroup(id, el, ev); break;
                case 'open-meal-group-day': openMealGroup(id, el, ev, el.dataset.d); break;
                case 'open-finance':
                    window.open(el.dataset.href || `../finance/participants.html?retreat=${el.dataset.retreat}&open=${el.dataset.person}`, '_blank');
                    break;
                case 'open-cleaning-modal': openCleaningModal(id); break;
            }
        });
    }

    // Делегирование для кнопок действий с резидентом
    const residentActions = document.getElementById('residentActions');
    if (residentActions && !residentActions._delegated) {
        residentActions._delegated = true;
        residentActions.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            switch (btn.dataset.action) {
                case 'convert-to-checkin': convertToCheckin(); break;
                case 'edit-booking': openBookingEdit(); break;
                case 'show-move-screen': showMoveScreen(); break;
                case 'no-show': showNoShowScreen(); break;
                case 'checkout-resident': showCheckoutScreen(); break;
                case 'show-edit-dates-screen': showEditDatesScreen(); break;
                case 'meal-days': showMealDaysScreen(); break;
                case 'delete-resident': deleteResident(); break;
            }
        });
    }

    // Делегирование для списка комнат при перемещении
    const roomsList = document.getElementById('roomsList');
    if (roomsList && !roomsList._delegated) {
        roomsList._delegated = true;
        roomsList.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action="move-to-room"]');
            if (btn) moveToRoom(btn.dataset.id);
        });
    }
}

// Люди без номера (room_id пуст): живут вне территории, но записаны на ретрит
// или в группу и питаются с нами. Сетка их не рисует, поэтому показываем списком.
// Из CRM: менеджеры ставят в чеклисте сделки «Сам организует» (checklist_accommodation = 'self'),
// и отдельно в шахматку таких людей никто не заносит. Даты и питание — из регистрации на ретрит
// (приезд/отъезд, иначе даты ретрита). Кто уже есть в шахматке на эти даты (с номером или без), не дублируем.
const REG_STATUS_CATEGORY = {
    team: '10c4c929-6aaf-4b73-a15a-b7c5ab70f64b',
    guest: GUEST_CATEGORY_ID,
    volunteer: 'cdb7a43e-51a8-47cd-ac97-c6fdf4fccd5e',
    vip: 'ab57efc9-504a-4a31-93e6-6de8daa46bb7'
};

async function loadCrmSelfAccommodated() {
    const ids = periodRetreats.map(r => r.id);
    if (!ids.length) return [];
    const { data: deals, error } = await Layout.db.from('crm_deals')
        .select('vaishnava_id, retreat_id, vaishnavas!crm_deals_vaishnava_id_fkey(id, first_name, last_name, spiritual_name)')
        .eq('checklist_accommodation', 'self')
        .neq('status', 'cancelled')
        .in('retreat_id', ids);
    // У сделки три ссылки на vaishnavas (гость, менеджер, рекомендатель) — связь указана явно
    if (error) console.error('CRM self accommodation:', error);
    if (error || !deals?.length) return [];

    const vIds = [...new Set(deals.map(d => d.vaishnava_id).filter(Boolean))];
    const { data: regs } = await Layout.db.from('retreat_registrations')
        .select('vaishnava_id, retreat_id, status, meal_type, arrival_datetime, departure_datetime')
        .in('retreat_id', ids)
        .in('vaishnava_id', vIds)
        .eq('is_deleted', false)
        .neq('status', 'cancelled');
    const regMap = new Map((regs || []).map(r => [`${r.vaishnava_id}_${r.retreat_id}`, r]));

    const seen = new Set();
    return deals.flatMap(d => {
        const key = `${d.vaishnava_id}_${d.retreat_id}`;
        const reg = regMap.get(key);
        const retreat = periodRetreats.find(r => r.id === d.retreat_id);
        if (!reg || !retreat || seen.has(key)) return [];   // без регистрации — не едет
        seen.add(key);
        const checkIn = reg.arrival_datetime?.slice(0, 10) || retreat.start_date;
        const checkOut = reg.departure_datetime?.slice(0, 10) || retreat.end_date;
        const inTimeline = periodResidents.some(r => r.vaishnava_id === d.vaishnava_id
            && r.check_in <= checkOut && (r.check_out || checkOut) >= checkIn);
        if (inTimeline) return [];
        return [{
            vaishnava_id: d.vaishnava_id,
            vaishnavas: d.vaishnavas,
            retreat_id: d.retreat_id,
            check_in: checkIn,
            check_out: checkOut,
            has_meals: reg.meal_type !== 'self',
            // цвет категории берётся при отрисовке: справочник грузится параллельно
            category_id: REG_STATUS_CATEGORY[reg.status] || GUEST_CATEGORY_ID,
            fromCrm: true
        }];
    });
}

// Группа «Самостоятельное проживание» — строки как у мест в номерах: полоса по датам с именем
// и «(питается)». Цвет свой (светлый, с полоской категории слева), чтобы не путать с заселением.
function renderSelfGroupHtml(kind) {
    const groupId = kind === 'team' ? SELF_TEAM_ID : SELF_GROUP_ID;
    const stays = selfStays.filter(r => selfKind(r) === kind);
    const collapsed = collapsedBuildings.has(groupId);
    const blockLabel = selfBlockLabel(kind);
    const canEdit = canEditTimeline();
    const crmRaw = t('timeline_self_from_crm');
    const crmHint = crmRaw === 'timeline_self_from_crm' ? 'Из сделки в CRM: «Сам организует»' : crmRaw;

    // Подблок под разделителем — «Гости: N» / «Команда: N» и «+ Добавить» в одну строку; если не
    // влезает в колонку, надпись выходит поверх серых клеток справа ровно на свою длину
    const shortLabel = kind === 'team'
        ? tf('timeline_self_sub_team', 'Команда')
        : tf('timeline_self_sub_guests', 'Гости');
    const hint = `${blockLabel}. ${tf('timeline_self_header_hint', 'Живут вне ашрама. Здесь можно добавить человека или бронь.')}`;
    let html = `<tr class="row-building row-self"><td class="sticky-col" data-action="toggle-building" data-id="${groupId}" title="${e(hint)}">`
        + `<span class="self-head"><span class="toggle-arrow ${collapsed ? 'collapsed' : ''}">▼</span> ${e(shortLabel)}: ${stays.length}`
        + (canEdit ? ` <button type="button" class="btn btn-xs btn-outline btn-primary self-add-btn" data-action="add-self-stay" data-kind="${kind}">+ ${e(tf('timeline_self_add', 'Добавить'))}</button>` : '')
        + '</span></td>';
    for (let col = 0; col < DAYS_TO_SHOW * 2; col++) html += `<td class="${col % 2 === 0 ? 'day-start' : ''}"></td>`;
    html += '</tr>';

    // Полоса по датам: [первая колонка, ширина] или null, если вне видимого периода
    const span = (from, to) => {
        let startDay = dateToDayIndex(from);
        let endDay = to ? dateToDayIndex(to) : DAYS_TO_SHOW - 1;
        if (startDay > DAYS_TO_SHOW - 1 || endDay < 0) return null;
        const startHalf = startDay < 0 ? 0 : 1;
        const endHalf = endDay > DAYS_TO_SHOW - 1 ? 1 : 0;
        startDay = Math.max(0, startDay);
        endDay = Math.min(DAYS_TO_SHOW - 1, endDay);
        const startCol = startDay * 2 + startHalf;
        return [startCol, Math.max(1, endDay * 2 + endHalf - startCol + 1) * CELL_WIDTH - 2];
    };
    const row = (labelHtml, labelTitle, startCol, bar, extraClass = '') => {
        let tr = `<tr class="row-bed ${extraClass} ${collapsed ? 'collapsed' : ''}"><td class="sticky-col text-xs truncate" title="${e(labelTitle)}">${labelHtml}</td>`;
        for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
            const dayIndex = Math.floor(col / 2);
            const cls = [col % 2 === 0 ? 'day-start' : '', isWeekend(dayIndex) ? 'weekend' : '',
                dayIndex === TODAY_INDEX ? 'today' : '', isEkadashi(dayIndex) ? 'ekadashi' : ''].join(' ');
            tr += `<td class="half-day ${cls}">${col === startCol ? bar : ''}</td>`;
        }
        return tr + '</tr>';
    };
    const mealsText = v => v === true ? t('timeline_meals_yes') : v === false ? t('timeline_meals_no') : t('timeline_meals_unknown');
    const mealsCls = v => (v === true ? ' meals-yes' : v === false ? ' meals-no' : '') + (kind === 'team' ? ' self-staff' : '');

    const stayRow = (res, seatLabel) => {
        const sp = span(res.check_in, res.check_out);
        if (!sp) return '';
        const [startCol, width] = sp;
        const name = selfSeatName(res);
        const cat = res.resident_categories || categories.find(c => c.id === res.category_id);
        const catColor = Utils.isValidColor(cat?.color) ? cat.color : '#3b82f6';
        const retreat = res.retreat_id ? allRetreats.find(r => r.id === res.retreat_id) : null;
        const tag = res.retreat_id ? retreatTags.get(res.retreat_id) : null;
        const meals = mealsText(res.has_meals);
        // Бронь без номера: заезд ещё не отмечен — пунктиром, как бронь в номерах
        const booked = !res.fromCrm && !res.arrived_at;
        const dates = `${DateUtils.formatShort(res.check_in)} — ${res.check_out ? DateUtils.formatShort(res.check_out) : '…'}`;
        const dept = departmentName(res.department_id);
        const note = res.notes || res.bookings?.notes || '';
        const title = [name, dept, cat ? Layout.getName(cat) : '', retreat ? Layout.getName(retreat) : '', dates, meals,
            booked ? t('timeline_booking') : '', res.fromCrm ? crmHint : '', note].filter(Boolean).join(' · ');
        const badge = res.fromCrm ? '' : balanceBadge(res, debtorsSet.has(finKey(res)), creditorsSet.has(finKey(res)));
        const inner = `${badge}${tag && !seatLabel ? `<span class="retreat-tag">${e(tag.tag)}</span>` : ''}${e(name)}${dept ? `<span class="opacity-80"> · ${e(dept)}</span>` : ''}${note ? NOTE_ICON : ''}&nbsp;<span class="opacity-70">(${e(meals.toLowerCase())})</span>`
            + (res.fromCrm ? '<span class="self-crm">CRM</span>' : '');
        const cls = `guest-bar self-stay${mealsCls(res.has_meals)}${booked ? ' self-booked' : ''}`;
        const style = `width: ${width}px; --cat-color: ${catColor};`;
        // Своя запись — клик открывает окно проживания или брони (даты, заезд, «Не приехал»,
        // вписать имя в место); запись из CRM и без прав — карточка человека
        const bar = canEdit && !res.fromCrm
            ? `<div class="${cls} cursor-pointer" data-action="open-self-stay" data-id="${res.id}" style="${style}" title="${e(title)}">${inner}</div>`
            : res.vaishnava_id
            ? `<a class="${cls}" href="../vaishnavas/person.html?id=${res.vaishnava_id}" style="${style}" title="${e(title)}">${inner}</a>`
            : `<div class="${cls}" style="${style}" title="${e(title)}">${inner}</div>`;
        const label = seatLabel
            ? `<span class="self-seat-label opacity-70">${e(seatLabel)}</span>`
            : `<span class="opacity-70">${e(retreat ? Layout.getName(retreat) : '')}</span>`;
        return row(label, retreat ? Layout.getName(retreat) : '', startCol, bar);
    };

    // Питание группы по событию — сверху блока гостей: полоса на даты питания, без мелких чисел;
    // клик открывает таблицу по дням сразу на нужном дне (ВГ, 08.10.2026)
    if (kind === 'guests') for (const g of mealStrips) {
        const sp = span(g.start_date, g.end_date);
        if (!sp) continue;
        const [startCol, width] = sp;
        const retreat = allRetreats.find(r => r.id === g.retreat_id);
        const tag = retreatTags.get(g.retreat_id);
        const color = Utils.isValidColor(retreat?.color) ? retreat.color : '#8b5cf6';
        const who = g.by_day ? `${tf('mge_up_to', 'до')} ${g.people_count}` : String(g.people_count);
        const meals = g.by_day ? tf('mge_mode_days', 'По дням').toLowerCase()
            : [g.breakfast ? t('breakfast') : '', g.lunch ? t('lunch') : ''].filter(Boolean).join(', ').toLowerCase();
        const label = `${tf('mge_meals', 'Питание')}: ${g.name}`;
        const title = [label, retreat ? Layout.getName(retreat) : '', `${DateUtils.formatShort(g.start_date)} — ${DateUtils.formatShort(g.end_date)}`,
            `${who} ${tf('cost_people_short', 'чел.')}`, meals].filter(Boolean).join(' · ');
        const bar = `<div class="guest-bar self-stay meals-yes ${canEdit ? 'cursor-pointer' : ''}" ${canEdit ? `data-action="open-meal-group" data-id="${g.id}" data-start-col="${startCol}"` : ''}`
            + ` style="width: ${width}px; --cat-color: ${color};" title="${e(title)}">`
            + `${tag ? `<span class="retreat-tag">${e(tag.tag)}</span>` : ''}${e(label)} · ${e(who)}&nbsp;<span class="opacity-70">(${e(meals)})</span></div>`;
        const key = 'mg:' + g.id;
        const expanded = expandedSelfGroups.has(key);
        html += row(`<span data-action="toggle-self-group" data-id="${key}" class="cursor-pointer font-medium">`
            + `<span class="toggle-arrow ${expanded ? '' : 'collapsed'}">▼</span> ${e(label)}</span>`, title, startCol, bar);
        if (expanded) html += mealDayRows(g, canEdit);
    }

    // Групповая бронь без номера (ВГ, 01.10): одна строка «Группа X · N мест», под ней места —
    // с именами или «место k», у каждого свои даты. Кухня считает места, не строку группы
    const groups = new Map();
    for (const r of stays) if (r.booking_id && !r.fromCrm) {
        if (!groups.has(r.booking_id)) groups.set(r.booking_id, []);
        groups.get(r.booking_id).push(r);
    }
    for (const [id, seats] of groups) if (seats.length < 2) groups.delete(id);
    const done = new Set();
    stays.forEach(res => {
        const seats = res.booking_id && groups.get(res.booking_id);
        if (!seats) { html += stayRow(res); return; }
        if (done.has(res.booking_id)) return;
        done.add(res.booking_id);
        const ordered = selfBookingSeats(res.booking_id);
        const from = ordered.map(r => r.check_in).sort()[0];
        const to = ordered.some(r => !r.check_out) ? null : ordered.map(r => r.check_out).sort().pop();
        const sp = span(from, to);
        if (!sp) return;
        const [startCol, width] = sp;
        const b = res.bookings || {};
        const gname = b.name || b.contact_name || t('timeline_booking');
        const expanded = expandedSelfGroups.has(res.booking_id);
        const waiting = ordered.filter(r => !r.arrived_at).length;
        const eats = ordered.filter(r => r.has_meals !== false).length;
        const cat = res.resident_categories || categories.find(c => c.id === res.category_id);
        const catColor = Utils.isValidColor(cat?.color) ? cat.color : '#3b82f6';
        const retreat = res.retreat_id ? allRetreats.find(r => r.id === res.retreat_id) : null;
        const tag = res.retreat_id ? retreatTags.get(res.retreat_id) : null;
        const seatsText = Layout.pluralize(ordered.length, SEAT_FORMS);
        const mealsNote = eats === ordered.length ? t('timeline_meals_yes').toLowerCase()
            : `${t('timeline_meals_yes').toLowerCase()}: ${eats}`;
        const title = [gname, seatsText, retreat ? Layout.getName(retreat) : '',
            `${DateUtils.formatShort(from)} — ${to ? DateUtils.formatShort(to) : '…'}`, mealsNote,
            waiting ? `${t('timeline_booking')}: ${waiting}` : ''].filter(Boolean).join(' · ');
        const bar = `<div class="guest-bar self-stay self-group${mealsCls(eats ? true : false)}${waiting ? ' self-booked' : ''} cursor-pointer" data-action="toggle-self-group" data-id="${res.booking_id}" style="width: ${width}px; --cat-color: ${catColor};" title="${e(title)}">`
            + `${groupBalanceBadge(ordered)}${tag ? `<span class="retreat-tag">${e(tag.tag)}</span>` : ''}${e(gname)} · ${e(seatsText)}&nbsp;<span class="opacity-70">(${e(mealsNote)})</span></div>`;
        const label = `<span data-action="toggle-self-group" data-id="${res.booking_id}" class="cursor-pointer font-medium">`
            + `<span class="toggle-arrow ${expanded ? '' : 'collapsed'}">▼</span> ${e(gname)} · ${ordered.length}</span>`
            + (canEdit && waiting ? ` <button type="button" class="btn btn-xs btn-ghost text-primary px-1" data-action="self-group-arrived" data-id="${res.booking_id}" title="${e(tf('timeline_self_group_arrived_hint', 'Отметить заезд всем местам, где он ещё не отмечен'))}">${e(tf('timeline_self_group_arrived', 'Группа приехала'))}</button>` : '');
        html += row(label, title, startCol, bar);
        if (expanded) ordered.forEach((r, i) => {
            const named = (r.vaishnavas ? getVaishnavName(r.vaishnavas, '') : '') || r.guest_name;
            html += stayRow(r, named ? `${i + 1}. ${named}` : `${tf('timeline_self_seat', 'место')} ${i + 1}`);
        });
    });
    return html;
}

// Раскрытая полоса питания: строки «Завтраки» и «Обеды», в клетке дня — число (ВГ, 08.10.2026).
// День с примечанием поварам — с жёлтой меткой; клик по числу — окно на этом дне
function mealDayRows(g, canEdit) {
    const dayOf = d => g.by_day ? (g.days.get(d) || { b: 0, l: 0 })
        : { b: g.breakfast ? g.people_count : 0, l: g.lunch ? g.people_count : 0 };
    const line = (k, label) => {
        let tr = `<tr class="row-bed"><td class="sticky-col text-xs pl-6 opacity-80">${e(label)}</td>`;
        for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
            const dayIndex = Math.floor(col / 2);
            const cls = [col % 2 === 0 ? 'day-start' : '', isWeekend(dayIndex) ? 'weekend' : '',
                dayIndex === TODAY_INDEX ? 'today' : '', isEkadashi(dayIndex) ? 'ekadashi' : ''].join(' ');
            let cell = '';
            if (col % 2 === 0) {
                const dt = new Date(baseDate);
                dt.setDate(dt.getDate() + dayIndex);
                const d = DateUtils.toISO(dt);
                if (d >= g.start_date && d <= g.end_date) {
                    const v = dayOf(d);
                    const note = g.days?.get(d)?.note;
                    const n = v[k];
                    const tip = `${DateUtils.formatShort(d)} · ${label}: ${n}${note ? ' · ' + note : ''}`;
                    cell = `<div class="guest-bar self-stay meals-yes meal-day-cell${canEdit ? ' cursor-pointer' : ''}"${canEdit ? ` data-action="open-meal-group-day" data-id="${g.id}" data-d="${d}"` : ''}`
                        + ` style="width: ${CELL_WIDTH * 2 - 2}px; --cat-color: ${note ? '#f59e0b' : 'transparent'};" title="${e(tip)}">${n || ''}</div>`;
                }
            }
            tr += `<td class="half-day ${cls}">${cell}</td>`;
        }
        return tr + '</tr>';
    };
    return line('b', t('breakfast')) + line('l', t('lunch'));
}

// Клик по полосе питания группы: окно «Разового питания» на том дне, куда кликнули
function openMealGroup(id, bar, ev, day = null) {
    const g = mealStrips.find(x => x.id === id);
    if (!g) return;
    let focusDate = day;
    if (!focusDate) {
        const startCol = Number(bar.dataset.startCol) || 0;
        const x = ev.clientX - bar.getBoundingClientRect().left;
        const dayIndex = Math.floor((x + (startCol % 2) * CELL_WIDTH) / (2 * CELL_WIDTH)) + Math.floor(startCol / 2);
        const d = new Date(baseDate);
        d.setDate(d.getDate() + dayIndex);
        focusDate = DateUtils.toISO(d);
    }
    MealGroupEditor.open(g, {
        focusDate,
        onSaved: async () => { await loadTimelineData(); renderTable(); }
    });
}

// Места брони без номера по порядку (как созданы) — для «место k» и строки группы
function selfBookingSeats(bookingId) {
    return selfStays.filter(r => r.booking_id === bookingId && !r.fromCrm)
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id));
}

// Имя в блоке «Самостоятельное проживание»: человек, иначе «Группа X · место k»
function selfSeatName(res) {
    const name = (res.vaishnavas ? getVaishnavName(res.vaishnavas, '') : '') || res.guest_name;
    if (name) return name;
    const b = res.bookings;
    const gname = b ? (b.name || b.contact_name || '') : '';
    if (!res.booking_id || res.fromCrm) return gname || '—';
    const seats = selfBookingSeats(res.booking_id);
    if (seats.length < 2) return gname || '—';
    return `${gname} · ${tf('timeline_self_seat', 'место')} ${seats.findIndex(r => r.id === res.id) + 1}`;
}

// «Группа приехала»: заезд всем местам брони без номера, где он ещё не отмечен.
// Кто не приехал — потом «Не приехал / отказ» на его месте
async function markSelfGroupArrived(bookingId) {
    if (!canEditTimeline()) return;
    const seats = selfBookingSeats(bookingId).filter(r => !r.arrived_at);
    if (!seats.length) return;
    const gname = seats[0].bookings?.name || seats[0].bookings?.contact_name || '';
    const q = tf('timeline_self_group_arrived_confirm', 'Отметить заезд: %s, %n?')
        .replace('%s', gname).replace('%n', Layout.pluralize(seats.length, SEAT_FORMS));
    if (!confirm(q)) return;
    const { error } = await Layout.db.from('residents')
        .update({ status: 'confirmed', arrived_at: new Date().toISOString() })
        .in('id', seats.map(r => r.id))
        .is('arrived_at', null);
    if (error) { Layout.handleError(error, tf('timeline_self_group_arrived', 'Группа приехала')); return; }
    await loadTimelineData();
    renderTable();
}

// Гость прилетает раньше начала брони или улетает позже её конца — в эти ночи ему
// негде жить. Даты рейсов заполняет менеджер в чеклисте сделки, и до сих пор они
// никак не сверялись с бронью: расхождение всплывало на ресепшене в день заезда.
async function loadUncoveredNights() {
    const banner = document.getElementById('uncoveredBanner');
    if (!banner) return;

    const { data, error } = await Layout.db
        .from('v_placement_uncovered')
        .select('deal_id, guest_name, retreat_name, arrival_date, departure_date, check_in, check_out, nights_before, nights_after')
        .gte('retreat_end', formatDateYMD(new Date()))
        .order('nights_before', { ascending: false })
        .order('nights_after', { ascending: false });

    // Молча выходим: шахматка важнее сигнала, ронять её из-за него нельзя
    if (error || !data?.length) return;

    document.getElementById('uncoveredSummary').textContent =
        `⚠️ ${t('timeline_uncovered_title')}: ${data.length}`;

    document.getElementById('uncoveredList').innerHTML = data.map(r => {
        const gaps = [];
        if (r.nights_before) gaps.push(`${t('timeline_uncovered_before')} ${r.nights_before}`);
        if (r.nights_after)  gaps.push(`${t('timeline_uncovered_after')} ${r.nights_after}`);
        return `<div class="py-1 border-t border-warning/20">
            <a href="../crm/deal.html?id=${r.deal_id}" class="link link-hover font-medium">${e(r.guest_name || '—')}</a>
            <span class="opacity-60"> · ${e(r.retreat_name || '')}</span>
            <div class="text-xs opacity-70">
                ${t('timeline_uncovered_flights')}: ${DateUtils.formatShort(r.arrival_date)} — ${r.departure_date ? DateUtils.formatShort(r.departure_date) : '?'}
                · ${t('timeline_uncovered_booking')}: ${DateUtils.formatShort(r.check_in)} — ${DateUtils.formatShort(r.check_out)}
            </div>
            <div class="text-xs text-warning">${e(gaps.join(' · '))}</div>
        </div>`;
    }).join('');

    banner.classList.remove('hidden');
}

// Оповещение сверху: брони без отметки заезда после даты заезда (кухня считает их съевшими)
// и заселённые без выселения после даты выезда. Клик по имени — к брони в шахматке.
const ALERT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 inline -mt-0.5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

async function loadStayAlerts() {
    const banner = document.getElementById('stayAlertsBanner');
    if (!banner) return;
    const today = DateUtils.toISO(new Date());
    const cols = 'id, vaishnava_id, check_in, check_out, room_id, booking_id, guest_name, rooms(number), vaishnavas(first_name, last_name, spiritual_name), bookings(name, contact_name)';

    const [notArrivedRes, notOutRes] = await Promise.all([
        Layout.db.from('residents').select(cols)
            .in('status', ['confirmed', 'booked']).is('arrived_at', null)
            .lt('check_in', today).order('check_in'),
        Layout.db.from('residents').select(cols)
            .eq('status', 'confirmed').not('arrived_at', 'is', null)
            .lt('check_out', today).order('check_out')
    ]);
    // Молча выходим: шахматка важнее сигнала
    if (notArrivedRes.error || notOutRes.error) return;
    let notArrived = notArrivedRes.data || [];

    // Переезд новой бронью: человек уже живёт по предыдущей брони с отметкой заезда — это не «не заселён»
    const ids = [...new Set(notArrived.map(r => r.vaishnava_id).filter(Boolean))];
    if (ids.length) {
        const { data: lived } = await Layout.db.from('residents')
            .select('vaishnava_id, check_in, check_out')
            .in('vaishnava_id', ids).in('status', ['confirmed', 'checked_out'])
            .not('arrived_at', 'is', null);
        notArrived = notArrived.filter(r => !(lived || []).some(l => l.vaishnava_id === r.vaishnava_id
            && l.check_in < r.check_in && (!l.check_out || l.check_out >= r.check_in)));
    }
    const notOut = notOutRes.data || [];
    // Групповая бронь без номера — одной строкой «Группа X · N мест», а не N одинаковых имён
    const seatsOf = new Map();
    notArrived = notArrived.filter(r => {
        if (r.room_id || !r.booking_id || r.vaishnava_id || r.guest_name) return true;
        const first = seatsOf.get(r.booking_id);
        if (first) { first._seats++; return false; }
        r._seats = 1;
        seatsOf.set(r.booking_id, r);
        return true;
    });

    const person = (r, date, label) => {
        const name = ((r.vaishnavas ? getVaishnavName(r.vaishnavas, '') : '') || r.guest_name
            || r.bookings?.name || r.bookings?.contact_name || tf('timeline_no_name', 'Без имени'))
            + (r._seats > 1 ? ` · ${Layout.pluralize(r._seats, SEAT_FORMS)}` : '');
        const room = r.rooms?.number ? `, ${t('timeline_room')} ${e(r.rooms.number)}` : '';
        return `<a class="link link-hover font-medium" data-action="open-stay-alert" data-id="${r.id}" data-date="${date}">${e(name)}</a>`
            + `<span class="opacity-60"> (${e(label)} ${DateUtils.formatShort(date)}${room})</span>`;
    };
    const line = (title, rows, dateOf, label) => rows.length
        ? `<div>${ALERT_ICON} <span class="font-medium">${e(title)}: ${rows.length}</span> — `
            + rows.map(r => person(r, dateOf(r), label)).join(' · ') + '</div>'
        : '';

    banner.innerHTML =
        line(tf('timeline_not_arrived_title', 'Не заселены'), notArrived, r => r.check_in, tf('timeline_not_arrived_since', 'заезд с'))
        + line(tf('timeline_not_checked_out_title', 'Не выселены'), notOut, r => r.check_out, tf('timeline_not_checked_out_since', 'выезд был'));
    banner.classList.toggle('hidden', !notArrived.length && !notOut.length);

    if (!banner._delegated) {
        banner._delegated = true;
        banner.addEventListener('click', ev => {
            const a = ev.target.closest('[data-action="open-stay-alert"]');
            if (a) openStayAlert(a.dataset.id, a.dataset.date);
        });
    }
}

// Перейти в шахматке к дате брони и открыть её окно
async function openStayAlert(id, date) {
    const d = DateUtils.parseDate(date);
    d.setDate(d.getDate() - 2);
    baseDate = d;
    await reload();
    if (guestsMap.has(id)) openResidentFromMap(id);
    else {
        const seat = selfStays.find(r => r.id === id);
        if (seat?.booking_id) { expandedSelfGroups.add(seat.booking_id); renderTable(); }
        openSelfStay(id);
    }
}

async function init() {
    await Layout.init({ module: 'housing', menuId: 'reception', itemId: 'timeline' });
    Layout.showLoader();
    await Promise.all([
        loadTimelineData(),
        loadDictionaries()
    ]);
    renderRetreats();
    renderTable();
    syncScroll();
    renderMonthPicker();
    setupTimelineDelegation();
    Layout.hideLoader();

    loadUncoveredNights();   // не задерживает отрисовку шахматки
    loadStayAlerts();

    // Подписка на изменения в реальном времени
    subscribeToRealtime();
}

// Realtime: автоматическое обновление при изменениях в БД
function subscribeToRealtime() {
    const channel = Layout.db.channel('timeline-realtime');

    // Подписка на изменения в residents
    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'residents' },
        handleRealtimeChange
    );

    // Подписка на изменения в bookings
    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'bookings' },
        handleRealtimeChange
    );

    // Подписка на изменения в room_cleanings
    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'room_cleanings' },
        handleRealtimeChange
    );

    channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
            debug('Realtime: подключено к шахматке');
        }
    });
}

// Обработка изменений — перезагрузка данных с debounce
let realtimeTimeout = null;
function handleRealtimeChange(payload) {
    debug('Realtime изменение:', payload.table, payload.eventType);

    // Debounce: если несколько изменений подряд — ждём 500мс
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadTimelineData();
        renderTable();
        loadStayAlerts();
        Layout.showNotification(t('timeline_data_updated'), 'info');
    }, 500);
}

window.onLanguageChange = () => {
    Layout.updateAllTranslations();
    renderRetreats();
    renderTable();
    renderLegend();
};

init();
