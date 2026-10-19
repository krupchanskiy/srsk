/**
 * Загрузка отдела.
 *
 * Отвечает на вопросы, которые у старшего возникают при расстановке,
 * а по шахматке видны плохо: кто тянет больше всех, кого ни разу
 * не ставили, кто служит много дней подряд без перерыва, какая служба
 * закрывается тяжелее прочих.
 *
 * Считается по назначениям за выбранный период. Человек, который
 * в отъезде или выведен из отдела, клетку не закрывает — здесь он
 * тоже не считается тем, кто её нёс.
 */
const WorshipLoad = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const дней = n => Layout.pluralize(n, {
        ru: ['день', 'дня', 'дней'], en: ['day', 'days'], hi: 'दिन' });

    // служба до этого часа — ранняя: встать к ней тяжелее всего,
    // и именно их важно раздавать по кругу, а не одному человеку
    const РАННЯЯ_ДО = '06:30';

    let люди = [], службы = [], назначения = [], отметки = [], отклонения = [];
    let период = (() => {
        try { return localStorage.getItem('worship_load_period') || 'неделя'; }
        catch { return 'неделя'; }
    })();
    // команда и волонтёры несут службу по-разному: с команды спрос другой,
    // а волонтёр приехал на две недели — его загрузку смотрят отдельно
    let состав = (() => {
        try { return localStorage.getItem('worship_load_kind') || 'все'; }
        catch { return 'все'; }
    })();

    // ---------- период ----------
    function границы() {
        const сегодня = DateUtils.nowAshram();
        if (период === 'неделя') {
            const пн = new Date(сегодня);
            const сдвиг = (пн.getDay() + 6) % 7;        // неделя начинается с понедельника
            пн.setDate(пн.getDate() - сдвиг);
            const вс = new Date(пн);
            вс.setDate(вс.getDate() + 6);
            return { от: DateUtils.toISO(пн), до: DateUtils.toISO(вс), имя: 'за эту неделю' };
        }
        if (период === 'месяц') {
            const первое = new Date(сегодня.getFullYear(), сегодня.getMonth(), 1);
            const последнее = new Date(сегодня.getFullYear(), сегодня.getMonth() + 1, 0);
            return { от: DateUtils.toISO(первое), до: DateUtils.toISO(последнее), имя: 'за этот месяц' };
        }
        // «впереди»: от сегодня на четыре недели — ровно то, что уже расписано
        const конец = new Date(сегодня);
        конец.setDate(конец.getDate() + 27);
        return { от: DateUtils.toISO(сегодня), до: DateUtils.toISO(конец), имя: 'на четыре недели вперёд' };
    }

    // ---------- загрузка ----------
    // переключение периода быстрыми щелчками: ответ по прежнему периоду
    // не должен лечь поверх свежего
    let поколение = 0;

    async function загрузить() {
        const моё = ++поколение;
        const { от, до } = границы();

        const [л, с, н, о, откл] = await Promise.all([
            Layout.db.from('worship_people').select('id, vaishnava_id, is_active, active_from, active_to, kind'),
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, is_active')
                .order('time_of_day'),
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, person_id, role')
                .gte('duty_date', от).lte('duty_date', до).limit(2000),
            Layout.db.from('worship_absences').select('person_id, date_from, date_to'),
            Layout.db.from('worship_day_overrides')
                .select('id, duty_date, service_id, title, time_of_day')
                .gte('duty_date', от).lte('duty_date', до),
        ]);
        if (моё !== поколение) return false;
        const ошибка = л.error || с.error || н.error || о.error || откл.error;
        if (ошибка) { Layout.handleError(ошибка, 'Загрузка отдела'); return false; }

        let новые = л.data || [];
        const ids = новые.map(ч => ч.vaishnava_id).filter(Boolean);
        if (ids.length) {
            const { data } = await Layout.db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name').in('id', ids);
            if (моё !== поколение) return false;
            const карточки = Object.fromEntries((data || []).map(в => [в.id, в]));
            новые = новые.map(ч => {
                const в = карточки[ч.vaishnava_id] || {};
                return { ...ч, имя: в.spiritual_name
                    || `${в.first_name || ''} ${в.last_name || ''}`.trim() || 'без имени' };
            });
        }

        службы = с.data || [];
        назначения = н.data || [];
        отметки = о.data || [];
        отклонения = откл.data || [];
        люди = новые;
        return true;
    }

    // ---------- счёт ----------
    const вОтъезде = (id, день) => отметки.some(а => а.person_id === id
        && а.date_from <= день && (!а.date_to || а.date_to >= день));

    const человек = id => люди.find(ч => ч.id === id);

    /**
     * Назначение, которое и правда закрывает службу — по тем же правилам,
     * что и шахматка: человек в отделе, срок участия покрывает день, он не
     * в отъезде, а сама служба в этот день проводится. Назначение на
     * отменённую или снятую с расписания службу — не нагрузка.
     */
    const настоящее = н => {
        const ч = человек(н.person_id);
        if (!ч || ч.is_active === false || вОтъезде(ч.id, н.duty_date)) return false;
        if (ч.active_to && ч.active_to < н.duty_date) return false;
        if (ч.active_from && ч.active_from > н.duty_date) return false;
        if (н.service_id) {
            if (службы.find(с => с.id === н.service_id)?.is_active === false) return false;
            if (отменена(н.service_id, н.duty_date)) return false;
        }
        return true;
    };

    const времяСлужбы = н => службы.find(с => с.id === н.service_id)?.time_of_day
        || отклонения.find(о => о.id === н.override_id)?.time_of_day || '';

    /** Все дни периода — по ним считаем и дыры, и серии без перерыва. */
    function дниПериода() {
        const { от, до } = границы();
        const дни = [];
        const д = DateUtils.parseDate(от), конец = DateUtils.parseDate(до);
        while (д <= конец) { дни.push(DateUtils.toISO(д)); д.setDate(д.getDate() + 1); }
        return дни;
    }

    const отменена = (serviceId, день) => отклонения.some(о =>
        о.service_id === serviceId && !о.title && о.duty_date === день);

    /** Сколько клеток должно быть закрыто и сколько закрыто на деле. */
    function счётКлеток() {
        const активные = службы.filter(с => с.is_active);
        let надо = 0, закрыто = 0;
        for (const д of дниПериода()) {
            for (const с of активные) {
                if (отменена(с.id, д)) continue;
                надо++;
                if (назначения.some(н => н.duty_date === д && н.service_id === с.id && настоящее(н))) закрыто++;
            }
            for (const о of отклонения.filter(x => x.title && x.duty_date === д)) {
                надо++;
                if (назначения.some(н => н.duty_date === д && н.override_id === о.id && настоящее(н))) закрыто++;
            }
        }
        return { надо, закрыто };
    }

    /**
     * «Ни разу не поставлен» — упрёк только тому, кого было можно поставить:
     * волонтёр с истёкшим сроком или ещё не приехавший сюда не попадает.
     */
    const вОтделеВПериод = ч => {
        const { от, до } = границы();
        return ч.is_active !== false
            && (!ч.active_to || ч.active_to >= от)
            && (!ч.active_from || ч.active_from <= до);
    };

    const вСоставе = ч => состав === 'все' || (ч.kind || 'team') === состав;

    /** Сводка по каждому человеку отдела. */
    function поЛюдям() {
        return люди.filter(вСоставе).map(ч => {
            const свои = назначения.filter(н => н.person_id === ч.id && настоящее(н));
            const дни = [...new Set(свои.map(н => н.duty_date))].sort();
            return {
                ...ч,
                служб: свои.length,
                ранних: свои.filter(н => (времяСлужбы(н) || '99').slice(0, 5) < РАННЯЯ_ДО).length,
                помощником: свои.filter(н => н.role && н.role !== 'pujari').length,
                дней: дни.length,
                подряд: самаяДлиннаяСерия(дни),
            };
        }).sort((a, b) => b.служб - a.служб || a.имя.localeCompare(b.имя, 'ru'));
    }

    /** Сколько дней подряд человек служил без единого свободного дня. */
    function самаяДлиннаяСерия(дни) {
        let лучшая = 0, текущая = 0, прошлый = null;
        for (const д of дни) {
            // «следующий день» — по календарю, а не по 24 часам: в сутках
            // перехода на летнее время их 23 или 25, и серия рвалась
            const дата = DateUtils.parseDate(д);
            let подряд = false;
            if (прошлый) {
                const завтра = new Date(прошлый);
                завтра.setDate(завтра.getDate() + 1);
                подряд = DateUtils.toISO(завтра) === д;
            }
            текущая = подряд ? текущая + 1 : 1;
            лучшая = Math.max(лучшая, текущая);
            прошлый = дата;
        }
        return лучшая;
    }

    /** По службам: где чаще всего остаются дыры и кто её обычно несёт. */
    function поСлужбам() {
        const дни = дниПериода();
        return службы.filter(с => с.is_active).map(с => {
            let надо = 0, закрыто = 0;
            const носители = {};
            for (const д of дни) {
                if (отменена(с.id, д)) continue;
                надо++;
                const свои = назначения.filter(н => н.duty_date === д && н.service_id === с.id && настоящее(н));
                if (свои.length) закрыто++;
                свои.forEach(н => {
                    const имя = человек(н.person_id)?.имя;
                    if (имя) носители[имя] = (носители[имя] || 0) + 1;
                });
            }
            const чаще = Object.entries(носители).sort((a, b) => b[1] - a[1])[0];
            return {
                имя: Layout.getName(с), время: (с.time_of_day || '').slice(0, 5),
                надо, закрыто, дыр: надо - закрыто,
                основной: чаще ? `${чаще[0]} · ${чаще[1]}` : null,
            };
        }).sort((a, b) => b.дыр - a.дыр || a.время.localeCompare(b.время));
    }

    // ---------- отрисовка ----------
    function рисовать() {
        const { имя: названиеПериода } = границы();
        const { надо, закрыто } = счётКлеток();
        const строки = поЛюдям();
        const несущие = строки.filter(ч => ч.служб > 0);
        // среднее — по тем, кого показываем: иначе при выборе «волонтёры»
        // оно считалось бы от всех закрытых клеток отдела
        const ихСлужб = несущие.reduce((с, ч) => с + ч.служб, 0);
        const среднее = несущие.length ? ихСлужб / несущие.length : 0;
        const максимум = строки[0]?.служб || 0;

        document.querySelectorAll('[data-период]').forEach(б =>
            б.classList.toggle('btn-active', б.dataset.период === период));
        document.querySelectorAll('[data-состав]').forEach(б =>
            б.classList.toggle('btn-active', б.dataset.состав === состав));

        // ---- сводка ----
        $('#сводка').innerHTML = [
            ['Служб в расписании', надо, названиеПериода],
            ['Закрыто', надо ? `${Math.round(закрыто / надо * 100)}%` : '—',
                надо ? `${закрыто} из ${надо}` : 'расписания нет'],
            ['Несут службы', несущие.length,
                `из ${люди.filter(ч => вОтделеВПериод(ч) && вСоставе(ч)).length}${
                    состав === 'все' ? ' в отделе'
                        : состав === 'team' ? ' в команде' : ' среди волонтёров'}`],
            ['В среднем на человека', несущие.length ? дробь(среднее) : '—',
                несущие.length ? словоСлужб(среднее) : ''],
        ].map(([подпись, число, хвост]) => `
            <div class="rounded-xl shadow-sm px-3 py-3 sm:px-4" style="background: oklch(var(--b1));">
                <div class="надзаголовок" style="letter-spacing: .04em;">${e(подпись)}</div>
                <div class="text-2xl font-bold tabular-nums leading-tight mt-0.5">${e(String(число))}</div>
                <div class="text-sm opacity-70">${e(хвост)}</div>
            </div>`).join('');

        // ---- кто сколько несёт ----
        $('#люди').innerHTML = несущие.map(ч => `
            <li class="py-2.5 border-b border-base-200 last:border-0">
                <!-- имя и число — одной строкой, подробности под ними: на телефоне
                     число переносилось и висело посреди строки отдельно от имени -->
                <div class="flex items-baseline gap-3">
                    <a href="people.html?id=${ч.id}" class="link link-hover font-semibold flex-1 min-w-0">${e(ч.имя)}</a>
                    <span class="font-bold tabular-nums text-right">${ч.служб}</span>
                </div>
                <div class="text-sm opacity-70 tabular-nums">${
                    ч.ранних ? `из них ранних ${ч.ранних} · ` : ''}${
                    ч.помощником ? `помощником ${ч.помощником} · ` : ''}${
                    ч.подряд > 2 ? `${дней(ч.подряд)} подряд · ` : ''}${дней(ч.дней)} со службой</div>
                <!-- полоса на всю ширину: сравнивают соседей глазами, а не числа -->
                <div class="h-2 rounded-full mt-1.5" style="background: oklch(var(--b2));">
                    <div class="h-2 rounded-full" style="width: ${
                        максимум ? Math.round(ч.служб / максимум * 100) : 0}%;
                        background: var(--current-color);"></div>
                </div>
            </li>`).join('') || '<li class="py-4 text-sm opacity-70">За этот период никого не ставили</li>';

        // ---- кого не ставили ----
        const свободные = строки.filter(ч => !ч.служб && вОтделеВПериод(ч));
        $('#свободныеБлок').hidden = !свободные.length;
        $('#свободные').innerHTML = свободные.map(ч =>
            `<a href="people.html?id=${ч.id}" class="badge badge-outline">${e(ч.имя)}</a>`).join(' ');

        // ---- по службам ----
        $('#службы').innerHTML = поСлужбам().map(с => `
            <li class="py-2 border-b border-base-200 last:border-0
                       flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="text-sm opacity-70 tabular-nums w-12">${e(с.время)}</span>
                <span class="font-semibold">${e(с.имя)}</span>
                <span class="flex-1"></span>
                ${с.основной
                    ? `<span class="text-sm opacity-70">чаще всех — ${e(с.основной)}</span>` : ''}
                <span class="text-sm tabular-nums ${с.дыр ? 'text-warning font-semibold' : 'opacity-70'}">${
                    с.дыр ? `${с.дыр} без человека` : 'закрыта вся'}</span>
            </li>`).join('') || '<li class="py-3 text-sm opacity-70">Служб пока нет</li>';

        рисоватьНаходки(строки, несущие, среднее);
    }

    /**
     * Короткий список того, на что стоит посмотреть. Цифры выше показывают
     * положение дел, а это — места, где оно расходится со здравым смыслом.
     */
    /** 5,2 — с запятой, как пишут по-русски; целое — без «,0». */
    const дробь = x => (Math.round(x * 10) / 10).toString().replace('.', ',');
    /** «5,2 службы», но «5 служб»: дробь всегда в родительном единственного. */
    const словоСлужб = x => Number.isInteger(Math.round(x * 10) / 10)
        ? Layout.pluralize(Math.round(x), { ru: ['служба', 'службы', 'служб'], en: ['service', 'services'], hi: 'सेवा' })
              .replace(/^\d+\s*/, '')
        : 'службы';

    function рисоватьНаходки(строки, несущие, среднее) {
        const находки = [];

        const перегруженные = несущие.filter(ч => среднее >= 1 && ч.служб >= среднее * 1.8);
        if (перегруженные.length) {
            находки.push(`Больше других несут: <b>${перегруженные.map(ч => e(ч.имя)).join(', ')}</b> — `
                + `при среднем ${дробь(среднее)} ${словоСлужб(среднее)} на человека.`);
        }

        const безПерерыва = несущие.filter(ч => ч.подряд >= 5);
        if (безПерерыва.length) {
            находки.push(`Служат без единого свободного дня: `
                + безПерерыва.map(ч => `<b>${e(ч.имя)}</b> — ${дней(ч.подряд)} подряд`).join(', ') + '.');
        }

        const свободные = строки.filter(ч => !ч.служб && вОтделеВПериод(ч));
        if (свободные.length && несущие.length) {
            // имена, а не число: старшему нужно знать, кого звать
            находки.push(`Ни разу не поставлены: <b>${свободные.map(ч => e(ч.имя)).join(', ')}</b> — `
                + `нагрузку есть на кого разделить.`);
        }

        // ранние службы тяжелее прочих: если их тянет один человек, это видно
        const всегоРанних = несущие.reduce((с, ч) => с + ч.ранних, 0);
        const главныйПоРанним = [...несущие].sort((a, b) => b.ранних - a.ранних)[0];
        if (всегоРанних >= 4 && главныйПоРанним?.ранних >= всегоРанних * 0.6) {
            находки.push(`Ранние службы (до ${РАННЯЯ_ДО}) почти целиком на одном человеке: `
                + `<b>${e(главныйПоРанним.имя)}</b> — ${главныйПоРанним.ранних} из ${всегоРанних}.`);
        }

        $('#находкиБлок').hidden = !находки.length;
        $('#находки').innerHTML = находки.map(т => `
            <li class="py-2 border-b border-base-200 last:border-0 text-sm">${т}</li>`).join('');
    }

    async function init() {
        document.addEventListener('click', async ev => {
            const кнопка = ev.target.closest('[data-период]');
            if (кнопка) {
                период = кнопка.dataset.период;
                try { localStorage.setItem('worship_load_period', период); } catch { /* приватный режим */ }
                if (await загрузить()) рисовать();
                return;
            }
            const состав2 = ev.target.closest('[data-состав]');
            if (!состав2) return;
            состав = состав2.dataset.состав;
            try { localStorage.setItem('worship_load_kind', состав); } catch { /* приватный режим */ }
            рисовать();            // данные те же, меняется только разрез
        });

        if (!await загрузить()) return;
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
