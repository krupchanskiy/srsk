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
    const ДНИ = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

    // Расписание ведут вперёд, поэтому неделя считается от сегодняшнего дня,
    // а не от понедельника. На календарной неделе в воскресенье открывались
    // шесть прошедших дней и один сегодняшний: смотреть там нечего, и первым
    // движением старший жал «›». Теперь слева всегда сегодня, справа — то,
    // что предстоит расписать.
    let началоНедели = (() => {
        const д = new Date();
        д.setHours(0, 0, 0, 0);
        return д;
    })();
    let выбранныйДень = DateUtils.toISO(new Date());
    let вид = window.matchMedia('(max-width: 900px)').matches ? 'день' : 'неделя';

    let службы = [], люди = [], назначения = [], отклонения = [], отметки = [], стандарты = [];
    let мои = [], моиОтклонения = [];   // свои службы вперёд, независимо от открытой недели
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
    async function загрузить() {
        const от = дни()[0], до = дни()[6];

        const [с, л, н, о, от2] = await Promise.all([
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, sort_order, article_id, is_active')
                .order('sort_order').order('time_of_day'),
            Layout.db.from('worship_people')
                .select('id, vaishnava_id, active_from, active_to, is_active, kind'),
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, person_id, role')
                .gte('duty_date', от).lte('duty_date', до),
            Layout.db.from('worship_day_overrides')
                .select('id, duty_date, service_id, title, time_of_day, reason')
                .gte('duty_date', от).lte('duty_date', до),
            Layout.db.from('worship_absences')
                .select('id, person_id, date_from, date_to, reason')
                .lte('date_from', до),
        ]);
        const ошибка = с.error || л.error || н.error || о.error || от2.error;
        if (ошибка) { Layout.handleError(ошибка, 'Расписание'); return false; }

        службы = с.data || [];
        назначения = н.data || [];
        отклонения = о.data || [];
        // бессрочная отметка не имеет даты окончания — её не отфильтровать запросом
        отметки = (от2.data || []).filter(а => !а.date_to || а.date_to >= от);

        люди = л.data || [];
        const ids = люди.map(ч => ч.vaishnava_id);
        if (ids.length) {
            const { data } = await Layout.db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name, user_id, telegram_chat_id')
                .in('id', ids);
            const карточки = Object.fromEntries((data || []).map(в => [в.id, в]));
            люди = люди.map(ч => {
                const в = карточки[ч.vaishnava_id] || {};
                return {
                    ...ч,
                    имя: в.spiritual_name ||
                        `${в.first_name || ''} ${в.last_name || ''}`.trim() || 'без имени',
                    безВхода: !в.user_id,
                    безБота: !!в.user_id && !в.telegram_chat_id,
                };
            }).sort((a, b) => a.имя.localeCompare(b.имя, 'ru'));
            яЧеловек = люди.find(ч => карточки[ч.vaishnava_id]?.user_id === window.currentUser?.id) || null;
        }

        // допуски нужны для пометок в выборе человека и в клетке
        const { data: допуски } = await Layout.db.from('worship_person_services').select('person_id, service_id');
        люди.forEach(ч => {
            ч.допуск = new Set((допуски || [])
                .filter(д => д.person_id === ч.id).map(д => д.service_id));
        });

        // стандарты нужны, чтобы у службы можно было задать «как делается»
        const { data: ст } = await Layout.db.from('worship_articles')
            .select('id, title').eq('kind', 'standard').eq('status', 'published').order('title');
        стандарты = ст || [];

        await загрузитьМои();
        return true;
    }

    /**
     * «Ваши ближайшие службы» — про завтра, а не про открытую неделю:
     * в воскресенье вечером человек смотрит расписание ровно затем, чтобы
     * увидеть ближайшие дни, и листать за этим он не станет.
     */
    async function загрузитьМои() {
        мои = [];
        if (!яЧеловек) return;
        const сегодня = DateUtils.toISO(new Date());
        const { data } = await Layout.db.from('worship_duties')
            .select('id, duty_date, service_id, override_id, role')
            .eq('person_id', яЧеловек.id).gte('duty_date', сегодня)
            .order('duty_date').limit(20);
        мои = data || [];

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

    /** Назначение, которое и правда закроет службу: человек в отделе и не в отъезде. */
    const кто_придёт = (н, день) => {
        const ч = человек(н.person_id);
        return !!ч && ч.is_active !== false && !вОтъезде(ч.id, день);
    };

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
        if (яЧеловек && можноВести()) редкие.push('<li><button id="яНеСмогу">Меня не будет</button></li>');

        $('#actions').innerHTML = `
            ${можноВести()
                ? `<button class="btn btn-sm" id="копияНедели"
                        style="background: var(--current-color); color:#fff;">Как на прошлой неделе</button>
                   <!-- состав служб и их время правят не каждый день, но ищут
                        именно здесь: под «ещё» эту кнопку не находили -->
                   <button class="btn btn-sm btn-outline" id="вестиСлужбы">Службы и время</button>`
                : яЧеловек
                    ? '<button class="btn btn-sm btn-outline" id="яНеСмогу">Меня не будет</button>'
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
        const прошлая = дни()[6] < DateUtils.toISO(new Date());
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

    function рисоватьМои() {
        if (!яЧеловек || !мои.length) { $('#мои').hidden = true; return; }

        const отменён = н => н.service_id && моиОтклонения.some(о =>
            о.service_id === н.service_id && о.duty_date === н.duty_date);
        const живые = мои.filter(н => !отменён(н)).slice(0, 5);
        const снятые = мои.filter(отменён);

        $('#мои').hidden = !живые.length && !снятые.length;
        $('#моиСписок').innerHTML = живые.map(н => строкаМоей(н)).join('') +
            // о службе, которую отменили уже после назначения, человек должен
            // узнать здесь, а не придя в храм
            снятые.slice(0, 3).map(н => `
            <li class="py-1 flex flex-wrap items-baseline gap-2 opacity-70">
                <span class="font-semibold line-through">${e(деньПоЧеловечески(н.duty_date))}</span>
                <span class="line-through">${e(имяСлужбы(н))}</span>
                <span class="badge badge-sm badge-warning">в этот день не проводится</span>
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
            ${н.role !== 'pujari' ? `<span class="badge badge-sm">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
        </li>`;
    }

    function рисоватьНеделю() {
        const список = дни();
        const сегодня = DateUtils.toISO(new Date());
        $('#шапкаДней').innerHTML = '<th class="w-44">Служба</th>' + список.map((д, i) => `
            <th class="${д === сегодня ? 'сегодня text-[color:var(--current-color)]' : ''}">
                ${ДНИ[(DateUtils.parseDate(д).getDay() + 6) % 7]}<span class="block text-xs font-normal">${
                    д === сегодня ? 'сегодня' : DateUtils.formatShort(DateUtils.parseDate(д))}</span>
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
        const сегодня = день === DateUtils.toISO(new Date()) ? ' сегодня' : '';

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
                ${повисшие.length
                    ? '<span class="block text-error font-semibold">их надо снять или предупредить</span>' : ''}</td>`;
        }

        const свои = вКлетке(день, служба?.id, разовая?.id);
        const моя = яЧеловек && свои.some(н => н.person_id === яЧеловек.id);
        // клетку закрывает только тот, кто придёт: стоящий в отъезде оставляет
        // её открытой, и выглядеть она должна так же, как пустая
        const закрыта = свои.some(н => кто_придёт(н, день));

        if (!свои.length) {
            // в прошедшем дне дыра — не дело, а история: подсвечивать нечего
            const прошло = день < DateUtils.toISO(new Date());
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
        const командой = свои.some(н => кто_придёт(н, день)
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
                           href="people.html?id=${н.person_id}">${e(ч?.имя || 'кто-то')}</a>
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
        const сегодня = DateUtils.toISO(new Date());
        const активные = службы.filter(с => с.is_active);
        if (!активные.length && !отклонения.some(о => о.title)) {
            $('#итогДней').innerHTML = '';
            return;
        }

        $('#итогДней').innerHTML = `<tr>
            <td class="text-xs font-semibold">Закрыто за день</td>
            ${список.map(д => {
                const надо = активные.filter(с => !отменена(с.id, д)).length
                    + разовыеДня(д).length;
                const есть = активные.filter(с => !отменена(с.id, д)
                        && вКлетке(д, с.id).some(н => кто_придёт(н, д))).length
                    + разовыеДня(д).filter(о =>
                        вКлетке(д, null, о.id).some(н => кто_придёт(н, д))).length;
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
            const прошло = д < DateUtils.toISO(new Date());
            const закрыта = свои.some(н => кто_придёт(н, д));
            const командой = свои.some(н => кто_придёт(н, д)
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
                        ? свои.map(н => `
                            <a class="link link-hover text-sm" href="people.html?id=${н.person_id}">
                                ${e(человек(н.person_id)?.имя || 'кто-то')}</a>
                            ${н.role !== 'pujari'
                                ? `<span class="badge badge-xs">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
                            ${можноВести()
                                ? `<button class="btn btn-ghost btn-xs" data-снять="${н.id}">✕</button>` : ''}`).join('')
                        : `<span class="text-sm ${отмена || д < DateUtils.toISO(new Date())
                                ? 'opacity-40' : 'opacity-60'}">${
                            отмена ? '' : (д < DateUtils.toISO(new Date())
                                ? 'никого не ставили' : 'никто не поставлен')}</span>`}
                    ${можноВести() && !отмена && д >= DateUtils.toISO(new Date())
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
                <button class="btn btn-ghost btn-xs text-error" data-убратьОтклонение="${о.id}">✕</button>
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

    async function перечитать() {
        if (await загрузить()) рисовать();
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
        $('#нРоль').value = 'pujari';
        рисоватьЛюдейДляКлетки();
        $('#назначение').showModal();
    }

    const coalesceId = н => н.service_id || н.override_id;

    function рисоватьЛюдейДляКлетки() {
        const q = $('#нПоиск').value.trim().toLowerCase();
        const { день, serviceId } = клетка;
        const роль = $('#нРоль').value;
        // «уже стоит» — в этой же роли: пуджари и киртания в одной клетке разные люди
        const уже = new Set(вКлетке(день, serviceId, клетка.overrideId)
            .filter(н => н.role === роль).map(н => н.person_id));

        const строки = люди
            .filter(ч => ч.is_active && (!q || ч.имя.toLowerCase().includes(q)))
            .map(ч => {
                const пометки = [];
                if (вОтъезде(ч.id, день)) пометки.push(['в отъезде', 'badge-error']);
                if (serviceId && !ч.допуск.has(serviceId)) пометки.push(['нет допуска', 'badge-warning']);
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
                if (ч.безВхода) пометки.push(['нет входа — скажите голосом', 'badge-ghost']);
                else if (ч.безБота) пометки.push(['бот не подключён', 'badge-ghost']);
                return { ч, пометки, стоит: уже.has(ч.id) };
            });

        $('#нСписок').innerHTML = строки.map(({ ч, пометки, стоит }) => `
            <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${e(ч.имя)}</span>
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
            p_role: $('#нРоль').value,
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
                       data-служба-время="${с.id}">
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
    function открытьОтклонение(какое) {
        $('#оЗаголовок').textContent = какое === 'разовая'
            ? 'Разовая служба' : 'Служба в этот день не проводится';
        $('#оРазовая').hidden = какое !== 'разовая';
        $('#оСлужбаБлок').hidden = какое === 'разовая';
        $('#оДата').value = вид === 'день' ? выбранныйДень : дни()[0];
        $('#оНазвание').value = '';
        $('#оВремя').value = '';
        $('#оПричина').value = '';
        $('#оСлужба').innerHTML = службы.filter(с => с.is_active)
            .map(с => `<option value="${с.id}">${e(Layout.getName(с))} (${e(с.time_of_day.slice(0, 5))})</option>`).join('');
        $('#отклонениеМодал').dataset.какое = какое;
        $('#отклонениеМодал').showModal();
    }

    async function сохранитьОтклонение() {
        const какое = $('#отклонениеМодал').dataset.какое;
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
            строка.title = $('#оНазвание').value.trim();
            строка.time_of_day = $('#оВремя').value;
        } else {
            if (!$('#оСлужба').value) return Layout.showNotification('Выберите службу', 'warning');
            строка.service_id = $('#оСлужба').value;
        }

        // предупреждаем до вставки: иначе отмена тихо оставляет людей на службе
        if (какое !== 'разовая') {
            const стоят = назначения.filter(н => н.duty_date === дата && н.service_id === строка.service_id);
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

    // ---------- слушатели ----------
    function слушать() {
        document.addEventListener('click', async ev => {
            const кл = ev.target.closest('[data-клетка]');
            if (кл) return открытьНазначение(кл.dataset.клетка, кл.dataset.служба, кл.dataset.разовая);

            const пост = ev.target.closest('[data-поставить]');
            if (пост) return поставить(пост.dataset.поставить);

            const снять = ev.target.closest('[data-снять]');
            if (снять) {
                if (!await спросить('Снять назначение?')) return;
                const { error } = await Layout.db.rpc('worship_duty_clear', { p_duty: снять.dataset.снять });
                if (error) return Layout.handleError(error, 'Назначение');
                return перечитать();
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
                    началоНедели.setDate(началоНедели.getDate() + 7 * знак);
                }
                return перечитать();
            }
            if (b.id === 'сегодня') {
                началоНедели = началоОт(new Date());
                выбранныйДень = DateUtils.toISO(new Date());
                return перечитать();
            }
            if (b.dataset.вид) {
                вид = b.dataset.вид;
                return рисовать();
            }
            if (b.id === 'печать') return print();
            if (b.id === 'вестиСлужбы') { рисоватьСлужбы(); return $('#службыМодал').showModal(); }
            if (b.id === 'сДобавить') return добавитьСлужбу();
            if (b.id === 'разовая') return открытьОтклонение('разовая');
            if (b.id === 'отменить') return открытьОтклонение('отмена');
            if (b.id === 'оСохранить') return сохранитьОтклонение();
            if (b.id === 'копияНедели') return открытьПовтор();
            if (b.id === 'повторПустить') return копияНедели();
            if (b.id === 'яНеСмогу') {
                $('#оtС').value = DateUtils.toISO(new Date());
                $('#оtПо').value = '';
                $('#оtПричина').value = '';
                return $('#отметкаМодал').showModal();
            }
            if (b.id === 'оtСохранить') return отметитьОтъезд();
        });

        // правка названия и времени службы — по уходу из поля
        document.addEventListener('change', async ev => {
            const имя = ev.target.closest('[data-служба-имя]');
            const время = ev.target.closest('[data-служба-время]');
            const стандарт = ev.target.closest('[data-служба-стандарт]');
            if (!имя && !время && !стандарт) return;
            const поле = имя || время || стандарт;
            const id = поле.getAttribute(имя ? 'data-служба-имя'
                : время ? 'data-служба-время' : 'data-служба-стандарт');
            const правка = имя ? { name_ru: поле.value.trim() }
                : время ? { time_of_day: поле.value }
                : { article_id: поле.value || null };
            if (имя && !правка.name_ru) return Layout.showNotification('Без названия службу не найти', 'warning');
            const ок = await записать(Layout.db.from('worship_services')
                .update({ ...правка, updated_at: new Date().toISOString(),
                          updated_by: window.currentUser?.id || null })
                .eq('id', id), 'Служба');
            if (ок) await перечитать();
        });

        $('#нПоиск').addEventListener('input', Layout.debounce(рисоватьЛюдейДляКлетки, 200));
        $('#нРоль').addEventListener('change', рисоватьЛюдейДляКлетки);
        ['#повторОткуда', '#повторСколько'].forEach(s2 =>
            $(s2).addEventListener('change', пересчитатьПовтор));
    }

    async function добавитьСлужбу() {
        const имя = $('#сНазвание').value.trim();
        const время = $('#сВремя').value;
        if (!имя || !время) return Layout.showNotification('Нужны название и время', 'warning');

        const { error } = await Layout.db.from('worship_services').insert({
            name_ru: имя,
            time_of_day: время,
            sort_order: Math.max(0, ...службы.map(с => с.sort_order ?? 0)) + 1,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Служба');
        $('#сНазвание').value = '';
        $('#сВремя').value = '';
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

        const { count, error } = await Layout.db.from('worship_duties')
            .select('id', { count: 'exact', head: true })
            .gte('duty_date', DateUtils.toISO(от))
            .lte('duty_date', DateUtils.toISO(доИсточника));
        if (error) { узел.textContent = 'Не удалось посчитать — повтор всё равно сработает'; return; }

        узел.innerHTML = count
            ? `Возьмём <b>${Layout.pluralize(count, {
                   ru: ['назначение', 'назначения', 'назначений'],
                   en: ['duty', 'duties'], hi: 'सेवा' })}</b> за ${периодСловами(от)}<br>
               и повторим на ${периодСловами(началоНедели)}${сколько > 1
                   ? ` и дальше, по ${DateUtils.formatShort(конецПриёмника)}` : ''}.`
            : `За ${периодСловами(от)} никого не ставили — переносить нечего.`;
    }

    async function копияНедели() {
        const назад = Number($('#повторОткуда').value || 1);
        const сколько = Number($('#повторСколько').value || 1);

        let перенесено = 0, пропущено = 0;
        const недоступны = new Set();

        // каждую неделю переносим отдельным вызовом: функция идемпотентна,
        // уже стоящие назначения второй раз не создаются
        for (let i = 0; i < сколько; i++) {
            const { data, error } = await Layout.db.rpc('worship_week_copy', {
                p_from: DateUtils.toISO(началоНеделиСдвигом(-назад)),
                p_to: DateUtils.toISO(началоНеделиСдвигом(i)),
            });
            if (error) return Layout.handleError(error, 'Повтор недели');
            перенесено += data?.['перенесено'] ?? 0;
            пропущено += data?.['пропущено'] ?? 0;
            (data?.['недоступны'] || []).forEach(имя => недоступны.add(имя));
        }

        $('#повторМодал').close();
        await перечитать();

        if (!перенесено && !пропущено) {
            return Layout.showNotification('Переносить нечего: в той неделе никого не ставили', 'warning');
        }
        Layout.showNotification(
            `Перенесено: ${перенесено}, пропущено: ${пропущено}` +
            (недоступны.size ? `. В отъезде: ${[...недоступны].join(', ')}` : ''),
            'success');
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        рисовать();
        await старшийВОтъезде();
    }

    return { init };
})();
