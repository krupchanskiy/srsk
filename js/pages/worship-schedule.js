/**
 * Расписание: неделя на компьютере, день на телефоне.
 *
 * Главное, что показывает шахматка, — пустые клетки: службы, на которые
 * никто не поставлен. Поэтому пустая клетка выглядит пусто и кликается
 * целиком, а не прячется за мелкой кнопкой.
 *
 * Жёсткая проверка в базе одна — недоступность. Допуск, занятость в то же
 * время и истёкший срок участия приходят предупреждениями: ставить кого
 * угодно — право старшего, а не ошибка.
 */
const WorshipSchedule = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноВести = () => !!window.hasPermission?.('worship_approve');

    const РОЛИ = { pujari: 'пуджари', kirtan: 'киртания', helper: 'помощник' };
    // своя роль словами: «вы — помощник» понятнее серой плашки «помощник»
    const МОЯ_РОЛЬ = поЯзыку({
        ru: { pujari: 'ведёте', kirtan: 'киртания', helper: 'помощник' },
        en: { pujari: 'you lead', kirtan: 'kirtan', helper: 'assistant' },
        hi: { pujari: 'आप मुख्य', kirtan: 'कीर्तन', helper: 'सहायक' } });
    // «вы» рядом со своим именем: бледной заливки клетки новичок не замечал
    const ЗНАК_ВЫ = `<span class="badge badge-xs ml-0.5 border-0" style="background: var(--current-color); color:#fff;">${поЯзыку({ ru: 'вы', en: 'you', hi: 'आप' })}</span>`;
    const ДНИ = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

    // Расписание ведут вперёд, поэтому неделя считается от сегодняшнего дня,
    // а не от понедельника. На календарной неделе в воскресенье открывались
    // шесть прошедших дней и один сегодняшний: смотреть там нечего, и первым
    // движением старший жал «›». Теперь слева всегда сегодня, справа — то,
    // что предстоит расписать.
    let началоНедели = (() => {
        const д = DateUtils.nowAshram();
        д.setHours(0, 0, 0, 0);
        return д;
    })();
    let выбранныйДень = DateUtils.todayAshramISO();
    let вид = window.matchMedia('(max-width: 900px)').matches ? 'день' : 'неделя';

    let службы = [], люди = [], назначения = [], отклонения = [], отметки = [], стандарты = [];
    let мои = [], моиОтклонения = [];   // свои службы вперёд, независимо от открытой недели
    let моиОтметки = [];                // свои «меня не будет» — от сегодня вперёд
    let яЧеловек = null;              // моя запись в отделе, если я в нём есть
    let клетка = null;                // что сейчас назначаем

    // ---------- даты ----------
    /** Окно из семи дней начинается с того дня, который человек открыл. */
    function началоОт(дата) {
        const д = new Date(дата);
        д.setHours(0, 0, 0, 0);
        return д;
    }

    const деньНедели = i => {
        const д = new Date(началоНедели);
        д.setDate(д.getDate() + i);
        return д;
    };

    const дни = () => Array.from({ length: 7 }, (_, i) => DateUtils.toISO(деньНедели(i)));

    // ---------- загрузка ----------
    // Листание недель часто идёт быстрыми щелчками: ответ по прежней неделе
    // может прийти позже свежего и нарисовать чужие назначения под новыми
    // датами. Поколение отсекает такие опоздавшие ответы.
    let поколение = 0;

    /**
     * всё = false — только то, что зависит от открытых дней (назначения,
     * отклонения, отметки). Службы, люди, допуски и стандарты от недели
     * не зависят, и при листании их незачем тянуть заново.
     */
    async function загрузить(всё = true) {
        const моё = ++поколение;
        const от = дни()[0], до = дни()[6];

        const [н, о, от2, с, л, доп, ст] = await Promise.all([
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, person_id, role')
                .gte('duty_date', от).lte('duty_date', до),
            Layout.db.from('worship_day_overrides')
                .select('id, duty_date, service_id, title, time_of_day, duration_minutes, reason')
                .gte('duty_date', от).lte('duty_date', до),
            Layout.db.from('worship_absences')
                .select('id, person_id, date_from, date_to, reason')
                .lte('date_from', до),
            всё ? Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, duration_minutes, sort_order, article_id, is_active')
                .order('sort_order').order('time_of_day') : null,
            // люди сразу с именами: отдельный поход в vaishnavas стоил лишнего
            // круга по сети, а пуджари без прав на карточки видел «без имени»
            всё ? Layout.db.rpc('worship_people_list') : null,
            // допуски нужны для пометок в выборе человека и в клетке
            всё ? Layout.db.from('worship_person_services').select('person_id, service_id') : null,
            // стандарты нужны, чтобы у службы можно было задать «как делается»
            всё ? Layout.db.from('worship_articles')
                .select('id, title').eq('kind', 'standard').eq('status', 'published').order('title') : null,
        ]);
        if (моё !== поколение) return false;
        const ошибка = [н, о, от2, с, л, доп, ст].find(r => r?.error)?.error;
        if (ошибка) { Layout.handleError(ошибка, 'Расписание'); return false; }

        if (всё) {
            const новые = (л.data || []).map(ч => ({
                ...ч,
                имя: ч.name,
                безВхода: !ч.user_id,
                безБота: !!ч.user_id && !ч.has_telegram,
            })).sort((a, b) => a.имя.localeCompare(b.имя, 'ru'));
            const я = новые.find(ч => ч.user_id && ч.user_id === window.currentUser?.id) || null;
            новые.forEach(ч => {
                ч.допуск = new Set((доп.data || [])
                    .filter(д => д.person_id === ч.id).map(д => д.service_id));
            });
            службы = с.data || [];
            люди = новые;
            яЧеловек = я;
            стандарты = ст.data || [];
            await загрузитьМои();
            if (моё !== поколение) return false;
        }

        назначения = н.data || [];
        отклонения = о.data || [];
        // бессрочная отметка не имеет даты окончания — её не отфильтровать запросом
        отметки = (от2.data || []).filter(а => !а.date_to || а.date_to >= от);
        return true;
    }

    /**
     * «Ваши ближайшие службы» — про завтра, а не про открытую неделю:
     * в воскресенье вечером человек смотрит расписание ровно затем, чтобы
     * увидеть ближайшие дни, и листать за этим он не станет.
     */
    async function загрузитьМои() {
        мои = [];
        моиОтклонения = [];
        моиОтметки = [];
        if (!яЧеловек) return;
        const сегодня = DateUtils.todayAshramISO();
        // своя отметка «меня не будет» нужна и тут: после неё человек должен
        // видеть, что его службы в эти дни ждут замены, и мочь её снять
        const [{ data }, { data: отм }] = await Promise.all([
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, role')
                .eq('person_id', яЧеловек.id).gte('duty_date', сегодня)
                .order('duty_date').limit(20),
            Layout.db.from('worship_absences')
                .select('id, date_from, date_to, reason')
                .eq('person_id', яЧеловек.id)
                .or(`date_to.is.null,date_to.gte.${сегодня}`)
                .order('date_from'),
        ]);
        мои = data || [];
        моиОтметки = отм || [];

        // отменённые в эти дни службы из своего списка надо убрать:
        // иначе человек встанет к службе, которой нет
        const даты = [...new Set(мои.map(н => н.duty_date))];
        if (!даты.length) return;
        const { data: откл } = await Layout.db.from('worship_day_overrides')
            .select('id, duty_date, service_id, title, time_of_day')
            .in('duty_date', даты);
        моиОтклонения = откл || [];
    }

    // ---------- вспомогательное ----------
    const человек = id => люди.find(ч => ч.id === id);

    const вОтъезде = (personId, день) => отметки.some(а => а.person_id === personId
        && а.date_from <= день && (!а.date_to || а.date_to >= день));

    const отменена = (serviceId, день) => отклонения.some(о =>
        о.service_id === serviceId && о.duty_date === день);

    const разовыеДня = день => отклонения.filter(о => о.title && о.duty_date === день);

    /**
     * Назначение, которое и правда закроет службу: человек в отделе, его срок
     * участия этот день покрывает, и он не в отъезде. Клетка с волонтёром,
     * у которого срок истёк, раньше красилась зелёным, хотя сама же
     * зачёркивала его с пометкой «срок истёк».
     */
    const кто_придёт = (н, день) => {
        const ч = человек(н.person_id);
        return !!ч && ч.is_active !== false
            && (!ч.active_to || ч.active_to >= день)
            && (!ч.active_from || ч.active_from <= день)
            && !вОтъезде(ч.id, день);
    };

    // Службу держит ведущий пуджари. Помощник и киртан без него службу
    // не проведут: клетка с одним помощником раньше была зелёной «закрыто»
    const ведёт = (н, день) => н.role === 'pujari' && кто_придёт(н, день);
    // в клетке кто-то придёт, но ведущего среди них нет
    const безВедущего = (свои, день) => свои.some(н => кто_придёт(н, день))
        && !свои.some(н => ведёт(н, день));

    const вКлетке = (день, serviceId, overrideId) => назначения.filter(н =>
        н.duty_date === день &&
        (overrideId ? н.override_id === overrideId : н.service_id === serviceId));

    // ---------- отрисовка недели ----------
    function рисоватьШапку() {
        // Главное действие у каждого своё: старший пришёл расписать неделю,
        // пуджари — посмотреть свои службы и, если заболел, отметиться.
        // Остальное — обслуживание, ему место под «ещё».
        const редкие = [];
        редкие.push('<li><button id="печать">Распечатать неделю</button></li>');
        if (яЧеловек && можноВести()) редкие.push(`<li><button id="яНеСмогу">${поЯзыку({ ru: 'Меня не будет', en: 'I will be away', hi: 'मैं नहीं रहूँगा' })}</button></li>`);

        $('#actions').innerHTML = `
            ${можноВести()
                ? `<button class="btn btn-sm" id="копияНедели"
                        style="background: var(--current-color); color:#fff;">Как на прошлой неделе</button>
                   <!-- состав служб и их время правят не каждый день, но ищут
                        именно здесь: под «ещё» эту кнопку не находили -->
                   <button class="btn btn-sm btn-outline" id="вестиСлужбы">Службы и время</button>`
                : яЧеловек
                    ? `<button class="btn btn-sm btn-outline" id="яНеСмогу">${поЯзыку({ ru: 'Меня не будет', en: 'I will be away', hi: 'मैं नहीं रहूँगा' })}</button>`
                    : ''}
            <div class="dropdown dropdown-end">
                <button tabindex="0" class="btn btn-sm px-2 bg-base-100 border-base-300 hover:bg-base-200" aria-label="Ещё действия">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle>
                        <circle cx="12" cy="19" r="1.7"></circle>
                    </svg>
                </button>
                <ul tabindex="0" class="dropdown-content z-30 menu menu-sm p-2 shadow bg-base-100 rounded-box w-56">
                    ${редкие.join('')}
                </ul>
            </div>`;

        // неделя, которую не вели, и неделя, которую не закрыли, — разные вещи:
        // пустая шахматка в прошлом не должна читаться как обвинение
        const прошлая = дни()[6] < DateUtils.todayAshramISO();
        // Счётчик незакрытых клеток отсюда убран: это же самое видно по самой
        // шахматке — жёлтые клетки и строка «закрыто за день» внизу
        const поле = $('#подзаголовок');
        поле.className = 'text-sm opacity-70 mt-1';
        if (!службы.length) {
            поле.textContent = можноВести()
                ? 'Служб пока нет — заведите их кнопкой «Службы»'
                : 'Служб пока нет: их заводит старший пуджари';
        } else if (прошлая) {
            поле.textContent = назначения.length ? 'Прошедшая неделя' : 'Эту неделю в системе не вели';
        } else {
            поле.textContent = '';
        }

        const начало = деньНедели(0), конец = деньНедели(6);
        // на бумаге нет кнопок и подписей сверху: период печатается в шапке листа
        const лист = $('#печатьПериод');
        if (лист) лист.textContent = `${DateUtils.formatShort(начало)} — ${DateUtils.formatShort(конец)}`;
        $('#периодНадпись').textContent = вид === 'день'
            ? DateUtils.formatWithWeekday(DateUtils.parseDate(выбранныйДень))
            : `${DateUtils.formatShort(начало)} — ${DateUtils.formatShort(конец)}`;

        document.querySelectorAll('[data-вид]').forEach(б =>
            б.classList.toggle('btn-active', б.dataset.вид === вид));
        $('#шахматка').hidden = вид !== 'неделя';
        $('#день').hidden = вид !== 'день';
    }

    /** «20–22 окт», «30 окт – 2 ноя», «с 20 окт» — срок своей отметки, без года. */
    const МЕС = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const срокОтметки = а => {
        const от = DateUtils.parseDate(а.date_from);
        if (!а.date_to) return `с ${от.getDate()} ${МЕС[от.getMonth()]}`;
        const до = DateUtils.parseDate(а.date_to);
        if (а.date_to === а.date_from) return `${от.getDate()} ${МЕС[от.getMonth()]}`;
        return от.getMonth() === до.getMonth()
            ? `${от.getDate()}–${до.getDate()} ${МЕС[до.getMonth()]}`
            : `${от.getDate()} ${МЕС[от.getMonth()]} – ${до.getDate()} ${МЕС[до.getMonth()]}`;
    };
    const меняНеБудет = день => моиОтметки.some(а => а.date_from <= день && (!а.date_to || а.date_to >= день));

    function рисоватьМои() {
        if (!яЧеловек || (!мои.length && !моиОтметки.length)) { $('#мои').hidden = true; return; }

        // снятая с расписания служба — тоже «не проводится»: назначения на неё
        // остаются в базе, но приходить к ней не нужно
        const отключена = н => н.service_id && службы.find(с => с.id === н.service_id)?.is_active === false;
        const отменён = н => отключена(н) || (н.service_id && моиОтклонения.some(о =>
            о.service_id === н.service_id && о.duty_date === н.duty_date));
        const живые = мои.filter(н => !отменён(н)).slice(0, 5);
        const снятые = мои.filter(отменён);

        $('#мои').hidden = !живые.length && !снятые.length && !моиОтметки.length;
        // своя отметка — первой строкой и с «отменить»: раньше после «Отмечено»
        // её не было видно нигде, и снять ошибочную было негде
        $('#моиСписок').innerHTML = моиОтметки.map(а => `
            <li class="py-1 flex flex-wrap items-baseline gap-2">
                <span class="badge badge-warning">${поЯзыку({ ru: 'Вас не будет', en: 'You will be away', hi: 'आप नहीं होंगे' })}</span>
                <span class="font-semibold">${e(срокОтметки(а))}</span>
                ${а.reason ? `<span class="opacity-70">${e(а.reason)}</span>` : ''}
                <button class="btn btn-ghost btn-xs" data-снятьМою="${а.id}">отменить</button>
            </li>`).join('') + живые.map(н => строкаМоей(н)).join('') +
            // о службе, которую отменили уже после назначения, человек должен
            // узнать здесь, а не придя в храм
            снятые.slice(0, 3).map(н => `
            <li class="py-1 flex flex-wrap items-baseline gap-2 opacity-70">
                <span class="font-semibold line-through">${e(деньПоЧеловечески(н.duty_date))}</span>
                <span class="line-through">${e(имяСлужбы(н))}</span>
                <span class="badge badge-sm badge-warning">${отключена(н)
                    ? 'служба снята с расписания' : 'в этот день не проводится'}</span>
            </li>`).join('');
    }

    const имяСлужбы = н => {
        const с = службы.find(x => x.id === н.service_id);
        if (с) return Layout.getName(с);
        const о = [...отклонения, ...моиОтклонения].find(x => x.id === н.override_id);
        return о?.title || 'служба';
    };

    function строкаМоей(н) {
        const с = службы.find(x => x.id === н.service_id);
        const о = [...отклонения, ...моиОтклонения].find(x => x.id === н.override_id);
        const время = (с?.time_of_day || о?.time_of_day || '').slice(0, 5);
        return `
        <li class="py-1 flex flex-wrap items-baseline gap-2">
            <span class="font-semibold">${e(деньПоЧеловечески(н.duty_date))}</span>
            <span class="opacity-70">${e(время)}</span>
            ${с?.article_id
                ? `<a class="link" href="article.html?id=${с.article_id}">${e(имяСлужбы(н))}</a>`
                : `<span>${e(имяСлужбы(н))}</span>`}
            <span class="badge badge-sm ${н.role === 'pujari' ? 'badge-outline' : ''}">${e(МОЯ_РОЛЬ[н.role] || н.role)}</span>
            ${меняНеБудет(н.duty_date)
                ? `<span class="badge badge-sm badge-warning">${поЯзыку({ ru: 'вас не будет — нужна замена', en: 'you are away — find a substitute', hi: 'आप नहीं होंगे — बदली चाहिए' })}</span>` : ''}
        </li>`;
    }

    function рисоватьНеделю() {
        const список = дни();
        const сегодня = DateUtils.todayAshramISO();
        $('#шапкаДней').innerHTML = '<th class="w-44">Служба</th>' + список.map((д, i) => `
            <th class="${д === сегодня ? 'сегодня text-[color:var(--current-color)]' : ''}">
                ${ДНИ[(DateUtils.parseDate(д).getDay() + 6) % 7]}<span class="block text-xs font-normal">${
                    д === сегодня
                        // лист висит неделю: «сегодня» на бумаге через день уже неправда
                        ? `<span class="no-print">сегодня</span><span class="дляПечати">${
                            DateUtils.formatShort(DateUtils.parseDate(д))}</span>`
                        : DateUtils.formatShort(DateUtils.parseDate(д))}</span>
            </th>`).join('');

        // строки идут по времени: разовая в 06:30 стоит выше бхоги в 08:00,
        // а не в конце таблицы, как «приложение к расписанию»
        const ряды = [
            ...службы.filter(с => с.is_active).map(с => ({ время: с.time_of_day, служба: с, разовая: null })),
            ...отклонения.filter(о => о.title).map(о => ({ время: о.time_of_day, служба: null, разовая: о })),
        ].sort((a, b) => (a.время || '').localeCompare(b.время || ''));

        const строки = ряды.map(({ служба: с, разовая: о }) => с
            ? `
            <tr>
                <td class="align-top">
                    <!-- время первым: по шахматке ведут взглядом сверху вниз
                         по часам, а «стандарта нет» повторялось в каждой строке
                         и ни к какому действию не вело -->
                    <span class="block text-xs font-semibold opacity-70 tabular-nums">${
                        e(с.time_of_day.slice(0, 5))}</span>
                    <span class="font-semibold">${e(Layout.getName(с))}</span>
                    ${с.article_id
                        ? `<a class="link link-hover block text-xs opacity-70 no-print"
                              href="article.html?id=${с.article_id}">как делается</a>` : ''}
                </td>
                ${список.map(д => клеткаHTML(д, с)).join('')}
            </tr>`
            : `
            <tr>
                <td class="align-top">
                    <span class="block text-xs font-semibold opacity-70 tabular-nums">${
                        e((о.time_of_day || '').slice(0, 5))}</span>
                    <span class="font-semibold">${e(о.title)}</span>
                    <span class="badge badge-sm ml-1">разовая</span>
                </td>
                ${список.map(д => д === о.duty_date
                    ? клеткаHTML(д, null, о)
                    : `<td class="клетка неПрименимо ${д === сегодня ? 'сегодня' : ''}"></td>`).join('')}
            </tr>`);

        $('#строкиСлужб').innerHTML = строки.join('') ||
            `<tr><td colspan="8" class="text-sm opacity-60 p-4">
                Служб пока нет. ${можноВести() ? 'Заведите их кнопкой «Службы».'
                    : 'Их заводит старший пуджари.'}</td></tr>`;
    }

    function клеткаHTML(день, служба, разовая) {
        const сегодня = день === DateUtils.todayAshramISO() ? ' сегодня' : '';

        if (служба && отменена(служба.id, день)) {
            const о = отклонения.find(x => x.service_id === служба.id && x.duty_date === день);
            // отмена не снимает уже стоящих: иначе отмена «на пробу» молча
            // стирала бы расстановку. Но и прятать их нельзя — люди придут
            const повисшие = вКлетке(день, служба.id);
            return `<td class="клетка отменена${сегодня} text-xs opacity-80">
                не проводится${о?.reason ? `<span class="block opacity-70">${e(о.reason)}</span>` : ''}
                ${повисшие.map(н => `
                    <div class="flex items-center gap-1 mt-1">
                        <span class="line-through">${e(человек(н.person_id)?.имя || 'кто-то')}</span>
                        ${можноВести()
                            ? `<button class="btn btn-ghost btn-xs no-print px-1" data-снять="${н.id}"
                                       title="Снять">✕</button>` : ''}
                    </div>`).join('')}
                ${повисшие.length && можноВести()
                    ? '<span class="block text-error font-semibold">их надо снять или предупредить</span>' : ''}</td>`;
        }

        const свои = вКлетке(день, служба?.id, разовая?.id);
        const моя = яЧеловек && свои.some(н => н.person_id === яЧеловек.id);
        // клетку закрывает только тот, кто придёт: стоящий в отъезде оставляет
        // её открытой, и выглядеть она должна так же, как пустая
        const закрыта = свои.some(н => ведёт(н, день));

        if (!свои.length) {
            // в прошедшем дне дыра — не дело, а история: подсвечивать нечего
            const прошло = день < DateUtils.todayAshramISO();
            if (прошло) {
                return `<td class="клетка прошлаяПустая${сегодня}
                            ${можноВести() ? 'cursor-pointer' : ''}"
                            ${можноВести() ? `data-клетка="${день}" data-служба="${служба?.id || ''}"
                            data-разовая="${разовая?.id || ''}"` : ''}>
                    <span class="text-xs opacity-60">—</span></td>`;
            }
            if (!можноВести()) {
                return `<td class="клетка дыра${сегодня}">
                    <span class="дыраКнопка">не назначено</span></td>`;
            }
            return `<td class="клетка дыра${сегодня} cursor-pointer"
                        data-клетка="${день}" data-служба="${служба?.id || ''}"
                        data-разовая="${разовая?.id || ''}">
                <span class="дыраКнопка">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14"></path>
                    </svg>поставить</span></td>`;
        }

        // Команду и волонтёров видно по густоте зелёного: клетку, которую
        // держит только приехавший на время, старший перепроверяет первой —
        // срок участия кончится раньше, чем расписание.
        const командой = свои.some(н => ведёт(н, день)
            && (человек(н.person_id)?.kind || 'team') === 'team');
        const краска = закрыта ? (командой ? 'закрыта командой' : 'закрыта волонтёром') : 'дыра';

        // кто-то стоит, но прийти не может — это такая же дыра, только с именем
        return `<td class="клетка ${краска}${моя ? ' своя' : ''}${сегодня}">
            ${свои.map(н => {
                const ч = человек(н.person_id);
                const пометки = состоянияКлетки(н, ч, день, служба);
                return `
                <div class="плашкаИмени">
                    <span class="flex-1 min-w-0 leading-snug">
                        <a class="link link-hover text-sm ${пометки.зачеркнуть ? 'line-through opacity-60' : ''}"
                           href="people.html?id=${н.person_id}">${e(ч?.имя || 'кто-то')}</a>${
                            н.person_id === яЧеловек?.id ? ЗНАК_ВЫ : ''}
                        ${н.role !== 'pujari'
                            ? `<span class="badge badge-xs ml-0.5">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
                        ${пометки.список.map(([т, к]) =>
                            `<span class="badge badge-xs ${к} mt-0.5">${e(т)}</span>`).join('')}
                    </span>
                    ${можноВести()
                        ? `<button class="btn btn-ghost btn-xs no-print px-1 снятьВКлетке shrink-0"
                                   data-снять="${н.id}" title="Снять" aria-label="Снять">✕</button>` : ''}
                </div>`;
            }).join('')}
            ${безВедущего(свои, день) && день >= DateUtils.todayAshramISO()
                ? '<span class="block text-xs font-semibold text-error">нет ведущего</span>' : ''}
            ${можноВести()
                ? `<button class="btn btn-ghost btn-xs no-print ещёВКлетку" data-клетка="${день}"
                           data-служба="${служба?.id || ''}" data-разовая="${разовая?.id || ''}"
                           title="Поставить второго">+ ещё</button>`
                : ''}
        </td>`;
    }

    /**
     * Итог по дню. Неделю закрывают не ровным слоем: обычно проседают
     * один-два дня, и без этой строки их ищут глазами по всему столбцу.
     */
    function рисоватьИтогДней() {
        const список = дни();
        const сегодня = DateUtils.todayAshramISO();
        const активные = службы.filter(с => с.is_active);
        if (!активные.length && !отклонения.some(о => о.title)) {
            $('#итогДней').innerHTML = '';
            return;
        }

        // итог по дням — работа ведущего; читателю строка ни о чём не говорит
        $('#итогДней').hidden = !можноВести();
        $('#итогДней').innerHTML = `<tr>
            <td class="text-xs font-semibold">Закрыто за день</td>
            ${список.map(д => {
                const надо = активные.filter(с => !отменена(с.id, д)).length
                    + разовыеДня(д).length;
                const есть = активные.filter(с => !отменена(с.id, д)
                        && вКлетке(д, с.id).some(н => ведёт(н, д))).length
                    + разовыеДня(д).filter(о =>
                        вКлетке(д, null, о.id).some(н => ведёт(н, д))).length;
                const всё = надо && есть === надо;
                // худший день должен находиться взглядом, а не вычитанием
                return `<td class="${д === сегодня ? 'сегодня' : ''} tabular-nums font-semibold ${
                    !надо ? 'opacity-40' : всё ? 'text-success' : 'итогДыра'}">
                    ${надо ? `${есть} из ${надо}` : '—'}</td>`;
            }).join('')}
        </tr>`;
    }

    /**
     * Старший возвращается к готовой шахматке через час и должен видеть то же,
     * что система знала в момент назначения: кто без допуска, кто стоит на двух
     * службах сразу, кому надо сказать голосом. В модалке это гаснет вместе с ней.
     */
    function состоянияКлетки(н, ч, день, служба) {
        const список = [];
        let зачеркнуть = false;

        if (!ч) return { список, зачеркнуть };

        // В клетке остаётся только то, что требует действия. «Без допуска»
        // и «бот не подключён» — это состояния «ничего не случилось»: раньше
        // их рисовали у каждого человека в каждой клетке, полторы сотни серых
        // значков на неделю, и настоящий сигнал (человек уехал, человек стоит
        // на двух службах в одно время) в них тонул. Их место — в выборе
        // человека, когда старший решает, кого поставить.
        if (вОтъезде(ч.id, день)) { список.push(['в отъезде', 'badge-warning']); зачеркнуть = true; }
        if (ч.is_active === false) { список.push(['не в отделе', 'badge-warning']); зачеркнуть = true; }
        if (ч.active_to && ч.active_to < день) { список.push(['срок истёк', 'badge-warning']); зачеркнуть = true; }
        if (ч.active_from && ч.active_from > день) { список.push(['ещё не в отделе', 'badge-warning']); зачеркнуть = true; }
        // «нет допуска» — только у тех, кому допуски заданы: у кого их нет вовсе,
        // отметка горела бы в каждой клетке (так её и убирали). Видит ведущий
        if (можноВести() && служба && ч.допуск?.size && !ч.допуск.has(служба.id)) {
            список.push(['нет допуска', 'badge-warning']);
        }

        // «занят в это же время» — именно по времени, а не по дню: при четырёх
        // службах «в этот день» загорится у всех и перестанет что-либо значить
        const время = служба?.time_of_day
            || отклонения.find(о => о.id === н.override_id)?.time_of_day;
        const рядом = назначения.find(д => д.duty_date === день && д.person_id === н.person_id
            && д.id !== н.id
            && (службы.find(с2 => с2.id === д.service_id)?.time_of_day
                || отклонения.find(о => о.id === д.override_id)?.time_of_day) === время);
        if (рядом) {
            const где = службы.find(с2 => с2.id === рядом.service_id);
            список.push([`в это же время на «${где ? Layout.getName(где) : 'другой службе'}»`, 'badge-error']);
        }

        return { список, зачеркнуть };
    }


    // ---------- день ----------
    function рисоватьДень() {
        const д = выбранныйДень;
        const обычные = службы.filter(с => с.is_active).map(с => ({
            служба: с, разовая: null, время: с.time_of_day, имя: Layout.getName(с),
        }));
        const разовые = разовыеДня(д).map(о => ({
            служба: null, разовая: о, время: о.time_of_day, имя: о.title,
        }));
        const всё = [...обычные, ...разовые].sort((a, b) => (a.время || '').localeCompare(b.время || ''));

        $('#деньСписок').innerHTML = всё.map(({ служба, разовая, время, имя }) => {
            const отмена = служба && отменена(служба.id, д);
            const свои = отмена ? [] : вКлетке(д, служба?.id, разовая?.id);
            // день читается теми же цветами, что и неделя: закрыто — зелёным,
            // некому служить — жёлтым, иначе на телефоне состояние пришлось бы
            // вычитывать из слов «никто не поставлен»
            const прошло = д < DateUtils.todayAshramISO();
            const закрыта = свои.some(н => ведёт(н, д));
            const командой = свои.some(н => ведёт(н, д)
                && (человек(н.person_id)?.kind || 'team') === 'team');
            const краска = отмена || прошло ? ''
                : закрыта ? (командой ? ' закрыта командой' : ' закрыта волонтёром') : ' дыра';
            return `
            <li class="клеткаДня${краска} border-b border-base-200 last:border-0 py-3 px-3 -mx-3">
                <div class="flex flex-wrap items-baseline gap-2">
                    <span class="font-semibold">${e((время || '').slice(0, 5))}</span>
                    ${служба?.article_id
                        ? `<a class="link font-semibold" href="article.html?id=${служба.article_id}">${e(имя)}</a>`
                        : `<span class="font-semibold">${e(имя)}</span>`}
                    ${разовая ? '<span class="badge badge-sm">разовая</span>' : ''}
                    ${отмена ? '<span class="badge badge-sm badge-warning">не проводится</span>' : ''}
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2">
                    ${свои.length
                        ? свои.map(н => {
                            // тот же сигнал, что в неделе: уехавший или выбывший зачёркнут
                            // и назван причиной — иначе на телефоне клетка жёлтая,
                            // а имя в ней стоит как ни в чём не бывало
                            const { список: пометки, зачеркнуть } =
                                состоянияКлетки(н, человек(н.person_id), д, служба);
                            return `
                            <a class="link link-hover text-sm ${зачеркнуть ? 'line-through opacity-70' : ''}"
                               href="people.html?id=${н.person_id}">
                                ${e(человек(н.person_id)?.имя || 'кто-то')}</a>${
                                н.person_id === яЧеловек?.id ? ЗНАК_ВЫ : ''}
                            ${пометки.map(([т, к]) => `<span class="badge badge-sm ${к}">${e(т)}</span>`).join('')}
                            ${н.role !== 'pujari'
                                ? `<span class="badge badge-xs">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
                            ${можноВести()
                                ? `<button class="btn btn-ghost btn-sm px-2" data-снять="${н.id}" aria-label="Снять">✕</button>` : ''}`;
                        }).join('')
                        : ''}
                    ${безВедущего(свои, д) && !прошло
                        ? '<span class="text-sm font-semibold text-error">нет ведущего</span>' : ''}
                    ${свои.length ? '' : `<span class="text-sm ${отмена || д < DateUtils.todayAshramISO()
                                ? 'opacity-40' : 'opacity-60'}">${
                            отмена ? '' : (д < DateUtils.todayAshramISO()
                                ? 'никого не ставили' : 'никто не поставлен')}</span>`}
                    ${можноВести() && !отмена && д >= DateUtils.todayAshramISO()
                        ? `<button class="btn btn-xs btn-outline" data-клетка="${д}"
                                   data-служба="${служба?.id || ''}"
                                   data-разовая="${разовая?.id || ''}">поставить</button>` : ''}
                </div>
            </li>`;
        }).join('') || '<li class="py-3 text-sm opacity-60">На этот день служб нет</li>';
    }

    function рисоватьОтклонения() {
        const свои = отклонения.slice().sort((a, b) => a.duty_date.localeCompare(b.duty_date));
        $('#отклоненияСписок').innerHTML = свои.map(о => `
            <li class="flex flex-wrap items-center gap-2 border-b border-base-200 last:border-0 py-2">
                <span class="font-semibold">${DateUtils.formatShort(DateUtils.parseDate(о.duty_date))}</span>
                <span class="flex-1 min-w-0">
                    ${о.title
                        ? `${e(о.title)} <span class="badge badge-sm">разовая, ${e((о.time_of_day || '').slice(0, 5))}</span>`
                        : `${e(Layout.getName(службы.find(с => с.id === о.service_id) || {}) || 'служба')}
                           <span class="badge badge-sm badge-warning">не проводится</span>`}
                    ${о.reason ? `<span class="block text-sm opacity-60">${e(о.reason)}</span>` : ''}
                </span>
                <button class="btn btn-ghost btn-xs" data-правитьОтклонение="${о.id}"
                        title="Изменить" aria-label="Изменить">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M16.86 4.49l2.65 2.65M4 20l4.24-.88L19.5 7.86a1.87 1.87 0 0 0-2.65-2.65L5.59 16.47 4 20z"/></svg>
                </button>
                <button class="btn btn-ghost btn-xs text-error" data-убратьОтклонение="${о.id}"
                        title="Убрать" aria-label="Убрать">✕</button>
            </li>`).join('') ||
            '<li class="py-2 text-sm opacity-60">На этой неделе отклонений нет</li>';
    }

    function рисовать() {
        рисоватьШапку();
        рисоватьМои();
        // рисуем оба вида, показываем один: при печати со страницы «день»
        // на бумагу идёт неделя, и пустая таблица была бы сюрпризом
        рисоватьНеделю();
        рисоватьИтогДней();
        рисоватьДень();
        рисоватьОтклонения();
        window.applyPermissions?.();
    }

    async function перечитать(всё = true) {
        if (await загрузить(всё)) рисовать();
    }

    /**
     * «Старший в отъезде» — это причина, по которой клетки стоят пустыми,
     * а правки не утверждаются. Молчать об этом нельзя.
     */
    async function старшийВОтъезде() {
        const { data, error } = await Layout.db.rpc('worship_approvers_away');
        if (error || !data?.length) return;
        const кто = data.map(x => x['имя'] +
            (x['по'] ? ` до ${DateUtils.formatShort(DateUtils.parseDate(x['по']))}` : '')).join(', ');
        $('#старшийОтъезд').hidden = false;
        $('#старшийОтъезд').textContent = `В отъезде: ${кто}. Расписание и утверждение правок ждут его.`;
    }

    // ---------- назначение ----------
    function открытьНазначение(день, serviceId, overrideId) {
        клетка = { день, serviceId: serviceId || null, overrideId: overrideId || null };
        const с = службы.find(x => x.id === serviceId);
        const о = отклонения.find(x => x.id === overrideId);
        $('#нЗаголовок').textContent = `${с ? Layout.getName(с) : (о?.title || 'Служба')} — ${
            DateUtils.formatWithWeekday(DateUtils.parseDate(день))}`;
        $('#нПодсказка').textContent = 'Пометки подсказывают, но не запрещают — кроме отъезда: ' +
            'пока человек отмечен, поставить его нельзя, сначала снимите отметку.';
        $('#нПоиск').value = '';
        $('#нКто').value = 'all';
        выбратьРоль('pujari');
        $('#назначение').showModal();
    }

    const coalesceId = н => н.service_id || н.override_id;

    /** Роль, в которой ставим человека в клетку: ведущий, помощник, киртания. */
    let рольКлетки = 'pujari';
    function выбратьРоль(роль) {
        рольКлетки = роль;
        $('#нРоль').querySelectorAll('[data-роль]').forEach(к => {
            const выбрана = к.dataset.роль === роль;
            к.setAttribute('aria-checked', выбрана);
            к.style.background = выбрана ? 'var(--current-color)' : '';
            к.style.color = выбрана ? '#fff' : '';
        });
        рисоватьЛюдейДляКлетки();
    }

    function рисоватьЛюдейДляКлетки() {
        const q = $('#нПоиск').value.trim().toLowerCase();
        const { день, serviceId } = клетка;
        const роль = рольКлетки;
        const кто = $('#нКто').value;
        // «уже стоит» — в этой же роли: пуджари и киртания в одной клетке разные люди
        const уже = new Set(вКлетке(день, serviceId, клетка.overrideId)
            .filter(н => н.role === роль).map(н => н.person_id));

        const строки = люди
            .filter(ч => ч.is_active && (!q || ч.имя.toLowerCase().includes(q))
                && (кто === 'all' || (ч.kind || 'team') === кто))
            .map(ч => {
                const пометки = [];
                if (вОтъезде(ч.id, день)) пометки.push(['в отъезде', 'badge-error']);
                // как в клетке: «нет допуска» — тем, кому допуски вообще заданы
                if (serviceId && ч.допуск.size && !ч.допуск.has(serviceId)) пометки.push(['нет допуска', 'badge-warning']);
                // «уже на Арати Туласи в это время» точнее, чем «занят в этот день»:
                // при четырёх службах второе загорится у всех
                const времяКлетки = службы.find(с2 => с2.id === serviceId)?.time_of_day
                    || отклонения.find(о => о.id === клетка.overrideId)?.time_of_day;
                const рядом = назначения.find(н => н.duty_date === день && н.person_id === ч.id
                    && (службы.find(с2 => с2.id === н.service_id)?.time_of_day
                        || отклонения.find(о => о.id === н.override_id)?.time_of_day) === времяКлетки
                    && coalesceId(н) !== (serviceId || клетка.overrideId));
                if (рядом) {
                    const где = службы.find(с2 => с2.id === рядом.service_id);
                    пометки.push([`уже на «${где ? Layout.getName(где) : 'другой службе'}» в это время`, 'badge-error']);
                } else if (назначения.some(н => н.duty_date === день && н.person_id === ч.id && !уже.has(ч.id))) {
                    пометки.push(['в этот день уже занят', 'badge-ghost']);
                }
                if (ч.active_to && ч.active_to < день) пометки.push(['срок участия истёк', 'badge-warning']);
                if (ч.active_from && ч.active_from > день) пометки.push(['ещё не в отделе', 'badge-warning']);
                if (ч.безВхода) пометки.push(['нет входа — скажите голосом', 'badge-ghost']);
                else if (ч.безБота) пометки.push(['без Телеграма', 'badge-ghost']);
                // вес — чтобы подходящие были сверху: раньше единственный допущенный
                // и свободный стоял пятым по алфавиту, и на телефоне его искали прокруткой
                const вес = пометки.reduce((м, [т, к]) => Math.max(м,
                    к === 'badge-error' || т.includes('срок') || т.includes('не в отделе') ? 3
                    : т === 'нет допуска' ? 2 : т.includes('уже занят') ? 1 : 0), 0);
                return { ч, пометки, стоит: уже.has(ч.id), вес };
            })
            .sort((a, b) => a.вес - b.вес || a.ч.имя.localeCompare(b.ч.имя, 'ru'));

        $('#нСписок').innerHTML = строки.map(({ ч, пометки, стоит }) => `
            <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${e(ч.имя)}</span>
                    ${кто === 'all' && ч.kind === 'volunteer'
                        ? '<span class="badge badge-sm badge-outline ml-1">волонтёр</span>' : ''}
                    ${пометки.map(([т, к]) => `<span class="badge badge-sm ${к} ml-1">${e(т)}</span>`).join('')}
                </span>
                ${стоит
                    ? '<span class="text-sm opacity-60">уже стоит</span>'
                    : `<button class="btn btn-sm btn-outline" data-поставить="${ч.id}">Поставить</button>`}
            </li>`).join('') || '<li class="py-3 text-sm opacity-60">Никого не нашлось</li>';
    }

    async function поставить(personId) {
        const { data, error } = await Layout.db.rpc('worship_duty_set', {
            p_date: клетка.день,
            p_person: personId,
            p_service: клетка.serviceId,
            p_override: клетка.overrideId,
            p_role: рольКлетки,
        });
        if (error) return Layout.handleError(error, 'Назначение');

        const предупр = data?.['предупреждения'] || [];
        $('#назначение').close();
        await перечитать();
        Layout.showNotification(
            предупр.length ? `Поставлен: ${предупр.join('; ')}` : 'Поставлен',
            предупр.length ? 'warning' : 'success');
    }

    // ---------- службы ----------
    function рисоватьСлужбы() {
        $('#службыСписок').innerHTML = службы.map((с, i) => `
            <li class="flex flex-wrap items-center gap-2 border-b border-base-200 last:border-0 py-2
                       ${с.is_active ? '' : 'opacity-50'}">
                <input class="input input-bordered input-sm flex-1 min-w-40" value="${e(с.name_ru)}"
                       data-служба-имя="${с.id}" maxlength="100">
                <input type="time" class="input input-bordered input-sm w-28" value="${e(с.time_of_day.slice(0, 5))}"
                       data-служба-время="${с.id}" aria-label="Время начала">
                <!-- сколько служба занимает: по этому «Загрузка» считает часы -->
                <label class="input input-bordered input-sm w-24 flex items-center gap-1">
                    <input type="number" min="5" max="720" step="5" class="w-full min-w-0 tabular-nums"
                           value="${с.duration_minutes ?? ''}" placeholder="—"
                           data-служба-длительность="${с.id}" aria-label="Длительность, минут">
                    <span class="opacity-60 text-xs">мин</span>
                </label>
                <select class="select select-bordered select-sm w-44" data-служба-стандарт="${с.id}">
                    <option value="">стандарта нет</option>
                    ${стандарты.map(а => `<option value="${а.id}"${
                        а.id === с.article_id ? ' selected' : ''}>${e(а.title)}</option>`).join('')}
                </select>
                <button class="btn btn-ghost btn-xs" data-служба-двигать="-1" data-id="${с.id}"
                        ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-ghost btn-xs" data-служба-двигать="1" data-id="${с.id}"
                        ${i === службы.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-ghost btn-xs" data-служба-включение="${с.id}">${
                    с.is_active ? 'отключить' : 'включить'}</button>
            </li>`).join('') || '<li class="py-2 text-sm opacity-60">Служб пока нет</li>';
    }

    async function записать(запрос, что) {
        const { data, error } = await запрос.select('id');
        if (error) { Layout.handleError(error, что); return false; }
        if (!data?.length) {
            Layout.showNotification('Не сохранилось: это ведёт старший пуджари', 'error');
            return false;
        }
        return true;
    }


    // ---------- отклонения ----------
    /**
     * Окно разовой службы или отмены. С «было» — правка: у разовой меняются
     * название, время, длительность, причина и день (люди переезжают вместе
     * с ней — так делает база), у отмены — только причина.
     */
    function открытьОтклонение(какое, было = null) {
        $('#оЗаголовок').textContent = какое === 'разовая'
            ? (было ? 'Разовая служба — правка' : 'Разовая служба')
            : (было ? 'Отмена — правка причины' : 'Служба в этот день не проводится');
        $('#оРазовая').hidden = какое !== 'разовая';
        $('#оСлужбаБлок').hidden = какое === 'разовая';
        $('#оДата').value = было?.duty_date || (вид === 'день' ? выбранныйДень : дни()[0]);
        $('#оДата').disabled = !!было && какое !== 'разовая';
        $('#оНазвание').value = было?.title || '';
        $('#оВремя').value = (было?.time_of_day || '').slice(0, 5);
        $('#оДлительность').value = было?.duration_minutes || '';
        $('#оПричина').value = было?.reason || '';
        $('#оСлужба').innerHTML = службы.filter(с => с.is_active || с.id === было?.service_id)
            .map(с => `<option value="${с.id}">${e(Layout.getName(с))} (${e(с.time_of_day.slice(0, 5))})</option>`).join('');
        if (было?.service_id) $('#оСлужба').value = было.service_id;
        $('#оСлужба').disabled = !!было;
        const стоят = было ? назначения.filter(н => н.override_id === было.id).length : 0;
        $('#оПодсказка').hidden = !стоят;
        $('#оПодсказка').textContent = стоят
            ? `На службе ${Layout.pluralize(стоят, { ru: ['человек', 'человека', 'человек'],
                en: ['person', 'people'], hi: 'व्यक्ति' })}: при смене дня они переедут вместе с ней, `
              + 'а об изменении времени или дня им придёт сообщение в Телеграм.'
            : '';
        $('#отклонениеМодал').dataset.какое = какое;
        $('#отклонениеМодал').dataset.id = было?.id || '';
        $('#отклонениеМодал').showModal();
    }

    async function сохранитьПравкуОтклонения(id, какое) {
        const дата = $('#оДата').value;
        const правка = { reason: $('#оПричина').value.trim() || null };
        if (какое === 'разовая') {
            if (!дата) return Layout.showNotification('Укажите день', 'warning');
            if (!$('#оНазвание').value.trim() || !$('#оВремя').value) {
                return Layout.showNotification('У разовой службы нужны название и время', 'warning');
            }
            const минут = минутИзПоля($('#оДлительность'));
            if (минут === false) return;
            Object.assign(правка, { duty_date: дата, title: $('#оНазвание').value.trim(),
                                    time_of_day: $('#оВремя').value, duration_minutes: минут });
        }
        const { error } = await Layout.db.from('worship_day_overrides').update(правка).eq('id', id);
        if (error) return Layout.handleError(error, 'Отклонение дня');
        $('#отклонениеМодал').close();
        Layout.showNotification('Сохранено', 'success');
        if (какое === 'разовая') {
            началоНедели = началоОт(DateUtils.parseDate(дата));
            выбранныйДень = дата;
        }
        await перечитать();
    }

    async function сохранитьОтклонение() {
        const какое = $('#отклонениеМодал').dataset.какое;
        const правим = $('#отклонениеМодал').dataset.id;
        if (правим) return сохранитьПравкуОтклонения(правим, какое);
        const дата = $('#оДата').value;
        if (!дата) return Layout.showNotification('Укажите день', 'warning');

        const строка = {
            duty_date: дата,
            reason: $('#оПричина').value.trim() || null,
            created_by: window.currentUser?.id || null,
        };
        if (какое === 'разовая') {
            if (!$('#оНазвание').value.trim() || !$('#оВремя').value) {
                return Layout.showNotification('У разовой службы нужны название и время', 'warning');
            }
            const минут = минутИзПоля($('#оДлительность'));
            if (минут === false) return;
            строка.title = $('#оНазвание').value.trim();
            строка.time_of_day = $('#оВремя').value;
            строка.duration_minutes = минут;
        } else {
            if (!$('#оСлужба').value) return Layout.showNotification('Выберите службу', 'warning');
            строка.service_id = $('#оСлужба').value;
        }

        // предупреждаем до вставки: иначе отмена тихо оставляет людей на службе
        if (какое !== 'разовая') {
            // спрашиваем базу, а не открытую неделю: день отмены часто лежит
            // за её пределами, и тогда предупреждение молчало при занятой клетке
            const { data: занятые, error: ошСтоят } = await Layout.db.from('worship_duties')
                .select('id').eq('duty_date', дата).eq('service_id', строка.service_id);
            if (ошСтоят) return Layout.handleError(ошСтоят, 'Отклонение дня');
            const стоят = занятые || [];
            if (стоят.length && !await спросить('На эту службу уже кто-то поставлен',
                `${Layout.pluralize(стоят.length, {
                    ru: ['человек останется', 'человека останутся', 'человек останутся'],
                    en: ['person stays', 'people stay'], hi: 'व्यक्ति' })} в клетке после отмены. ` +
                'Их придётся снять вручную — так отмена «на пробу» не стирает расстановку. Продолжить?')) {
                return;
            }
        }

        const { error } = await Layout.db.from('worship_day_overrides').insert(строка);
        if (error) {
            if (error.code === '23505') {
                return Layout.showNotification('Эта служба в этот день уже отмечена', 'warning');
            }
            return Layout.handleError(error, 'Отклонение дня');
        }
        $('#отклонениеМодал').close();
        // дата может лежать вне открытой недели — перейдём к ней, иначе правка «пропадёт»
        началоНедели = началоОт(DateUtils.parseDate(дата));
        выбранныйДень = дата;
        await перечитать();
    }

    /** Кнопка занята, пока идёт её дело: второй щелчок не создаёт дубль. */
    async function разом(кнопка, дело) {
        if (кнопка.disabled) return;
        кнопка.disabled = true;
        try { return await дело(); } finally { кнопка.disabled = false; }
    }

    // ---------- слушатели ----------
    function слушать() {
        document.addEventListener('click', async ev => {
            const снятьМою = ev.target.closest('[data-снятьМою]');
            if (снятьМою) {
                return разом(снятьМою, async () => {
                    const { error } = await Layout.db.rpc('worship_absence_clear',
                        { p_absence: снятьМою.getAttribute('data-снятьМою') });
                    if (error) return Layout.handleError(error, 'Недоступность');
                    await перечитать();
                    Layout.showNotification('Отметка снята — вы снова в расписании', 'success');
                });
            }

            const кл = ev.target.closest('[data-клетка]');
            if (кл) return открытьНазначение(кл.dataset.клетка, кл.dataset.служба, кл.dataset.разовая);

            const пост = ev.target.closest('[data-поставить]');
            if (пост) return разом(пост, () => поставить(пост.dataset.поставить));

            const снять = ev.target.closest('[data-снять]');
            if (снять) {
                // в вопросе — кого и откуда: ✕ стоит рядом с именем, и в
                // недельной сетке легко задеть соседнюю клетку
                const н = назначения.find(x => x.id === снять.dataset.снять);
                const кто = н && человек(н.person_id)?.имя;
                if (!await спросить(кто ? `Снять ${кто}?` : 'Снять назначение?',
                    н ? `${имяСлужбы(н)}, ${деньПоЧеловечески(н.duty_date)}. `
                        + 'Клетка останется пустой — поставьте другого.' : '')) return;
                const { error } = await Layout.db.rpc('worship_duty_clear', { p_duty: снять.dataset.снять });
                if (error) return Layout.handleError(error, 'Назначение');
                return перечитать();
            }

            const правО = ev.target.closest('[data-правитьОтклонение]');
            if (правО) {
                const о = отклонения.find(x => x.id === правО.getAttribute('data-правитьОтклонение'));
                if (о) открытьОтклонение(о.title ? 'разовая' : 'отмена', о);
                return;
            }

            const убрО = ev.target.closest('[data-убратьОтклонение]');
            if (убрО) {
                if (!await спросить('Убрать отклонение дня?',
                    'Служба вернётся в обычный распорядок, а разовая исчезнет вместе с назначениями.')) return;
                const { error } = await Layout.db.from('worship_day_overrides')
                    .delete().eq('id', убрО.getAttribute('data-убратьОтклонение'));
                if (error) return Layout.handleError(error, 'Отклонение дня');
                return перечитать();
            }

            const дв = ev.target.closest('[data-служба-двигать]');
            if (дв) {
                const i = службы.findIndex(с => с.id === дв.dataset.id);
                const j = i + Number(дв.getAttribute('data-служба-двигать'));
                if (i < 0 || j < 0 || j >= службы.length) return;
                // меняем местами позиции в списке и записываем номера заново:
                // обмен значениями бессилен, когда у двух служб номер совпал
                const порядок = службы.map(с => с.id);
                [порядок[i], порядок[j]] = [порядок[j], порядок[i]];
                for (const [номер, id] of порядок.entries()) {
                    const было = службы.find(с => с.id === id)?.sort_order;
                    if (было === номер) continue;
                    const ок = await записать(Layout.db.from('worship_services')
                        .update({ sort_order: номер }).eq('id', id), 'Порядок служб');
                    if (!ок) return;
                }
                await перечитать();
                return рисоватьСлужбы();
            }

            const вкл = ev.target.closest('[data-служба-включение]');
            if (вкл) {
                const с = службы.find(x => x.id === вкл.getAttribute('data-служба-включение'));
                if (!с) return перечитать();     // кнопка от прежней отрисовки
                const ок = await записать(Layout.db.from('worship_services')
                    .update({ is_active: !с.is_active, updated_at: new Date().toISOString(),
                              updated_by: window.currentUser?.id || null })
                    .eq('id', с.id), 'Служба');
                if (!ок) return;
                await перечитать();
                return рисоватьСлужбы();
            }

            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'назад' || b.id === 'вперёд') {
                const знак = b.id === 'назад' ? -1 : 1;
                if (вид === 'день') {
                    const д = DateUtils.parseDate(выбранныйДень);
                    д.setDate(д.getDate() + знак);
                    выбранныйДень = DateUtils.toISO(д);
                    началоНедели = началоОт(д);
                } else {
                    // новый объект, а не setDate на прежнем: загрузка, которая
                    // ещё идёт, держит ссылку на старое начало недели
                    const д = new Date(началоНедели);
                    д.setDate(д.getDate() + 7 * знак);
                    началоНедели = д;
                    // выбранный день едет вместе с неделей: иначе вид «день»
                    // показывал бы дату, назначений которой нет среди загруженных,
                    // и честно писал «никто не поставлен» при заполненном дне
                    выбранныйДень = DateUtils.toISO(д);
                }
                return перечитать(false);
            }
            if (b.id === 'сегодня') {
                началоНедели = началоОт(DateUtils.nowAshram());
                выбранныйДень = DateUtils.todayAshramISO();
                return перечитать(false);
            }
            if (b.dataset.вид) {
                вид = b.dataset.вид;
                if (!дни().includes(выбранныйДень)) выбранныйДень = дни()[0];
                return рисовать();
            }
            if (b.id === 'печать') return print();
            if (b.id === 'вестиСлужбы') { рисоватьСлужбы(); return $('#службыМодал').showModal(); }
            if (b.id === 'сДобавить') return разом(b, добавитьСлужбу);
            if (b.id === 'разовая') return открытьОтклонение('разовая');
            if (b.id === 'отменить') return открытьОтклонение('отмена');
            if (b.id === 'оСохранить') return разом(b, сохранитьОтклонение);
            if (b.id === 'копияНедели') return открытьПовтор();
            if (b.id === 'повторПустить') return копияНедели();
            if (b.id === 'яНеСмогу') {
                $('#оtС').value = DateUtils.todayAshramISO();
                $('#оtПо').value = '';
                $('#оtПричина').value = '';
                return $('#отметкаМодал').showModal();
            }
            if (b.id === 'оtСохранить') return разом(b, отметитьОтъезд);
        });

        // правка названия и времени службы — по уходу из поля
        document.addEventListener('change', async ev => {
            const имя = ev.target.closest('[data-служба-имя]');
            const время = ev.target.closest('[data-служба-время]');
            const стандарт = ev.target.closest('[data-служба-стандарт]');
            const длительность = ev.target.closest('[data-служба-длительность]');
            if (!имя && !время && !стандарт && !длительность) return;
            const поле = имя || время || стандарт || длительность;
            const id = поле.getAttribute(имя ? 'data-служба-имя'
                : время ? 'data-служба-время'
                : стандарт ? 'data-служба-стандарт' : 'data-служба-длительность');
            const минут = длительность ? минутИзПоля(поле) : null;
            if (минут === false) return;
            const правка = имя ? { name_ru: поле.value.trim() }
                : время ? { time_of_day: поле.value }
                : стандарт ? { article_id: поле.value || null }
                : { duration_minutes: минут };
            if (имя && !правка.name_ru) return Layout.showNotification('Без названия службу не найти', 'warning');
            const ок = await записать(Layout.db.from('worship_services')
                .update({ ...правка, updated_at: new Date().toISOString(),
                          updated_by: window.currentUser?.id || null })
                .eq('id', id), 'Служба');
            if (ок) await перечитать();
        });

        $('#нПоиск').addEventListener('input', Layout.debounce(рисоватьЛюдейДляКлетки, 200));
        $('#нРоль').addEventListener('click', ev => {
            const к = ev.target.closest('[data-роль]');
            if (к) выбратьРоль(к.dataset.роль);
        });
        $('#нКто').addEventListener('change', рисоватьЛюдейДляКлетки);
        ['#повторОткуда', '#повторСколько'].forEach(s2 =>
            $(s2).addEventListener('change', пересчитатьПовтор));
    }

    /**
     * Минуты из поля длительности: пусто — «не указано» (null),
     * вне 5…720 — false и подсказка (база такое всё равно не примет).
     */
    function минутИзПоля(поле) {
        if (поле.value === '') return null;
        const м = Math.round(Number(поле.value));
        if (!Number.isFinite(м) || м < 5 || м > 720) {
            Layout.showNotification('Длительность — от 5 минут до 12 часов', 'warning');
            return false;
        }
        return м;
    }

    async function добавитьСлужбу() {
        const имя = $('#сНазвание').value.trim();
        const время = $('#сВремя').value;
        if (!имя || !время) return Layout.showNotification('Нужны название и время', 'warning');
        const минут = минутИзПоля($('#сДлительность'));
        if (минут === false) return;

        const { error } = await Layout.db.from('worship_services').insert({
            name_ru: имя,
            time_of_day: время,
            duration_minutes: минут,
            sort_order: Math.max(0, ...службы.map(с => с.sort_order ?? 0)) + 1,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Служба');
        $('#сНазвание').value = '';
        $('#сВремя').value = '';
        $('#сДлительность').value = '';
        await перечитать();
        рисоватьСлужбы();
    }

    /** Своя отметка недоступности: то же, что на странице людей, но под рукой. */
    async function отметитьОтъезд() {
        const с = $('#оtС').value;
        if (!с) return Layout.showNotification('Укажите, с какого дня', 'warning');

        const { data, error } = await Layout.db.rpc('worship_absence_set', {
            p_person: яЧеловек.id, p_from: с, p_to: $('#оtПо').value || null,
            p_reason: $('#оtПричина').value.trim() || null,
        });
        if (error) return Layout.handleError(error, 'Недоступность');

        $('#отметкаМодал').close();
        await перечитать();
        const клеток = data?.['назначений'] || 0;
        Layout.showNotification(клеток
            ? `Отмечено. На эти дни у вас ${Layout.pluralize(клеток, {
                  ru: ['назначение', 'назначения', 'назначений'],
                  en: ['duty', 'duties'], hi: 'सेवा' })} — старший увидит и заменит`
            : 'Отмечено', 'success');
    }

    /**
     * Повтор недели. Раньше вопрос «Повторить прошлую неделю?» не называл
     * ни дат, ни числа назначений, а источник был один — предыдущая неделя.
     * Но прошлая неделя бывает праздничной или полупустой, а расписать
     * хочется сразу месяц.
     */
    const началоНеделиСдвигом = н => {
        const д = new Date(началоНедели);
        д.setDate(д.getDate() + 7 * н);
        return д;
    };

    const периодСловами = от => {
        const до = new Date(от);
        до.setDate(до.getDate() + 6);
        return `${DateUtils.formatShort(от)} — ${DateUtils.formatShort(до)}`;
    };

    async function открытьПовтор() {
        // источники: четыре недели назад от открытой
        $('#повторОткуда').innerHTML = [1, 2, 3, 4].map(н => {
            const от = началоНеделиСдвигом(-н);
            const имя = н === 1 ? 'прошлая неделя' : `${н} недели назад`;
            return `<option value="${н}">${имя} · ${периодСловами(от)}</option>`;
        }).join('');
        $('#повторСколько').value = '1';
        await пересчитатьПовтор();
        $('#повторМодал').showModal();
    }

    /** Сколько назначений лежит в выбранной неделе-источнике и куда они лягут. */
    async function пересчитатьПовтор() {
        const назад = Number($('#повторОткуда').value || 1);
        const сколько = Number($('#повторСколько').value || 1);
        const от = началоНеделиСдвигом(-назад);
        const доИсточника = new Date(от);
        доИсточника.setDate(доИсточника.getDate() + 6);
        const конецПриёмника = началоНеделиСдвигом(сколько - 1);
        конецПриёмника.setDate(конецПриёмника.getDate() + 6);

        const узел = $('#повторИтог');
        узел.textContent = 'Считаю…';

        // повтор в прошлое бессмыслен: клетки, которые уже прошли, никто не закроет
        const сегодня = DateUtils.todayAshramISO();
        const вПрошлое = DateUtils.toISO(началоНедели) < сегодня;
        $('#повторПустить').disabled = вПрошлое;
        if (вПрошлое) {
            узел.innerHTML = 'Открыта прошедшая неделя: повторять в прошлое незачем. '
                + 'Нажмите «Сегодня» и откройте повтор оттуда.';
            return;
        }

        // считаем то, что функция и правда возьмёт: назначения отключённых
        // служб и выбывших людей не переезжают — в обещании их быть не должно
        const { data, error } = await Layout.db.from('worship_duties')
            .select('id, service_id, person_id')
            .gte('duty_date', DateUtils.toISO(от))
            .lte('duty_date', DateUtils.toISO(доИсточника));
        if (error) { узел.textContent = 'Не удалось посчитать — повтор всё равно сработает'; return; }
        const count = (data || []).filter(н => н.service_id
            && службы.find(с => с.id === н.service_id)?.is_active
            && человек(н.person_id)?.is_active !== false).length;

        узел.innerHTML = count
            ? `Возьмём <b>${Layout.pluralize(count, {
                   ru: ['назначение', 'назначения', 'назначений'],
                   en: ['duty', 'duties'], hi: 'सेवा' })}</b> за ${периодСловами(от)}<br>
               и повторим на ${периодСловами(началоНедели)}${сколько > 1
                   ? ` и дальше, по ${DateUtils.formatShort(конецПриёмника)}` : ''}.`
            : `За ${периодСловами(от)} никого не ставили — переносить нечего.`;
    }

    async function копияНедели() {
        const кнопка = $('#повторПустить');
        if (кнопка.disabled) return;          // второй щелчок, пока идёт первый
        const назад = Number($('#повторОткуда').value || 1);
        const сколько = Number($('#повторСколько').value || 1);

        const итог = { перенесено: 0, уже: 0, занято: 0, отменено: 0 };
        const недоступны = new Set(), срок = new Set();

        // каждую неделю переносим отдельным вызовом: функция идемпотентна,
        // уже стоящие назначения второй раз не создаются
        кнопка.disabled = true;
        try {
            for (let i = 0; i < сколько; i++) {
                const { data, error } = await Layout.db.rpc('worship_week_copy', {
                    p_from: DateUtils.toISO(началоНеделиСдвигом(-назад)),
                    p_to: DateUtils.toISO(началоНеделиСдвигом(i)),
                });
                if (error) return Layout.handleError(error, 'Повтор недели');
                итог.перенесено += data?.['перенесено'] ?? 0;
                итог.уже += data?.['уже_стояли'] ?? 0;
                итог.занято += data?.['занято'] ?? 0;
                итог.отменено += data?.['отменено'] ?? 0;
                (data?.['недоступны'] || []).forEach(имя => недоступны.add(имя));
                (data?.['срок_вышел'] || []).forEach(имя => срок.add(имя));
            }
        } finally {
            кнопка.disabled = false;
        }

        $('#повторМодал').close();
        await перечитать();

        const назн = n => Layout.pluralize(n, {
            ru: ['назначение', 'назначения', 'назначений'], en: ['duty', 'duties'], hi: 'सेवा' });
        const всего = итог.перенесено + итог.уже + итог.занято + итог.отменено
            + недоступны.size + срок.size;
        if (!всего) {
            return Layout.showNotification('Переносить нечего: в той неделе никого не ставили', 'warning');
        }
        // каждая причина — своими словами: «пропущено: 3» не говорит, что делать дальше
        const части = [итог.перенесено ? `Поставлено: ${назн(итог.перенесено)}` : 'Новых назначений нет'];
        if (итог.уже) части.push(`уже стояли: ${итог.уже}`);
        if (итог.занято) части.push(`клетки, расписанные вручную, не тронуты: ${итог.занято}`);
        if (итог.отменено) части.push(`служба в тот день отменена: ${итог.отменено}`);
        if (недоступны.size) части.push(`в отъезде: ${[...недоступны].join(', ')}`);
        if (срок.size) части.push(`срок участия кончится: ${[...срок].join(', ')}`);
        Layout.showNotification(части.join('; ') + '.',
            итог.перенесено ? 'success' : 'info');
    }

    async function init() {
        // ?день=2026-10-21[&вид=неделя] — сюда ведут клетки «Загрузки»:
        // старший видит дыру и сразу попадает в нужный день
        const адрес = new URLSearchParams(location.search);
        const день = адрес.get('день');
        if (/^\d{4}-\d{2}-\d{2}$/.test(день || '')) {
            выбранныйДень = день;
            началоНедели = началоОт(DateUtils.parseDate(день));
            вид = адрес.get('вид') === 'неделя' ? 'неделя' : 'день';
        }
        слушать();
        if (!await загрузить()) return;
        рисовать();
        await старшийВОтъезде();
    }

    return { init };
})();
