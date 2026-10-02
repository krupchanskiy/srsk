/**
 * Проверка дат приезда/отъезда/рейсов против дат ретрита (ВГ 02.10.2026, после опечатки «2028»).
 * Три уровня:
 *  - в даты ретрита ±3 дня — молча;
 *  - раньше / позже — жёлтая плашка с числом дней, при сохранении — осознанное подтверждение;
 *  - невозможное (приезд после конца, отъезд до начала, отъезд раньше приезда) — запрет.
 *    Запрет продублирован в базе (миграция 609) — там он действует для всех мест ввода.
 * Внутренние ретриты (художники) идут, пока живут люди: «позже конца» у них не проверяется.
 * Подтверждение спрашивается только для изменённой даты — повторно открытая форма не переспрашивает.
 */
const DateGuard = (() => {
    const SLACK_DAYS = 3;      // ранний заезд / поздний выезд — правило «вариант 2»
    const PAIR_DAYS = 2;       // регистрация и рейс расходятся больше — предупреждение
    const DAY = 86400000;
    const cache = new Map();

    const fmt = d => d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '';
    const days = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / DAY);
    // datetime-local или timestamptz из базы — берём только дату, без сдвига пояса
    const dateOf = v => (v || '').slice(0, 10) || null;
    const ruDays = n => Layout.pluralize(n, { ru: ['день', 'дня', 'дней'], en: ['day', 'days'], hi: 'दिन' });

    // Ретрит с признаком «внутренний» (retreat_fact_end, миграция 605); кэш на страницу
    async function retreat(id) {
        if (!id) return null;
        if (cache.has(id)) return cache.get(id);
        const [{ data: r }, { data: f }] = await Promise.all([
            Layout.db.from('retreats').select('id, name_ru, name_en, name_hi, start_date, end_date').eq('id', id).maybeSingle(),
            Layout.db.from('retreat_fact_end').select('is_internal').eq('retreat_id', id).maybeSingle()
        ]);
        const res = r && r.start_date > '2001-01-01' ? { ...r, is_internal: !!f?.is_internal } : null;
        cache.set(id, res);
        return res;
    }

    /**
     * kind: 'arrival' | 'departure'; label — что за дата («Прилёт», «Приезд в ШРСК»)
     * → null (всё в порядке) | { level: 'warn' | 'block', text }
     */
    function check(value, kind, r, label) {
        const d = dateOf(value);
        if (!d || !r) return null;
        const range = `${fmt(r.start_date)}–${fmt(r.end_date)}`;
        const name = Layout.getName ? Layout.getName(r) : r.name_ru;
        const what = `${label} ${fmt(d)}`;
        if (kind === 'arrival' && d > r.end_date && !r.is_internal)
            return { level: 'block', text: `${what} — после окончания ретрита «${name}» (${range}). Проверьте месяц и год.` };
        if (kind === 'departure' && d < r.start_date)
            return { level: 'block', text: `${what} — до начала ретрита «${name}» (${range}). Проверьте месяц и год.` };
        const before = days(d, r.start_date);
        const after = r.is_internal ? 0 : days(r.end_date, d);
        if (before > SLACK_DAYS)
            return { level: 'warn', text: `${what} — на ${ruDays(before)} раньше начала ретрита «${name}» (${range}). Проверьте месяц и год.` };
        if (after > SLACK_DAYS)
            return { level: 'warn', text: `${what} — на ${ruDays(after)} позже окончания ретрита «${name}» (${range}). Проверьте месяц и год.` };
        return null;
    }

    // Отъезд раньше приезда — запрет; регистрация и рейс разошлись больше чем на 2 дня — предупреждение
    function checkOrder(arrival, departure, label) {
        const a = dateOf(arrival), d = dateOf(departure);
        if (a && d && (departure.slice(0, 16) < arrival.slice(0, 16)))
            return { level: 'block', text: `${label}: отъезд ${fmt(d)} раньше приезда ${fmt(a)}.` };
        return null;
    }
    function checkPair(flight, stay, kind) {
        const f = dateOf(flight), s = dateOf(stay);
        if (!f || !s) return null;
        const gap = Math.abs(days(f, s));
        if (gap <= PAIR_DAYS) return null;
        const what = kind === 'arrival' ? `Приезд в ШРСК ${fmt(s)} и прилёт ${fmt(f)}` : `Выезд из ШРСК ${fmt(s)} и вылет ${fmt(f)}`;
        return { level: 'warn', text: `${what} расходятся на ${ruDays(gap)}. Проверьте месяц и год.` };
    }

    // Плашка под полем (создаётся следом за input): жёлтая — предупреждение, красная — запрет
    function show(input, result) {
        if (!input) return;
        let box = input.parentElement.querySelector(':scope > .date-guard-msg');
        if (!box) {
            box = document.createElement('div');
            box.className = 'date-guard-msg text-xs mt-1 leading-snug';
            input.insertAdjacentElement('afterend', box);
        }
        box.textContent = result ? `⚠ ${result.text}` : '';
        box.classList.toggle('hidden', !result);
        box.classList.toggle('text-error', result?.level === 'block');
        box.classList.toggle('text-amber-700', result?.level === 'warn');
    }

    /**
     * Перед сохранением: results — проверки ИЗМЕНЁННЫХ дат (null пропускаются).
     * Запрет — сообщение и false; предупреждения — одно подтверждение на все.
     */
    function confirmSave(results) {
        const list = results.filter(Boolean);
        const blocked = list.find(r => r.level === 'block');
        if (blocked) {
            Layout.showNotification(blocked.text, 'error');
            return false;
        }
        const warns = list.filter(r => r.level === 'warn');
        if (!warns.length) return true;
        return confirm(warns.map(w => '⚠ ' + w.text).join('\n\n') + '\n\nДаты верны? «ОК» — сохранить, «Отмена» — исправить.');
    }

    // Изменилась ли дата относительно того, что было в базе (сравнение до минут)
    const changed = (value, original) => (value || '').slice(0, 16) !== (original || '').slice(0, 16);

    // Плашка сразу при вводе: getRetreat — async () => ретрит (или null — проверять не с чем)
    function bind(input, kind, label, getRetreat) {
        if (!input || input.dataset.dateGuard) return;
        input.dataset.dateGuard = '1';
        input.addEventListener('change', async () => {
            const r = await getRetreat();
            show(input, r ? check(input.value, kind, r, label) : null);
        });
    }

    /**
     * Окно рейсов регистрации («Предварительная», карточка человека): рейсы против ретрита,
     * вылет раньше прилёта, рейс и даты в ШРСК (если не «сразу из аэропорта») — только изменённое.
     * now/old: { arrFlight, depFlight, arrStay, depStay }; old — как было в базе ({} — новая запись).
     */
    async function confirmFlights(retreatObj, now, old, directArrival, directDeparture) {
        if (!retreatObj) return true;
        const r = (await retreat(retreatObj.id)) || retreatObj;
        const ch = k => changed(now[k], old[k]);
        return confirmSave([
            checkOrder(now.arrFlight, now.depFlight, 'Рейсы'),
            ch('arrFlight') && check(now.arrFlight, 'arrival', r, 'Прилёт'),
            ch('depFlight') && check(now.depFlight, 'departure', r, 'Вылет'),
            !directArrival && (ch('arrFlight') || ch('arrStay')) && checkPair(now.arrFlight, now.arrStay, 'arrival'),
            !directDeparture && (ch('depFlight') || ch('depStay')) && checkPair(now.depFlight, now.depStay, 'departure')
        ]);
    }

    return { retreat, check, checkOrder, checkPair, show, confirmSave, changed, bind, confirmFlights };
})();

window.DateGuard = DateGuard;
