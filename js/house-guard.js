/**
 * Бронь в Гостевом доме на ночи ретрита, который занимает его целиком
 * (retreats.occupies_guesthouse, миграция 668; ВГ 09.10.2026, случай Нарендры в БВПутешествии).
 * Не запрет — осознанное подтверждение:
 *  - бронь задевает ночь ретрита (с start_date до утра после end_date) — ⚠ «пересечение»;
 *  - выезд в день заезда ретрита / заезд в день разъезда — ℹ «успеете убрать?».
 * Только номера Гостевого дома; люди самого ретрита (retreat_id) не проверяются.
 * Вызывать только для новых мест и мест с изменёнными датами/номером — давно стоящие молчат.
 */
const HouseGuard = (() => {
    const GUEST_HOUSE_ID = '5fd72663-f118-4be4-80d7-155fb6264af7';   // «Гостевой дом»
    const DAY = 86400000;
    let loaded = null;

    const fmt = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const shift = (d, n) => DateUtils.toISO(new Date(DateUtils.parseDate(d).getTime() + n * DAY + 12 * 3600000));
    const nights = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / DAY);
    const ruNights = n => Layout.pluralize(n, { ru: ['ночь', 'ночи', 'ночей'], en: ['night', 'nights'], hi: 'रात' });

    // Ретриты «весь Гостевой дом» (ещё не закончившиеся) и номера Гостевого дома; кэш на страницу
    async function load() {
        if (loaded) return loaded;
        const today = DateUtils.toISO(new Date());
        const [rt, rm] = await Promise.all([
            Layout.db.from('retreats').select('id, name_ru, name_en, name_hi, start_date, end_date')
                .eq('occupies_guesthouse', true).gte('end_date', shift(today, -1)),
            Layout.db.from('rooms').select('id, number').eq('building_id', GUEST_HOUSE_ID)
        ]);
        // Не загрузилось — не мешаем бронировать
        if (rt.error || rm.error) return { retreats: [], rooms: new Map() };
        loaded = { retreats: rt.data || [], rooms: new Map((rm.data || []).map(r => [r.id, r.number])) };
        return loaded;
    }

    /**
     * rows: [{ room_id, check_in, check_out, retreat_id }] — что сейчас сохраняется.
     * → true (сохранять) | false (вернуться и исправить даты)
     */
    async function confirmSave(rows) {
        const { retreats, rooms } = await load();
        if (!retreats.length) return true;
        const cross = [], close = [];
        for (const row of rows) {
            if (!row?.room_id || !row.check_in || !rooms.has(row.room_id)) continue;
            const room = `№${rooms.get(row.room_id)}`;
            for (const r of retreats) {
                if (row.retreat_id === r.id) continue;
                const leave = shift(r.end_date, 1);              // разъезд — утро после end_date
                const name = Layout.getName ? Layout.getName(r) : r.name_ru;
                const what = `«${name}» (${fmt(r.start_date)}–${fmt(r.end_date)}, разъезд утром ${fmt(leave)})`;
                const out = row.check_out || null;
                if (row.check_in < leave && (!out || out > r.start_date)) {
                    const from = row.check_in > r.start_date ? row.check_in : r.start_date;
                    const to = out && out < leave ? out : leave;
                    cross.push(`${room}, ${fmt(row.check_in)} → ${out ? fmt(out) : '…'}: задевает ретрит ${what} — ${ruNights(nights(from, to))} (${fmt(from)} → ${fmt(to)}).`);
                } else if (out === r.start_date) {
                    close.push(`${room}: выезд ${fmt(out)} — в этот день заезжает ретрит ${what}.`);
                } else if (row.check_in === leave) {
                    close.push(`${room}: заезд ${fmt(leave)} — в этот день разъезжается ретрит ${what}.`);
                }
            }
        }
        if (!cross.length && !close.length) return true;
        const parts = [];
        if (cross.length) parts.push('⚠ Пересечение с ретритом — на эти ночи Гостевой дом занят:\n'
            + [...new Set(cross)].join('\n')
            + '\nБронируйте, только если точно знаете, что этот номер ретрит не займёт.');
        if (close.length) parts.push('ℹ Впритык к ретриту:\n' + [...new Set(close)].join('\n')
            + '\nУспеете убрать номер?');
        return confirm(parts.join('\n\n') + '\n\n«ОК» — всё равно забронировать, «Отмена» — изменить даты.');
    }

    /**
     * Уже стоящие брони Гостевого дома не из ретрита на его ночах, ещё не решённые
     * (residents.house_overlap_ok, 669) — для плашки шахматки. Места одной брони в номере — одной строкой.
     * → [{ ids, room, who, check_in, check_out, retreat, nights, from, to }]
     */
    async function pending() {
        const { retreats, rooms } = await load();
        if (!retreats.length) return [];
        const minStart = retreats.reduce((m, r) => r.start_date < m ? r.start_date : m, retreats[0].start_date);
        const maxEnd = retreats.reduce((m, r) => r.end_date > m ? r.end_date : m, retreats[0].end_date);
        const { data, error } = await Layout.db.from('residents')
            .select('id, room_id, booking_id, retreat_id, check_in, check_out, guest_name, vaishnavas(spiritual_name, first_name, last_name), bookings(name)')
            .in('room_id', [...rooms.keys()]).eq('status', 'confirmed').eq('house_overlap_ok', false)
            .lte('check_in', maxEnd).or(`check_out.is.null,check_out.gt.${minStart}`)
            .order('check_in');
        if (error) return [];
        const out = new Map();
        for (const row of data || []) for (const r of retreats) {
            if (row.retreat_id === r.id) continue;
            const leave = shift(r.end_date, 1);
            if (!(row.check_in < leave && (!row.check_out || row.check_out > r.start_date))) continue;
            const key = `${r.id}|${row.room_id}|${row.booking_id || row.id}|${row.check_in}|${row.check_out}`;
            const v = row.vaishnavas;
            const name = v?.spiritual_name || `${v?.first_name || ''} ${v?.last_name || ''}`.trim() || row.guest_name || '';
            const item = out.get(key);
            if (item) { item.ids.push(row.id); if (!item.who && name) item.who = name; continue; }
            const from = row.check_in > r.start_date ? row.check_in : r.start_date;
            const to = row.check_out && row.check_out < leave ? row.check_out : leave;
            out.set(key, { ids: [row.id], room: rooms.get(row.room_id), who: name || row.bookings?.name || '',
                check_in: row.check_in, check_out: row.check_out, retreat: r, nights: nights(from, to), from, to });
        }
        return [...out.values()];
    }

    // «Оставить как есть» — решено осознанно, плашка больше не показывает
    async function accept(ids) {
        const { error } = await Layout.db.from('residents').update({ house_overlap_ok: true }).in('id', ids);
        return error;
    }

    // Изменилось ли место относительно того, что было в базе
    const changed = (now, old) => !old || now.room_id !== old.room_id || now.check_in !== old.check_in
        || (now.check_out || null) !== (old.check_out || null) || (now.retreat_id || null) !== (old.retreat_id || null);

    return { confirmSave, changed, pending, accept, fmt, ruNights };
})();

window.HouseGuard = HouseGuard;
