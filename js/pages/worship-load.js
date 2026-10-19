/**
 * Загрузка отдела.
 *
 * Главный вопрос старшего: кто тянет больше, а кто отлынивает. Голые
 * часы на него не отвечают — человек, полнедели бывший в отъезде, выглядел
 * бы бездельником. Поэтому каждого меряем нормой отдела за день на месте:
 * сколько в среднем несёт человек отдела в день, когда он здесь.
 *
 * Строка человека — семь дней недели с часами (видно и сегодня, и серии
 * без выходных, и пустые дни) и итог недели. Считается по тем же правилам,
 * что и шахматка: выбывший, уехавший или поставленный на отменённую службу
 * клетку не закрывает — и нагрузкой это не считается.
 */
const WorshipLoad = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const служб = n => Layout.pluralize(n, {
        ru: ['служба', 'службы', 'служб'], en: ['service', 'services'], hi: 'सेवा' });

    // служба до этого часа — ранняя: встать к ней тяжелее всего
    const РАННЯЯ_ДО = '06:30';
    // во сколько раз выше / ниже нормы — уже повод присмотреться
    const ПЕРЕГРУЗ = 1.5, НЕДОГРУЗ = 0.5;
    const ДНИ = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const МЕСЯЦЫ = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

    let люди = [], службы = [], отметки = [];
    let назначения = [], отклонения = [];          // за все загруженные недели
    const загруженные = new Set();                  // понедельники загруженных недель
    let поId = new Map(), службаПоId = new Map(), отклонениеПоId = new Map();

    let неделя = понедельник(DateUtils.nowAshram());
    let состав = (() => {
        try { return localStorage.getItem('worship_load_kind') || 'все'; }
        catch { return 'все'; }
    })();

    // ---------- даты ----------
    function понедельник(дата) {
        const д = new Date(дата);
        д.setDate(д.getDate() - (д.getDay() + 6) % 7);
        return DateUtils.toISO(д);
    }
    function сдвиг(iso, дней) {
        const д = DateUtils.parseDate(iso);
        д.setDate(д.getDate() + дней);
        return DateUtils.toISO(д);
    }
    const дниНедели = пн => Array.from({ length: 7 }, (_, i) => сдвиг(пн, i));
    const сегодня = () => DateUtils.todayAshramISO();

    function подписьНедели(пн) {
        const а = DateUtils.parseDate(пн), б = DateUtils.parseDate(сдвиг(пн, 6));
        return а.getMonth() === б.getMonth()
            ? `${а.getDate()}–${б.getDate()} ${МЕСЯЦЫ[б.getMonth()]}`
            : `${а.getDate()} ${МЕСЯЦЫ[а.getMonth()]} – ${б.getDate()} ${МЕСЯЦЫ[б.getMonth()]}`;
    }

    /** «2 ч 30 мин», «45 мин», «6 ч». */
    const часы = мин => {
        const м = Math.round(мин), ч = Math.floor(м / 60), ост = м % 60;
        if (!ч) return `${ост} мин`;
        return ост ? `${ч} ч ${ост} мин` : `${ч} ч`;
    };
    /** Для клетки дня — коротко: «30м», «2ч», «1ч30». */
    const часыКоротко = мин => {
        const м = Math.round(мин), ч = Math.floor(м / 60), ост = м % 60;
        if (!ч) return `${ост}м`;
        return ост ? `${ч}ч${String(ост).padStart(2, '0')}` : `${ч}ч`;
    };

    // ---------- загрузка ----------
    /** Люди, службы и отметки отъезда от недели не зависят — один раз. */
    async function загрузитьПостоянное() {
        const [л, с, о] = await Promise.all([
            Layout.db.rpc('worship_people_list'),
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, duration_minutes, is_active')
                .order('time_of_day'),
            Layout.db.from('worship_absences').select('person_id, date_from, date_to'),
        ]);
        const ошибка = л.error || с.error || о.error;
        if (ошибка) { Layout.handleError(ошибка, 'Загрузка отдела'); return false; }
        люди = (л.data || []).map(ч => ({ ...ч, имя: ч.name }));
        службы = с.data || [];
        отметки = о.data || [];
        поId = new Map(люди.map(ч => [ч.id, ч]));
        службаПоId = new Map(службы.map(x => [x.id, x]));
        return true;
    }

    /** Назначения и разовые службы за недели, начиная с пн; уже загруженные не тянем. */
    async function загрузитьНедели(пн, сколько) {
        const нужные = Array.from({ length: сколько }, (_, i) => сдвиг(пн, i * 7))
            .filter(н => !загруженные.has(н));
        if (!нужные.length) return true;
        const от = нужные[0], до = сдвиг(нужные.at(-1), 6);
        const [н, о] = await Promise.all([
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, person_id, role')
                .gte('duty_date', от).lte('duty_date', до).limit(5000),
            Layout.db.from('worship_day_overrides')
                .select('id, duty_date, service_id, title, time_of_day, duration_minutes')
                .gte('duty_date', от).lte('duty_date', до),
        ]);
        if (н.error || о.error) { Layout.handleError(н.error || о.error, 'Загрузка отдела'); return false; }
        // неделя могла быть загружена частично соседним запросом — без повторов
        const былиН = new Set(назначения.map(x => x.id)), былиО = new Set(отклонения.map(x => x.id));
        назначения.push(...(н.data || []).filter(x => !былиН.has(x.id)));
        отклонения.push(...(о.data || []).filter(x => !былиО.has(x.id)));
        отклонениеПоId = new Map(отклонения.map(x => [x.id, x]));
        нужные.forEach(н2 => загруженные.add(н2));
        return true;
    }

    // ---------- правила ----------
    const вОтъезде = (id, день) => отметки.some(а => а.person_id === id
        && а.date_from <= день && (!а.date_to || а.date_to >= день));

    /** Человек в этот день в отделе и на месте — его можно было поставить. */
    const наМесте = (ч, день) => ч.is_active !== false
        && (!ч.active_from || ч.active_from <= день)
        && (!ч.active_to || ч.active_to >= день)
        && !вОтъезде(ч.id, день);

    const отменена = (serviceId, день) => отклонения.some(о =>
        о.service_id === serviceId && !о.title && о.duty_date === день);

    /** Назначение, которое и правда закрывает службу — как в шахматке. */
    const настоящее = н => {
        const ч = поId.get(н.person_id);
        if (!ч || !наМесте(ч, н.duty_date)) return false;
        if (н.service_id) {
            if (службаПоId.get(н.service_id)?.is_active === false) return false;
            if (отменена(н.service_id, н.duty_date)) return false;
        }
        return true;
    };

    /** Что за служба у назначения: имя, время, минуты (null — длительность не задана). */
    function службаНазначения(н) {
        if (н.service_id) {
            const с = службаПоId.get(н.service_id) || {};
            return { имя: Layout.getName(с), время: с.time_of_day || '', минут: с.duration_minutes ?? null };
        }
        const о = отклонениеПоId.get(н.override_id) || {};
        return { имя: о.title || 'разовая служба', время: о.time_of_day || '', минут: о.duration_minutes ?? null };
    }

    const вСоставе = ч => состав === 'все' || (ч.kind || 'team') === состав;

    // ---------- счёт ----------
    /** Неделя каждого человека по дням. */
    function посчитать() {
        const дни = дниНедели(неделя);
        const вНеделе = new Set(дни);
        const своиПоЧеловеку = new Map();
        for (const н of назначения) {
            if (!вНеделе.has(н.duty_date) || !настоящее(н)) continue;
            if (!своиПоЧеловеку.has(н.person_id)) своиПоЧеловеку.set(н.person_id, []);
            своиПоЧеловеку.get(н.person_id).push(н);
        }

        const строки = люди.filter(вСоставе).map(ч => {
            const свои = своиПоЧеловеку.get(ч.id) || [];
            const поДням = дни.map(д => {
                const за = свои.filter(н => н.duty_date === д).map(службаНазначения)
                    .sort((a, b) => a.время.localeCompare(b.время));
                return {
                    д, наМесте: наМесте(ч, д), список: за,
                    минут: за.reduce((с, x) => с + (x.минут || 0), 0),
                    безДлительности: за.filter(x => x.минут === null).length,
                };
            });
            const все = поДням.flatMap(x => x.список);
            return {
                ...ч, поДням,
                минут: все.reduce((с, x) => с + (x.минут || 0), 0),
                служб: все.length,
                ранних: все.filter(x => (x.время || '99').slice(0, 5) < РАННЯЯ_ДО).length,
                безДлительности: все.filter(x => x.минут === null).length,
                днейНаМесте: поДням.filter(x => x.наМесте).length,
            };
        // выбывших до этой недели и ещё не пришедших не показываем вовсе
        }).filter(ч => ч.днейНаМесте > 0 || ч.служб > 0 || (ч.is_active !== false
            && (!ч.active_to || ч.active_to >= дни[0]) && (!ч.active_from || ч.active_from <= дни[6])));

        // часами меряем, как только у служб недели есть длительность;
        // до тех пор — числом служб, иначе у всех стояло бы «0 мин»
        const поВремени = строки.some(ч => ч.минут > 0);
        const мера = ч => поВремени ? ч.минут : ч.служб;

        // норма — сколько в среднем несёт человек отдела за день на месте
        const наМестеДней = строки.reduce((с, ч) => с + ч.днейНаМесте, 0);
        const всегоМеры = строки.reduce((с, ч) => с + мера(ч), 0);
        const нормаВДень = наМестеДней ? всегоМеры / наМестеДней : 0;

        строки.forEach(ч => {
            ч.мера = мера(ч);
            ч.ожидание = нормаВДень * ч.днейНаМесте;
            ч.доля = ч.ожидание ? ч.мера / ч.ожидание : null;
            ч.метка = !ч.днейНаМесте ? 'отъезд'
                : !ч.служб ? 'неСтавили'
                : !всегоМеры ? null
                : ч.доля >= ПЕРЕГРУЗ ? 'перегружен'
                : ч.доля <= НЕДОГРУЗ ? 'недогружен' : 'норма';
            // часы служб без длительности неизвестны: «недогружен» или
            // «в норме» могут оказаться неправдой — тогда вердикта нет.
            // «Перегружен» верен и так: неизвестные часы его только увеличат
            if (поВремени && ч.безДлительности && (ч.метка === 'недогружен' || ч.метка === 'норма')) {
                ч.метка = null;
            }
        });

        // сверху самые нагруженные, уехавшие на всю неделю — в конце
        строки.sort((a, b) => Number(!a.днейНаМесте) - Number(!b.днейНаМесте)
            || b.мера - a.мера || b.служб - a.служб || a.имя.localeCompare(b.имя, 'ru'));
        return { строки, дни, поВремени, нормаВДень };
    }

    // ---------- отрисовка ----------
    const ПОДПИСИ = {
        перегружен: 'перегружен', норма: 'в норме', недогружен: 'недогружен',
        неСтавили: 'не ставили', отъезд: 'в отъезде всю неделю',
    };

    function рисовать() {
        const { строки, дни, поВремени, нормаВДень } = посчитать();
        const сег = сегодня();
        const мераДня = x => поВремени ? x.минут : x.список.length;
        const максДня = Math.max(поВремени ? 60 : 1, ...строки.flatMap(ч => ч.поДням.map(мераДня)));

        $('#подписьНедели').textContent = неделя === понедельник(DateUtils.nowAshram())
            ? `Эта неделя · ${подписьНедели(неделя)}` : подписьНедели(неделя);
        document.querySelectorAll('[data-состав]').forEach(б =>
            б.classList.toggle('btn-active', б.dataset.состав === состав));

        $('#норма').textContent = нормаВДень
            ? `норма отдела — ${поВремени ? часы(нормаВДень) : `${(Math.round(нормаВДень * 10) / 10).toString().replace('.', ',')} службы`} в день на месте`
            : '';

        // службы недели без длительности: их часы не посчитаны
        const безДлит = [...new Set(строки.flatMap(ч => ч.поДням.flatMap(x =>
            x.список.filter(с => с.минут === null).map(с => с.имя))))];
        $('#безДлительности').hidden = !(поВремени && безДлит.length);
        $('#безДлительности').innerHTML = `У ${безДлит.length > 1 ? 'служб' : 'службы'} <b>${
            безДлит.map(e).join(', ')}</b> не задана длительность — в клетках они помечены «?»
            и в часы не вошли. <a class="link" href="schedule.html">Задать в расписании</a>, кнопка «Службы».`;

        const шапка = `
            <div class="строкаЗагрузки pb-2 mb-1 border-b border-base-200" aria-hidden="true">
                <div class="кто text-xs opacity-60">Человек</div>
                ${дни.map((д, i) => `
                    <div class="шапкаДня ${д === сег ? 'сегодня' : ''}">${ДНИ[i]}<br>${
                        д === сег ? 'сегодня' : DateUtils.parseDate(д).getDate()}</div>`).join('')}
                <div class="итог text-xs opacity-60">за неделю</div>
            </div>`;

        const клетка = (x, имя) => {
            const м = мераДня(x);
            const сила = м ? Math.min(1, м / максДня) : 0;
            // заливка цветом модуля по силе дня; на тёмной — белые цифры
            const доля = Math.round(14 + сила * 76);
            const классы = ['деньЯч', x.д === сег ? 'сегодня' : '', !x.наМесте ? 'нет' : '',
                м || x.список.length ? 'занят' : '', доля > 55 ? 'светлый' : ''].join(' ');
            const фон = (м || x.список.length) && x.наМесте
                ? `style="background: color-mix(in oklch, var(--current-color) ${доля}%, oklch(var(--b1)));"` : '';
            const текст = !x.наМесте ? '—'
                : !x.список.length ? ''
                : поВремени ? (x.минут ? часыКоротко(x.минут) + (x.безДлительности ? '+?' : '') : '?')
                : String(x.список.length);
            const подсказка = !x.наМесте ? 'в отъезде или не в отделе'
                : x.список.length ? x.список.map(с => `${с.время.slice(0, 5)} ${с.имя}${
                    с.минут ? ` — ${часы(с.минут)}` : ' — длительность не задана'}`).join('\n')
                : 'служб нет';
            const день = DateUtils.parseDate(x.д);
            // клетка ведёт в этот день расписания: увидел перегруз — поправил
            return `<a href="schedule.html?день=${x.д}" class="${классы}" ${фон} title="${e(подсказка)}"
                         aria-label="${e(`${имя}, ${ДНИ[(день.getDay() + 6) % 7]} ${день.getDate()}: ${подсказка}`)}">${e(текст)}</a>`;
        };

        $('#загрузка').innerHTML = шапка + (строки.map(ч => `
            <div class="строкаЗагрузки человек py-2.5">
                <div class="кто min-w-0">
                    <a href="people.html?id=${ч.id}" class="link link-hover font-semibold">${e(ч.имя)}</a>
                    ${состав === 'все' && ч.kind === 'volunteer'
                        ? '<span class="badge badge-sm badge-outline ml-1 align-middle">волонтёр</span>' : ''}
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-sm opacity-80">
                        ${ч.метка ? `<span class="метка ${ч.метка}" title="${e(ч.ожидание && ч.метка !== 'отъезд'
                            ? `при ${ч.днейНаМесте} дн. на месте норма ≈ ${поВремени ? часы(ч.ожидание) : Math.round(ч.ожидание) + ' сл.'}`
                            : '')}">${ПОДПИСИ[ч.метка]}</span>` : ''}
                        ${ч.ранних ? `<span>ранних ${ч.ранних}</span>` : ''}
                        ${ч.днейНаМесте && ч.днейНаМесте < 7 ? `<span>на месте ${ч.днейНаМесте} из 7 дн.</span>` : ''}
                    </div>
                </div>
                ${ч.поДням.map(x => клетка(x, ч.имя)).join('')}
                <div class="итог">
                    <div class="font-bold tabular-nums whitespace-nowrap">${
                        поВремени ? (ч.минут ? часы(ч.минут) : (ч.служб ? '?' : '—')) : (ч.служб || '—')}</div>
                    <div class="text-sm opacity-70 tabular-nums whitespace-nowrap">${
                        поВремени ? (ч.служб ? служб(ч.служб) : '')
                                  : (ч.служб ? служб(ч.служб).replace(/^\d+\s*/, '') : '')}</div>
                </div>
            </div>`).join('') || '<p class="py-4 text-sm opacity-70">В отделе на эту неделю никого нет</p>');

        рисоватьСлужбы(дни);
    }

    /** По службам недели: где остаются дыры и кто её обычно несёт. */
    function рисоватьСлужбы(дни) {
        const строки = службы.filter(с => с.is_active).map(с => {
            let надо = 0, закрыто = 0;
            const носители = {};
            for (const д of дни) {
                if (отменена(с.id, д)) continue;
                надо++;
                const свои = назначения.filter(н => н.duty_date === д && н.service_id === с.id && настоящее(н));
                // закрыта, только если придёт ведущий: один помощник службу не держит
                if (свои.some(н => н.role === 'pujari')) закрыто++;
                свои.forEach(н => {
                    const имя = поId.get(н.person_id)?.имя;
                    if (имя) носители[имя] = (носители[имя] || 0) + 1;
                });
            }
            const чаще = Object.entries(носители).sort((a, b) => b[1] - a[1])[0];
            return {
                имя: Layout.getName(с), время: (с.time_of_day || '').slice(0, 5),
                дыр: надо - закрыто, основной: чаще ? `${чаще[0]} · ${чаще[1]}` : null,
            };
        }).sort((a, b) => b.дыр - a.дыр || a.время.localeCompare(b.время));

        $('#службы').innerHTML = строки.map(с => `
            <li class="py-2 border-b border-base-200 last:border-0
                       flex flex-wrap items-baseline gap-x-3 gap-y-1 cursor-pointer hover:bg-base-200/50 -mx-2 px-2 rounded"
                data-неделя-расписания="${дни[0]}">
                <span class="text-sm opacity-70 tabular-nums w-12">${e(с.время)}</span>
                <span class="font-semibold">${e(с.имя)}</span>
                <span class="flex-1"></span>
                ${с.основной ? `<span class="text-sm opacity-70">чаще всех — ${e(с.основной)}</span>` : ''}
                <span class="text-sm tabular-nums ${с.дыр ? 'text-warning font-semibold' : 'opacity-70'}">${
                    с.дыр ? `${с.дыр} без человека` : 'закрыта вся'}</span>
            </li>`).join('') || '<li class="py-3 text-sm opacity-70">Служб пока нет</li>';
    }

    // ---------- листание ----------
    let поколение = 0;
    async function перейти(пн) {
        неделя = пн;
        const моё = ++поколение;
        if (!загруженные.has(пн)) {
            $('#загрузка').setAttribute('aria-busy', 'true');
            const ок = await загрузитьНедели(пн, 1);
            if (моё !== поколение) return;
            $('#загрузка').removeAttribute('aria-busy');
            if (!ок) return;
        }
        рисовать();
    }

    async function init() {
        document.addEventListener('click', ev => {
            // строка «где остаются дыры» — в эту неделю расписания
            const кНеделе = ev.target.closest('[data-неделя-расписания]');
            if (кНеделе) {
                location.href = `schedule.html?день=${кНеделе.getAttribute('data-неделя-расписания')}&вид=неделя`;
                return;
            }
            const н = ev.target.closest('[data-неделя]');
            if (н) {
                const шаг = Number(н.dataset.неделя);
                return перейти(шаг ? сдвиг(неделя, шаг * 7) : понедельник(DateUtils.nowAshram()));
            }
            const с = ev.target.closest('[data-состав]');
            if (!с) return;
            состав = с.dataset.состав;
            try { localStorage.setItem('worship_load_kind', состав); } catch { /* приватный режим */ }
            рисовать();            // данные те же, меняется только разрез
        });

        // эта и следующая неделя — одним кругом с людьми и службами
        const [а, б] = await Promise.all([загрузитьПостоянное(), загрузитьНедели(неделя, 2)]);
        if (!а || !б) return;
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
