/**
 * Люди отдела: состав, допуски, отметки недоступности, заметки.
 *
 * Человек один и тот же во всём ашраме, поэтому здесь только ссылка на его
 * карточку вайшнава и срок участия. «Пуджари» и «волонтёр» — не два вида
 * людей, а один человек с разным сроком.
 *
 * Заметки лежат отдельной таблицей и видны только носителям права
 * утверждения: поле в карточке уехало бы вместе со строкой любому,
 * кто запросил список людей.
 */
const WorshipPeople = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноВести = () => !!window.hasPermission?.('worship_approve');

    const РОЛИ = { pujari: 'пуджари', kirtan: 'киртания', helper: 'помощник' };

    let люди = [], службы = [], назначения = [], отметки = [];
    let яЧеловек = null, открытый = null;

    // ---------- загрузка ----------
    async function загрузить() {
        const сегодня = DateUtils.toISO(new Date());

        const [л, с, н, о] = await Promise.all([
            Layout.db.from('worship_people')
                .select('id, vaishnava_id, active_from, active_to, is_active'),
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, article_id, is_active')
                .order('sort_order').order('time_of_day'),
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, person_id, role')
                .gte('duty_date', сегодня).order('duty_date').limit(500),
            Layout.db.from('worship_absences')
                .select('id, person_id, date_from, date_to, reason').order('date_from'),
        ]);
        const ошибка = л.error || с.error || н.error || о.error;
        if (ошибка) { Layout.handleError(ошибка, 'Люди отдела'); return false; }

        службы = с.data || [];
        назначения = н.data || [];
        отметки = о.data || [];
        люди = л.data || [];

        const ids = люди.map(ч => ч.vaishnava_id);
        if (ids.length) {
            const { data } = await Layout.db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name, user_id, phone, telegram_chat_id')
                .in('id', ids);
            const карточки = Object.fromEntries((data || []).map(в => [в.id, в]));
            люди = люди.map(ч => {
                const в = карточки[ч.vaishnava_id] || {};
                return {
                    ...ч,
                    имя: в.spiritual_name ||
                        `${в.first_name || ''} ${в.last_name || ''}`.trim() || 'без имени',
                    телефон: в.phone || null,
                    безВхода: !в.user_id,
                    безБота: !!в.user_id && !в.telegram_chat_id,
                    мой: в.user_id && в.user_id === window.currentUser?.id,
                };
            }).sort((a, b) => Number(b.is_active) - Number(a.is_active)
                              || a.имя.localeCompare(b.имя, 'ru'));
            яЧеловек = люди.find(ч => ч.мой) || null;
        }

        const { data: допуски } = await Layout.db.from('worship_person_services')
            .select('person_id, service_id');
        люди.forEach(ч => {
            ч.допуск = new Set((допуски || [])
                .filter(д => д.person_id === ч.id).map(д => д.service_id));
        });
        return true;
    }

    const вОтъездеСейчас = id => {
        const сегодня = DateUtils.toISO(new Date());
        return отметки.some(а => а.person_id === id
            && а.date_from <= сегодня && (!а.date_to || а.date_to >= сегодня));
    };

    const служб = id => назначения.filter(н => н.person_id === id).length;

    // ---------- список ----------
    function рисовать() {
        $('#яНеСмогу').hidden = !яЧеловек;

        $('#список').innerHTML = люди.map(ч => `
            <li class="border-b border-base-200 last:border-0">
                <button class="w-full text-left px-5 py-3 hover:bg-base-200/60 transition-colors
                               flex flex-col desktop:flex-row desktop:items-center gap-1 desktop:gap-3
                               ${ч.is_active ? '' : 'opacity-50'}"
                        data-человек="${ч.id}">
                    <span class="flex-1 min-w-0">
                        <span class="font-semibold">${e(ч.имя)}</span>
                        ${ч.мой ? '<span class="badge badge-sm ml-1">это вы</span>' : ''}
                        ${ч.is_active ? '' : '<span class="badge badge-sm ml-1">не в отделе</span>'}
                        ${вОтъездеСейчас(ч.id) ? '<span class="badge badge-sm badge-warning ml-1">в отъезде</span>' : ''}
                        ${ч.безВхода ? '<span class="badge badge-sm badge-ghost ml-1">нет входа</span>' : ''}
                        ${ч.безБота ? '<span class="badge badge-sm badge-ghost ml-1">бот не подключён</span>' : ''}
                        ${ч.active_to
                            ? `<span class="block text-sm opacity-60">участвует по ${
                                DateUtils.formatShort(DateUtils.parseDate(ч.active_to))}</span>` : ''}
                    </span>
                    <span class="text-sm opacity-60 whitespace-nowrap">
                        ${Layout.pluralize(служб(ч.id), {
                            ru: ['служба впереди', 'службы впереди', 'служб впереди'],
                            en: ['duty ahead', 'duties ahead'], hi: 'सेवा' })}
                    </span>
                </button>
            </li>`).join('') ||
            `<li class="px-5 py-6 text-sm opacity-60">В отделе пока никого. ${
                можноВести() ? 'Добавьте людей кнопкой выше.' : 'Состав ведёт старший пуджари.'}</li>`;

        window.applyPermissions?.();
    }

    async function проверитьСтарших() {
        // второй носитель права утверждения обязателен: иначе уехавший старший
        // останавливает и очередь, и расписание
        if (!можноВести()) return;
        const { data, error } = await Layout.db.rpc('worship_approvers_count');
        if (error) return;                       // отсутствие подсказки не ломает экран
        $('#одинСтарший').hidden = (data ?? 2) > 1;
    }

    // ---------- карточка ----------
    async function открыть(id) {
        открытый = люди.find(ч => ч.id === id);
        if (!открытый) return;

        $('#кИмя').textContent = открытый.имя;
        $('#кПодпись').textContent = [
            открытый.is_active ? null : 'выведен из отдела',
            открытый.active_from ? `с ${DateUtils.formatShort(DateUtils.parseDate(открытый.active_from))}` : null,
            открытый.active_to ? `по ${DateUtils.formatShort(DateUtils.parseDate(открытый.active_to))}` : null,
            открытый.безВхода ? 'входа в систему нет — о переменах скажите голосом' : null,
            открытый.безБота ? 'бот не подключён — напоминание не дойдёт' : null,
            открытый.телефон || null,
        ].filter(Boolean).join(' · ');

        рисоватьСлужбыЧеловека();
        рисоватьДопуски();
        рисоватьОтметки();
        await рисоватьЗаметки();
        window.applyPermissions?.();
        // свои отметки человек ставит сам, чужие — старший
        $('#кДобавитьОтметку').hidden = !(можноВести() || открытый.мой);
        $('#карточка').showModal();
    }

    function рисоватьСлужбыЧеловека() {
        const свои = назначения.filter(н => н.person_id === открытый.id).slice(0, 8);
        $('#кСлужбы').innerHTML = свои.map(н => {
            const с = службы.find(x => x.id === н.service_id);
            return `
            <li class="py-1 flex flex-wrap items-baseline gap-2">
                <span class="font-semibold">${DateUtils.formatShort(DateUtils.parseDate(н.duty_date))}</span>
                <span class="opacity-60">${e((с?.time_of_day || '').slice(0, 5))}</span>
                ${с?.article_id
                    ? `<a class="link" href="article.html?id=${с.article_id}">${e(Layout.getName(с))}</a>`
                    : `<span>${e(с ? Layout.getName(с) : 'разовая служба')}</span>`}
                ${н.role !== 'pujari' ? `<span class="badge badge-sm">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
            </li>`;
        }).join('') || '<li class="text-sm opacity-60">Впереди служб нет</li>';
    }

    function рисоватьДопуски() {
        $('#кДопуски').innerHTML = службы.filter(с => с.is_active).map(с => `
            <label class="label cursor-pointer justify-start gap-2 py-0 pr-3">
                <input type="checkbox" class="checkbox checkbox-sm" data-допуск="${с.id}"
                       ${открытый.допуск.has(с.id) ? 'checked' : ''}
                       ${можноВести() ? '' : 'disabled'}>
                <span class="label-text text-sm">${e(Layout.getName(с))}</span>
            </label>`).join('') || '<span class="text-sm opacity-60">Служб пока нет</span>';
    }

    function рисоватьОтметки() {
        const свои = отметки.filter(а => а.person_id === открытый.id);
        const можноСнимать = можноВести() || открытый.мой;
        $('#кОтметки').innerHTML = свои.map(а => `
            <li class="flex flex-wrap items-center gap-2 py-1">
                <span>${DateUtils.formatShort(DateUtils.parseDate(а.date_from))} —
                    ${а.date_to ? DateUtils.formatShort(DateUtils.parseDate(а.date_to)) : 'пока не снимет'}</span>
                ${а.reason ? `<span class="text-sm opacity-60">${e(а.reason)}</span>` : ''}
                ${можноСнимать
                    ? `<button class="btn btn-ghost btn-xs text-error" data-снятьОтметку="${а.id}">снять</button>` : ''}
            </li>`).join('') || '<li class="text-sm opacity-60">Отметок нет</li>';
    }

    async function рисоватьЗаметки() {
        if (!можноВести()) return;
        const { data, error } = await Layout.db.from('worship_person_notes')
            .select('id, body, created_at, created_by')
            .eq('person_id', открытый.id).order('created_at', { ascending: false });
        if (error) return Layout.handleError(error, 'Заметки');

        const авторы = [...new Set((data || []).map(з => з.created_by).filter(Boolean))];
        let имена = {};
        if (авторы.length) {
            const { data: в } = await Layout.db.from('vaishnavas')
                .select('user_id, spiritual_name, first_name, last_name').in('user_id', авторы);
            имена = Object.fromEntries((в || []).map(x => [x.user_id,
                x.spiritual_name || `${x.first_name || ''} ${x.last_name || ''}`.trim()]));
        }

        $('#кЗаметки').innerHTML = (data || []).map(з => `
            <li class="border-b border-base-200 last:border-0 py-2">
                <div class="text-sm">${e(з.body)}</div>
                <div class="text-xs opacity-60 mt-0.5 flex items-center gap-2">
                    ${e(имена[з.created_by] || 'кто-то')} ·
                    ${DateUtils.formatShort(new Date(з.created_at))}
                    <button class="btn btn-ghost btn-xs text-error" data-убратьЗаметку="${з.id}">убрать</button>
                </div>
            </li>`).join('') || '<li class="text-sm opacity-60">Заметок нет</li>';
    }

    // ---------- действия ----------
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

    async function переключитьДопуск(serviceId, включить) {
        const запрос = включить
            ? Layout.db.from('worship_person_services')
                .insert({ person_id: открытый.id, service_id: serviceId })
            : Layout.db.from('worship_person_services')
                .delete().eq('person_id', открытый.id).eq('service_id', serviceId);
        const { error } = await запрос;
        if (error) { Layout.handleError(error, 'Допуск'); return false; }
        if (включить) открытый.допуск.add(serviceId); else открытый.допуск.delete(serviceId);
        return true;
    }

    function открытьОтметку(personId) {
        $('#отметкаМодал').dataset.кому = personId;
        $('#оtС').value = DateUtils.toISO(new Date());
        $('#оtПо').value = '';
        $('#оtПричина').value = '';
        $('#отметкаМодал').showModal();
    }

    async function сохранитьОтметку() {
        const personId = $('#отметкаМодал').dataset.кому;
        const с = $('#оtС').value;
        if (!с) return Layout.showNotification('Укажите, с какого дня', 'warning');

        const { data, error } = await Layout.db.rpc('worship_absence_set', {
            p_person: personId,
            p_from: с,
            p_to: $('#оtПо').value || null,
            p_reason: $('#оtПричина').value.trim() || null,
        });
        if (error) return Layout.handleError(error, 'Недоступность');

        $('#отметкаМодал').close();
        await перечитать();
        const клеток = data?.['назначений'] || 0;
        Layout.showNotification(клеток
            ? `Отмечено. На эти дни уже стоит ${Layout.pluralize(клеток, {
                  ru: ['назначение', 'назначения', 'назначений'],
                  en: ['duty', 'duties'], hi: 'सेवा' })} — старший заменит`
            : 'Отмечено', 'success');
    }

    async function исключить() {
        const { data, error } = await Layout.db.rpc('worship_person_impact', { p_person: открытый.id });
        if (error) return Layout.handleError(error, 'Человек');
        // функция отвечает отказом, а не цифрами, если прав не хватает:
        // «последствий нет» тут было бы опасной неправдой
        if (data?.ok === false) {
            return Layout.showNotification('Выводить людей из отдела может старший пуджари', 'warning');
        }

        const впереди = data?.['назначений_впереди'] || 0;
        const строки = [
            впереди ? `Назначений впереди: ${впереди}` +
                (data['ближайшая'] ? `, ближайшее ${DateUtils.formatShort(DateUtils.parseDate(data['ближайшая']))}` : '')
                : 'Назначений впереди нет',
            `Черновиков: ${data?.['черновиков'] || 0}`,
            `Наборов фотографий: ${data?.['наборов'] || 0}`,
            `Заметок о человеке: ${data?.['заметок'] || 0}`,
            '',
            впереди
                ? 'Клетки не очистятся сами — они станут видимо пустыми, и их придётся закрыть кем-то другим.'
                : 'Записи человека останутся на месте: мы выводим его из состава, а не удаляем.',
        ];
        if (!await спросить(`Вывести из отдела: ${открытый.имя}?`, строки.join('\n'))) return;

        const { data: строка, error: ош } = await Layout.db.from('worship_people')
            .update({ is_active: false, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', открытый.id).select('id');
        if (ош) return Layout.handleError(ош, 'Человек');
        if (!строка?.length) return Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');

        $('#карточка').close();
        await перечитать();
    }

    // ---------- добавление ----------
    async function искатьЛюдей() {
        const имя = $('#дПоиск').value.trim();
        if (имя.length < 2) {
            $('#дСписок').innerHTML = '<li class="py-3 text-sm opacity-60">Впишите хотя бы две буквы.</li>';
            return;
        }
        // свободный текст в фильтре PostgREST: запятая и скобка меняют условие
        const кав = '"' + `%${имя}%`.replace(/["\\]/g, '\\$&') + '"';
        const { data, error } = await Layout.db.from('vaishnavas')
            .select('id, spiritual_name, first_name, last_name, user_id')
            .or(`spiritual_name.ilike.${кав},first_name.ilike.${кав},last_name.ilike.${кав}`)
            .limit(20);
        if (error) return Layout.handleError(error, 'Поиск человека');

        const уже = new Set(люди.map(ч => ч.vaishnava_id));
        $('#дСписок').innerHTML = (data || []).map(в => {
            const имя2 = в.spiritual_name ||
                `${в.first_name || ''} ${в.last_name || ''}`.trim() || 'без имени';
            return `
            <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${e(имя2)}</span>
                    ${в.user_id ? '' : '<span class="badge badge-sm badge-ghost ml-1">нет входа</span>'}
                </span>
                ${уже.has(в.id)
                    ? '<span class="text-sm opacity-60">уже в отделе</span>'
                    : `<button class="btn btn-sm btn-outline" data-взять="${в.id}">Добавить</button>`}
            </li>`;
        }).join('') || '<li class="py-3 text-sm opacity-60">Никого не нашлось</li>';
    }

    async function добавить(vaishnavaId) {
        // вернуть выведенного — это не новая запись: человек один
        const был = люди.find(ч => ч.vaishnava_id === vaishnavaId);
        const запрос = был
            ? Layout.db.from('worship_people').update({
                is_active: true, updated_at: new Date().toISOString(),
                updated_by: window.currentUser?.id || null }).eq('id', был.id)
            : Layout.db.from('worship_people').insert({
                vaishnava_id: vaishnavaId, created_by: window.currentUser?.id || null });

        const { data, error } = await запрос.select('id');
        if (error) return Layout.handleError(error, 'Человек');
        if (!data?.length) return Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');

        $('#добавлениеМодал').close();
        await перечитать();
    }

    async function перечитать() {
        if (!await загрузить()) return;
        рисовать();
        if (открытый) {
            открытый = люди.find(ч => ч.id === открытый.id) || null;
            if (открытый) {
                рисоватьСлужбыЧеловека();
                рисоватьДопуски();
                рисоватьОтметки();
                await рисоватьЗаметки();
            }
        }
    }

    // ---------- слушатели ----------
    function слушать() {
        document.addEventListener('click', async ev => {
            const ч = ev.target.closest('[data-человек]');
            if (ч) return открыть(ч.dataset.человек);

            const взять = ev.target.closest('[data-взять]');
            if (взять) return добавить(взять.dataset.взять);

            const снять = ev.target.closest('[data-снятьОтметку]');
            if (снять) {
                const { error } = await Layout.db.rpc('worship_absence_clear',
                    { p_absence: снять.getAttribute('data-снятьОтметку') });
                if (error) return Layout.handleError(error, 'Недоступность');
                return перечитать();
            }

            const убрЗ = ev.target.closest('[data-убратьЗаметку]');
            if (убрЗ) {
                if (!await спросить('Убрать заметку?')) return;
                const { error } = await Layout.db.from('worship_person_notes')
                    .delete().eq('id', убрЗ.getAttribute('data-убратьЗаметку'));
                if (error) return Layout.handleError(error, 'Заметка');
                return рисоватьЗаметки();
            }

            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'добавить') {
                $('#дПоиск').value = '';
                $('#дСписок').innerHTML = '<li class="py-3 text-sm opacity-60">Впишите часть имени.</li>';
                return $('#добавлениеМодал').showModal();
            }
            if (b.id === 'яНеСмогу') return открытьОтметку(яЧеловек.id);
            if (b.id === 'кДобавитьОтметку') return открытьОтметку(открытый.id);
            if (b.id === 'оtСохранить') return сохранитьОтметку();
            if (b.id === 'кИсключить') return исключить();
            if (b.id === 'кЗаметкаДобавить') {
                const текст = $('#кЗаметкаТекст').value.trim();
                if (!текст) return;
                const { error } = await Layout.db.from('worship_person_notes').insert({
                    person_id: открытый.id, body: текст,
                    created_by: window.currentUser?.id || null,
                });
                if (error) return Layout.handleError(error, 'Заметка');
                $('#кЗаметкаТекст').value = '';
                return рисоватьЗаметки();
            }
        });

        document.addEventListener('change', async ev => {
            const д = ev.target.closest('[data-допуск]');
            if (!д) return;
            const вышло = await переключитьДопуск(д.dataset.допуск, д.checked);
            if (!вышло) д.checked = !д.checked;       // вернём галочку, раз не записалось
        });

        $('#дПоиск').addEventListener('input', Layout.debounce(искатьЛюдей, 300));
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        рисовать();
        await проверитьСтарших();

        // ссылка из клетки расписания ведёт прямо в карточку
        const id = new URLSearchParams(location.search).get('id');
        if (id) открыть(id);
    }

    return { init };
})();
