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

    let понедельник = ближайшийПонедельник(new Date());
    let выбранныйДень = DateUtils.toISO(new Date());
    let вид = window.matchMedia('(max-width: 1199px)').matches ? 'день' : 'неделя';

    let службы = [], люди = [], назначения = [], отклонения = [], отметки = [];
    let яЧеловек = null;              // моя запись в отделе, если я в нём есть
    let клетка = null;                // что сейчас назначаем

    // ---------- даты ----------
    function ближайшийПонедельник(дата) {
        const д = new Date(дата);
        const сдвиг = (д.getDay() + 6) % 7;      // воскресенье — седьмой день, а не первый
        д.setDate(д.getDate() - сдвиг);
        д.setHours(0, 0, 0, 0);
        return д;
    }

    const деньНедели = i => {
        const д = new Date(понедельник);
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
                .select('id, vaishnava_id, active_from, active_to, is_active'),
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
                .select('id, spiritual_name, first_name, last_name, user_id').in('id', ids);
            const карточки = Object.fromEntries((data || []).map(в => [в.id, в]));
            люди = люди.map(ч => {
                const в = карточки[ч.vaishnava_id] || {};
                return {
                    ...ч,
                    имя: в.spiritual_name ||
                        `${в.first_name || ''} ${в.last_name || ''}`.trim() || 'без имени',
                    безВхода: !в.user_id,
                };
            }).sort((a, b) => a.имя.localeCompare(b.имя, 'ru'));
            яЧеловек = люди.find(ч => карточки[ч.vaishnava_id]?.user_id === window.currentUser?.id) || null;
        }

        // допуски нужны для пометок в выборе человека
        const { data: допуски } = await Layout.db.from('worship_person_services').select('person_id, service_id');
        люди.forEach(ч => {
            ч.допуск = new Set((допуски || [])
                .filter(д => д.person_id === ч.id).map(д => д.service_id));
        });
        return true;
    }

    // ---------- вспомогательное ----------
    const человек = id => люди.find(ч => ч.id === id);

    const вОтъезде = (personId, день) => отметки.some(а => а.person_id === personId
        && а.date_from <= день && (!а.date_to || а.date_to >= день));

    const отменена = (serviceId, день) => отклонения.some(о =>
        о.service_id === serviceId && о.duty_date === день);

    const разовыеДня = день => отклонения.filter(о => о.title && о.duty_date === день);

    const вКлетке = (день, serviceId, overrideId) => назначения.filter(н =>
        н.duty_date === день &&
        (overrideId ? н.override_id === overrideId : н.service_id === serviceId));

    // ---------- отрисовка недели ----------
    function рисоватьШапку() {
        const кнопки = ['<button class="btn btn-sm btn-outline" id="печать">Печать</button>'];
        if (можноВести()) {
            кнопки.unshift('<button class="btn btn-sm btn-outline" id="копияНедели">Как на прошлой неделе</button>');
            кнопки.unshift('<button class="btn btn-sm btn-outline" id="вестиСлужбы">Службы</button>');
        }
        $('#actions').innerHTML = кнопки.join('');

        const пустых = службы.filter(с => с.is_active).reduce((сумма, с) =>
            сумма + дни().filter(д => !отменена(с.id, д) && !вКлетке(д, с.id).length).length, 0);
        $('#подзаголовок').textContent = службы.length
            ? (пустых ? `На этой неделе не закрыто клеток: ${пустых}` : 'Все клетки недели закрыты')
            : 'Служб пока нет — заведите их кнопкой «Службы»';

        const начало = деньНедели(0), конец = деньНедели(6);
        $('#периодНадпись').textContent = вид === 'день'
            ? DateUtils.formatWithWeekday(DateUtils.parseDate(выбранныйДень))
            : `${DateUtils.formatShort(начало)} — ${DateUtils.formatShort(конец)}`;

        document.querySelectorAll('[data-вид]').forEach(б =>
            б.classList.toggle('btn-active', б.dataset.вид === вид));
        $('#шахматка').hidden = вид !== 'неделя';
        $('#день').hidden = вид !== 'день';
    }

    function рисоватьМои() {
        if (!яЧеловек) { $('#мои').hidden = true; return; }
        const сегодня = DateUtils.toISO(new Date());
        const свои = назначения
            .filter(н => н.person_id === яЧеловек.id && н.duty_date >= сегодня)
            .sort((a, b) => a.duty_date.localeCompare(b.duty_date))
            .slice(0, 5);
        $('#мои').hidden = !свои.length;
        if (!свои.length) return;

        $('#моиСписок').innerHTML = свои.map(н => {
            const с = службы.find(x => x.id === н.service_id);
            const о = отклонения.find(x => x.id === н.override_id);
            const имя = с ? Layout.getName(с) : (о?.title || 'служба');
            const время = (с?.time_of_day || о?.time_of_day || '').slice(0, 5);
            return `
            <li class="py-1 flex flex-wrap items-baseline gap-2">
                <span class="font-semibold">${DateUtils.formatShort(DateUtils.parseDate(н.duty_date))}</span>
                <span class="opacity-60">${e(время)}</span>
                ${с?.article_id
                    ? `<a class="link" href="article.html?id=${с.article_id}">${e(имя)}</a>`
                    : `<span>${e(имя)}</span>`}
                ${н.role !== 'pujari' ? `<span class="badge badge-sm">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
            </li>`;
        }).join('');
    }

    function рисоватьНеделю() {
        const список = дни();
        const сегодня = DateUtils.toISO(new Date());
        $('#шапкаДней').innerHTML = '<th class="w-44">Служба</th>' + список.map((д, i) => `
            <th class="${д === сегодня ? 'text-[color:var(--current-color)]' : ''}">
                ${ДНИ[i]}<span class="block text-xs font-normal opacity-60">${
                    DateUtils.formatShort(DateUtils.parseDate(д))}</span>
            </th>`).join('');

        const строки = службы.filter(с => с.is_active).map(с => `
            <tr>
                <td class="align-top">
                    <span class="font-semibold">${e(Layout.getName(с))}</span>
                    <span class="block text-xs opacity-60">${e(с.time_of_day.slice(0, 5))}</span>
                    ${с.article_id
                        ? `<a class="link text-xs no-print" href="article.html?id=${с.article_id}">как делается</a>` : ''}
                </td>
                ${список.map(д => клеткаHTML(д, с)).join('')}
            </tr>`);

        // разовые службы праздника: своя строка, занятая одним днём
        const разовые = отклонения.filter(о => о.title);
        разовые.forEach(о => {
            строки.push(`
            <tr>
                <td class="align-top">
                    <span class="font-semibold">${e(о.title)}</span>
                    <span class="badge badge-sm ml-1">разовая</span>
                    <span class="block text-xs opacity-60">${e((о.time_of_day || '').slice(0, 5))}</span>
                </td>
                ${список.map(д => д === о.duty_date
                    ? клеткаHTML(д, null, о)
                    : '<td class="клетка opacity-30"></td>').join('')}
            </tr>`);
        });

        $('#строкиСлужб').innerHTML = строки.join('') ||
            `<tr><td colspan="8" class="text-sm opacity-60 p-4">
                Служб пока нет. ${можноВести() ? 'Заведите их кнопкой «Службы».'
                    : 'Их заводит старший пуджари.'}</td></tr>`;
    }

    function клеткаHTML(день, служба, разовая) {
        if (служба && отменена(служба.id, день)) {
            const о = отклонения.find(x => x.service_id === служба.id && x.duty_date === день);
            return `<td class="клетка bg-base-200/60 text-xs opacity-70">
                не проводится${о?.reason ? `<span class="block">${e(о.reason)}</span>` : ''}</td>`;
        }

        const свои = вКлетке(день, служба?.id, разовая?.id);
        const моя = яЧеловек && свои.some(н => н.person_id === яЧеловек.id);

        if (!свои.length) {
            return `<td class="клетка ${можноВести() ? 'cursor-pointer hover:bg-base-200' : ''}"
                        ${можноВести() ? `data-клетка="${день}" data-служба="${служба?.id || ''}"
                        data-разовая="${разовая?.id || ''}"` : ''}>
                <span class="text-xs opacity-40">${можноВести() ? '+ поставить' : '—'}</span></td>`;
        }

        return `<td class="клетка ${моя ? 'своя' : ''}">
            ${свои.map(н => {
                const ч = человек(н.person_id);
                const отъезд = ч && вОтъезде(ч.id, день);
                return `
                <div class="flex items-start gap-1 mb-0.5">
                    <a class="link link-hover text-sm flex-1 ${отъезд ? 'line-through opacity-60' : ''}"
                       href="people.html?id=${н.person_id}">${e(ч?.имя || 'кто-то')}</a>
                    ${можноВести()
                        ? `<button class="btn btn-ghost btn-xs no-print px-1" data-снять="${н.id}"
                                   title="Снять">✕</button>` : ''}
                </div>
                ${н.role !== 'pujari'
                    ? `<span class="badge badge-xs">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
                ${отъезд ? '<span class="badge badge-xs badge-warning">в отъезде</span>' : ''}`;
            }).join('')}
            ${можноВести()
                ? `<button class="btn btn-ghost btn-xs no-print opacity-50" data-клетка="${день}"
                           data-служба="${служба?.id || ''}" data-разовая="${разовая?.id || ''}">+ ещё</button>`
                : ''}
        </td>`;
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
            return `
            <li class="border-b border-base-200 last:border-0 py-3">
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
                        : `<span class="text-sm ${отмена ? 'opacity-40' : 'opacity-60'}">${
                            отмена ? '' : 'никто не поставлен'}</span>`}
                    ${можноВести() && !отмена
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
        $('#нПодсказка').textContent = 'Пометки подсказывают, но не запрещают: решение за вами.';
        $('#нПоиск').value = '';
        $('#нРоль').value = 'pujari';
        рисоватьЛюдейДляКлетки();
        $('#назначение').showModal();
    }

    function рисоватьЛюдейДляКлетки() {
        const q = $('#нПоиск').value.trim().toLowerCase();
        const { день, serviceId } = клетка;
        const уже = new Set(вКлетке(день, serviceId, клетка.overrideId).map(н => н.person_id));

        const строки = люди
            .filter(ч => ч.is_active && (!q || ч.имя.toLowerCase().includes(q)))
            .map(ч => {
                const пометки = [];
                if (вОтъезде(ч.id, день)) пометки.push(['в отъезде', 'badge-error']);
                if (serviceId && !ч.допуск.has(serviceId)) пометки.push(['нет допуска', 'badge-warning']);
                if (назначения.some(н => н.duty_date === день && н.person_id === ч.id
                        && !уже.has(ч.id))) пометки.push(['уже занят в этот день', 'badge-ghost']);
                if (ч.active_to && ч.active_to < день) пометки.push(['срок участия истёк', 'badge-warning']);
                if (ч.безВхода) пометки.push(['нет входа — скажите голосом', 'badge-ghost']);
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

    function спросить(заголовок, текст) {
        return new Promise(готово => {
            $('#пдЗаголовок').textContent = заголовок;
            $('#пдТекст').textContent = текст || '';
            const окно = $('#подтверждение'), да = $('#пдДа');
            const обработчик = () => { окно.close(); готово(true); };
            да.addEventListener('click', обработчик, { once: true });
            окно.addEventListener('close', () => {
                да.removeEventListener('click', обработчик);
                готово(false);
            }, { once: true });
            окно.showModal();
        });
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

        const { error } = await Layout.db.from('worship_day_overrides').insert(строка);
        if (error) {
            if (error.code === '23505') {
                return Layout.showNotification('Эта служба в этот день уже отмечена', 'warning');
            }
            return Layout.handleError(error, 'Отклонение дня');
        }
        $('#отклонениеМодал').close();
        // дата может лежать вне открытой недели — перейдём к ней, иначе правка «пропадёт»
        понедельник = ближайшийПонедельник(DateUtils.parseDate(дата));
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
                const j = i + Number(дв.dataset.службаДвигать);
                if (i < 0 || j < 0 || j >= службы.length) return;
                const ок = await записать(Layout.db.from('worship_services')
                    .update({ sort_order: службы[j].sort_order }).eq('id', службы[i].id), 'Порядок служб');
                if (!ок) return;
                await записать(Layout.db.from('worship_services')
                    .update({ sort_order: службы[i].sort_order }).eq('id', службы[j].id), 'Порядок служб');
                await перечитать();
                return рисоватьСлужбы();
            }

            const вкл = ev.target.closest('[data-служба-включение]');
            if (вкл) {
                const с = службы.find(x => x.id === вкл.dataset.службаВключение);
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
                    понедельник = ближайшийПонедельник(д);
                } else {
                    понедельник.setDate(понедельник.getDate() + 7 * знак);
                }
                return перечитать();
            }
            if (b.id === 'сегодня') {
                понедельник = ближайшийПонедельник(new Date());
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
            if (b.id === 'копияНедели') return копияНедели();
        });

        // правка названия и времени службы — по уходу из поля
        document.addEventListener('change', async ev => {
            const имя = ev.target.closest('[data-служба-имя]');
            const время = ev.target.closest('[data-служба-время]');
            if (!имя && !время) return;
            const поле = имя || время;
            const id = поле.getAttribute(имя ? 'data-служба-имя' : 'data-служба-время');
            const правка = имя
                ? { name_ru: поле.value.trim() }
                : { time_of_day: поле.value };
            if (имя && !правка.name_ru) return Layout.showNotification('Без названия службу не найти', 'warning');
            const ок = await записать(Layout.db.from('worship_services')
                .update({ ...правка, updated_at: new Date().toISOString(),
                          updated_by: window.currentUser?.id || null })
                .eq('id', id), 'Служба');
            if (ок) await перечитать();
        });

        $('#нПоиск').addEventListener('input', Layout.debounce(рисоватьЛюдейДляКлетки, 200));
        $('#нРоль').addEventListener('change', рисоватьЛюдейДляКлетки);
    }

    async function добавитьСлужбу() {
        const имя = $('#сНазвание').value.trim();
        const время = $('#сВремя').value;
        if (!имя || !время) return Layout.showNotification('Нужны название и время', 'warning');

        const { error } = await Layout.db.from('worship_services').insert({
            name_ru: имя,
            time_of_day: время,
            sort_order: (службы.at(-1)?.sort_order ?? 0) + 1,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Служба');
        $('#сНазвание').value = '';
        $('#сВремя').value = '';
        await перечитать();
        рисоватьСлужбы();
    }

    async function копияНедели() {
        const прошлая = new Date(понедельник);
        прошлая.setDate(прошлая.getDate() - 7);
        if (!await спросить('Повторить прошлую неделю?',
            'Уже стоящие назначения останутся как есть, недоступные пропустятся.')) return;

        const { data, error } = await Layout.db.rpc('worship_week_copy', {
            p_from: DateUtils.toISO(прошлая),
            p_to: DateUtils.toISO(понедельник),
        });
        if (error) return Layout.handleError(error, 'Копия недели');

        await перечитать();
        const недоступны = data?.['недоступны'] || [];
        Layout.showNotification(
            `Перенесено: ${data?.['перенесено'] ?? 0}, пропущено: ${data?.['пропущено'] ?? 0}` +
            (недоступны.length ? `. В отъезде: ${недоступны.join(', ')}` : ''),
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
