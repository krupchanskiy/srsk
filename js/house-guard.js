/**
 * Бронь в Гостевом доме на ночи ретрита, который занимает его целиком
 * (retreats.occupies_guesthouse, миграция 668; ВГ 09.10.2026, случай Нарендры в БВПутешествии).
 * Не запрет — осознанное подтверждение:
 *  - бронь задевает время ретрита в номере — ⚠ «пересечение»;
 *  - выезд в день заезда ретрита / заезд в день отъезда — ℹ «впритык, успеете убрать?».
 * Время ретрита в номере (ВГ 09.10):
 *  - в номере уже стоят люди ретрита — их даты (от первого заезда до последнего выезда);
 *    например, выехали 28-го — заезд 29-го свободен;
 *  - людей ретрита в номере ещё нет — весь ретрит: с start_date до 10:00 утра после end_date
 *    (end_date — последний день, сутки оплачены до утра).
 * Только номера Гостевого дома; люди самого ретрита (retreat_id) не проверяются.
 * confirmSave — только для новых мест и мест с изменёнными датами/номером, давно стоящие — в плашке (pending).
 */
const HouseGuard = (() => {
    const GUEST_HOUSE_ID = '5fd72663-f118-4be4-80d7-155fb6264af7';   // «Гостевой дом»
    const DAY = 86400000;
    let loaded = null;

    const fmt = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const shift = (d, n) => DateUtils.toISO(new Date(DateUtils.parseDate(d).getTime() + n * DAY + 12 * 3600000));
    const nights = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / DAY);
    const ruNights = n => Layout.pluralize(n, { ru: ['ночь', 'ночи', 'ночей'], en: ['night', 'nights'], hi: 'रात' });
    const nameOf = r => Layout.getName ? Layout.getName(r) : r.name_ru;

    // Ретриты «весь Гостевой дом» (ещё не закончившиеся) и номера Гостевого дома — кэш на страницу;
    // где уже стоят люди ретрита — каждый раз заново (расселяют на этой же странице)
    async function load() {
        if (!loaded) {
            const today = DateUtils.toISO(new Date());
            const [rt, rm] = await Promise.all([
                Layout.db.from('retreats').select('id, name_ru, name_en, name_hi, start_date, end_date')
                    .eq('occupies_guesthouse', true).gte('end_date', shift(today, -1)),
                Layout.db.from('rooms').select('id, number').eq('building_id', GUEST_HOUSE_ID)
            ]);
            // Не загрузилось — не мешаем бронировать
            if (rt.error || rm.error) return { retreats: [], rooms: new Map(), placed: new Map() };
            loaded = { retreats: rt.data || [], rooms: new Map((rm.data || []).map(r => [r.id, r.number])) };
        }
        const placed = new Map();
        if (loaded.retreats.length) {
            const { data } = await Layout.db.from('residents').select('retreat_id, room_id, check_in, check_out')
                .in('retreat_id', loaded.retreats.map(r => r.id)).in('room_id', [...loaded.rooms.keys()])
                .in('status', ['confirmed', 'checked_out']);
            for (const p of data || []) {
                const r = loaded.retreats.find(x => x.id === p.retreat_id);
                const out = p.check_out || shift(r.end_date, 1);
                const key = `${p.retreat_id}|${p.room_id}`;
                const span = placed.get(key);
                if (!span) placed.set(key, { from: p.check_in, to: out });
                else { if (p.check_in < span.from) span.from = p.check_in; if (out > span.to) span.to = out; }
            }
        }
        return { ...loaded, placed };
    }

    /**
     * Место против ретрита → null | { kind: 'cross' | 'close', text, from, to, nights }
     * text — что за ретрит в этом номере и когда; from/to — ночи пересечения
     */
    function hit(row, r, placed) {
        if (row.retreat_id === r.id) return null;
        const span = placed.get(`${r.id}|${row.room_id}`);
        const claim = span || { from: r.start_date, to: shift(r.end_date, 1) };
        const what = span
            ? `в номере живут участники ретрита «${nameOf(r)}» (${fmt(span.from)} → ${fmt(span.to)})`
            : `ретрит «${nameOf(r)}» (${fmt(r.start_date)}–${fmt(r.end_date)}, отъезд до утра ${fmt(claim.to)})`;
        const out = row.check_out || null;
        if (row.check_in < claim.to && (!out || out > claim.from)) {
            const from = row.check_in > claim.from ? row.check_in : claim.from;
            const to = out && out < claim.to ? out : claim.to;
            return { kind: 'cross', text: what, from, to, nights: nights(from, to) };
        }
        const who = span ? `участники ретрита «${nameOf(r)}»` : `ретрит «${nameOf(r)}» (${fmt(r.start_date)}–${fmt(r.end_date)})`;
        if (out === claim.from)
            return { kind: 'close', text: `выезд ${fmt(out)} — в этот день ${span ? 'в номер заезжают' : 'заезжает'} ${who}` };
        if (row.check_in === claim.to)
            return { kind: 'close', text: `заезд ${fmt(row.check_in)} — в этот день ${span ? 'из номера уезжают' : 'уезжает'} ${who}` };
        return null;
    }

    /**
     * rows: [{ room_id, check_in, check_out, retreat_id }] — что сейчас сохраняется.
     * → true (сохранять) | false (вернуться и исправить даты)
     */
    async function confirmSave(rows) {
        const { retreats, rooms, placed } = await load();
        if (!retreats.length) return true;
        const cross = [], close = [];
        for (const row of rows) {
            if (!row?.room_id || !row.check_in || !rooms.has(row.room_id)) continue;
            const room = `№${rooms.get(row.room_id)}`;
            for (const r of retreats) {
                const h = hit(row, r, placed);
                if (h?.kind === 'cross') cross.push(`${room}, ${fmt(row.check_in)} → ${row.check_out ? fmt(row.check_out) : '…'}: ${h.text} — ${ruNights(h.nights)} (${fmt(h.from)} → ${fmt(h.to)}).`);
                else if (h) close.push(`${room}: ${h.text}.`);
            }
        }
        if (!cross.length && !close.length) return true;
        const parts = [];
        if (cross.length) parts.push('⚠ Пересечение с ретритом — номер на эти ночи нужен ретриту:\n'
            + [...new Set(cross)].join('\n')
            + '\nБронируйте, только если точно знаете, что этот номер ретрит не займёт.');
        if (close.length) parts.push('ℹ Впритык к ретриту:\n' + [...new Set(close)].join('\n')
            + '\nУспеете убрать номер? Уточните время приезда.');
        return confirm(parts.join('\n\n') + '\n\n«ОК» — всё равно забронировать, «Отмена» — изменить даты.');
    }

    /**
     * Уже стоящие брони Гостевого дома не из ретрита, задевающие ретрит или впритык к нему,
     * ещё не решённые (residents.house_overlap_ok, 669) — для плашки шахматки.
     * Места одной брони в номере — одной строкой; примечание — места или брони.
     * → [{ ids, room, who, note, check_in, check_out, retreat, kind, text, nights, from, to }]
     */
    async function pending() {
        const { retreats, rooms, placed } = await load();
        if (!retreats.length) return [];
        const minStart = retreats.reduce((m, r) => r.start_date < m ? r.start_date : m, retreats[0].start_date);
        const maxEnd = retreats.reduce((m, r) => r.end_date > m ? r.end_date : m, retreats[0].end_date);
        const { data, error } = await Layout.db.from('residents')
            .select('id, room_id, booking_id, retreat_id, check_in, check_out, guest_name, notes, vaishnavas(spiritual_name, first_name, last_name), bookings(name, notes)')
            .in('room_id', [...rooms.keys()]).eq('status', 'confirmed').eq('house_overlap_ok', false)
            .lte('check_in', shift(maxEnd, 1)).or(`check_out.is.null,check_out.gte.${minStart}`)
            .order('check_in');
        if (error) return [];
        const out = new Map();
        for (const row of data || []) for (const r of retreats) {
            const h = hit(row, r, placed);
            if (!h) continue;
            const key = `${r.id}|${row.room_id}|${row.booking_id || row.id}|${row.check_in}|${row.check_out}`;
            const v = row.vaishnavas;
            const name = v?.spiritual_name || `${v?.first_name || ''} ${v?.last_name || ''}`.trim() || row.guest_name || '';
            const item = out.get(key);
            if (item) {
                item.ids.push(row.id);
                if (!item.who && name) item.who = name;
                if (!item.note && row.notes) item.note = row.notes;
                continue;
            }
            out.set(key, { ids: [row.id], room: rooms.get(row.room_id), who: name || row.bookings?.name || '',
                note: row.notes || row.bookings?.notes || '', check_in: row.check_in, check_out: row.check_out,
                retreat: r, ...h });
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
