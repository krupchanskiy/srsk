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
    let особыеСегодня = [];       // отмены, сдвиги и разовые службы на сегодня
    let яЧеловек = null, открытый = null;

    // ---------- загрузка ----------
    async function загрузить() {
        const сегодня = DateUtils.todayAshramISO();

        // всё одним кругом: люди приходят сразу с именами, допуски — рядом.
        // Было три круга подряд, и на мобильной сети это секунды
        const [л, с, н, о, доп, ос] = await Promise.all([
            Layout.db.rpc('worship_people_list'),
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, duration_minutes, article_id, is_active')
                .order('sort_order').order('time_of_day'),
            Layout.db.from('worship_duties')
                .select('id, duty_date, service_id, override_id, person_id, role')
                .gte('duty_date', сегодня).order('duty_date').limit(500),
            Layout.db.from('worship_absences')
                .select('id, person_id, date_from, date_to, reason').order('date_from'),
            Layout.db.from('worship_person_services').select('person_id, service_id'),
            Layout.db.from('worship_day_overrides')
                .select('id, service_id, title, time_of_day, duration_minutes').eq('duty_date', сегодня),
        ]);
        const ошибка = л.error || с.error || н.error || о.error || доп.error || ос.error;
        if (ошибка) { Layout.handleError(ошибка, 'Люди отдела'); return false; }

        службы = с.data || [];
        назначения = н.data || [];
        отметки = о.data || [];
        особыеСегодня = ос.data || [];
        люди = л.data || [];

        люди = люди.map(ч => ({
            ...ч,
            имя: ч.name,
            телефон: ч.phone || null,
            безВхода: !ч.user_id,
            безБота: !!ч.user_id && !ч.has_telegram,
            мой: !!ч.user_id && ч.user_id === window.currentUser?.id,
        })).sort((a, b) => Number(b.is_active) - Number(a.is_active)
                          || a.имя.localeCompare(b.имя, 'ru'));
        яЧеловек = люди.find(ч => ч.мой) || null;

        люди.forEach(ч => {
            ч.допуск = new Set((доп.data || [])
                .filter(д => д.person_id === ч.id).map(д => д.service_id));
        });
        return true;
    }

    const вОтъездеСейчас = id => {
        const сегодня = DateUtils.todayAshramISO();
        return отметки.some(а => а.person_id === id
            && а.date_from <= сегодня && (!а.date_to || а.date_to >= сегодня));
    };

    /** Ближайший отъезд впереди: расписывают неделю, а не сегодняшний день. */
    const отъездВпереди = id => {
        const сегодня = DateUtils.todayAshramISO();
        return отметки.filter(а => а.person_id === id && а.date_from > сегодня)
            .sort((a, b) => a.date_from.localeCompare(b.date_from))[0];
    };

    /**
     * Службы человека сегодня: сколько, сколько это времени и какие.
     * Отменённые на сегодня не считаем, у сдвинутых — новое время.
     */
    function сегодняУ(personId) {
        const сегодня = DateUtils.todayAshramISO();
        let минут = 0, безДлительности = 0;
        const список = назначения.filter(н => н.person_id === personId && н.duty_date === сегодня)
            .map(н => {
                const с = н.service_id && службы.find(x => x.id === н.service_id);
                const о = н.service_id
                    ? особыеСегодня.find(x => x.service_id === н.service_id)
                    : особыеСегодня.find(x => x.id === н.override_id);
                if (с && о && !о.time_of_day) return null;            // отменена на сегодня
                const м = (с || о)?.duration_minutes;
                if (м) минут += м; else безДлительности++;
                return `${((о?.time_of_day) || с?.time_of_day || '').slice(0, 5)} ${
                    с ? Layout.getName(с) : (о?.title || 'служба')}`;
            })
            .filter(Boolean).sort();
        return { служб: список.length, минут, безДлительности, список };
    }

    const часыКоротко = м => {
        const ч = Math.floor(м / 60), мин = м % 60;
        return ч ? (мин ? `${ч} ч ${мин} мин` : `${ч} ч`) : `${мин} мин`;
    };

    // ---------- список ----------
    /** Строка списка: имя с состоянием слева, нагрузка справа. */
    function строкаЧеловека(ч) {
        const отъезд = отъездВпереди(ч.id);
        const вРезерве = ч.is_active === false;
        return `
        <li class="border-b border-base-200 last:border-0 flex items-center">
            <button class="flex-1 min-w-0 text-left px-5 py-3 hover:bg-base-200/60 transition-colors
                           flex flex-wrap items-baseline gap-x-3 gap-y-1
                           ${ч.is_active ? '' : 'opacity-70'}"
                    data-человек="${ч.id}">
                <!-- основа 12rem: на телефоне счётчик служб уходит под имя,
                     а не сжимает его до наложения букв -->
                <span class="flex-1 basis-48 min-w-0">
                    <span class="font-semibold">${e(ч.имя)}</span>${window.WorshipInitiation?.значок(ч.initiation) || ''}
                    ${ч.kind === 'volunteer'
                        ? '<span class="badge badge-sm whitespace-nowrap badge-outline ml-1">волонтёр</span>' : ''}
                    ${ч.мой ? '<span class="badge badge-sm whitespace-nowrap ml-1">это вы</span>' : ''}
                    ${вОтъездеСейчас(ч.id)
                        ? '<span class="badge badge-sm whitespace-nowrap badge-warning ml-1">в отъезде</span>'
                        : отъезд
                            ? `<span class="badge badge-sm whitespace-nowrap ml-1">уезжает ${
                                DateUtils.formatShort(DateUtils.parseDate(отъезд.date_from))}</span>`
                            : ''}
                    ${ч.is_active && ч.безБота && можноВести()
                        ? '<span class="badge badge-sm whitespace-nowrap badge-ghost ml-1" title="Напоминания в Телеграм не дойдут">без Телеграма</span>' : ''}
                    ${ч.безВхода
                        ? '<span class="badge badge-sm whitespace-nowrap badge-ghost ml-1">нет входа</span>' : ''}
                    ${срокСловами(ч) ? `<span class="block text-sm opacity-70">${срокСловами(ч)}</span>` : ''}
                </span>
                ${(() => {
                    // нагрузка сегодня, а не «служб впереди»: важнее, кто занят прямо сейчас
                    if (ч.is_active === false) return '';
                    const с = сегодняУ(ч.id);
                    if (!с.служб) return '<span class="text-sm opacity-50 whitespace-nowrap">сегодня служб нет</span>';
                    return `<span class="text-sm whitespace-nowrap tabular-nums" title="${e(с.список.join('\n'))}">
                        сегодня <b>${Layout.pluralize(с.служб, { ru: ['служба', 'службы', 'служб'],
                            en: ['service', 'services'], hi: 'सेवा' })}</b>${с.минут
                            ? `<span class="opacity-70"> · ${часыКоротко(с.минут)}${с.безДлительности ? ' +?' : ''}</span>` : ''}</span>`;
                })()}
            </button>
            ${вРезерве && можноВести() ? `
            <span class="flex gap-1 pr-3 shrink-0">
                <button class="btn btn-sm btn-outline" data-вернуть="${ч.id}">Вернуть</button>
                <button class="btn btn-sm btn-ghost text-error" data-убрать="${ч.id}"
                        title="Убрать из резерва">Убрать</button>
            </span>` : ''}
        </li>`;
    }

    function рисовать() {
        $('#яНеСмогу').hidden = !яЧеловек;

        const q = $('#поиск').value.trim().toLowerCase();
        const подходит = ч => !q || [ч.имя, ч.worldly].some(и => (и || '').toLowerCase().includes(q));

        // убранные из резерва на странице не видны: строка нужна только истории
        const видимые = люди.filter(ч => !ч.removed_at);
        const вОтделе = видимые.filter(ч => ч.is_active !== false).filter(подходит);
        const вышли = видимые.filter(ч => ч.is_active === false).filter(подходит);

        $('#список').innerHTML = вОтделе.map(строкаЧеловека).join('') ||
            `<li class="px-5 py-6 text-sm opacity-70">${
                q ? 'Никого с таким именем'
                  : `В отделе пока никого. ${можноВести()
                        ? 'Добавьте людей кнопкой выше.' : 'Состав ведёт старший пуджари.'}`}</li>`;

        $('#вышлиБлок').hidden = !вышли.length;
        if (q && !вОтделе.length && вышли.length) {
            $('#список').innerHTML = '<li class="px-5 py-6 text-sm opacity-70">В отделе никого с таким именем — нашёлся в резерве ниже</li>';
        }
        $('#вышли').innerHTML = вышли.map(строкаЧеловека).join('');

        window.applyPermissions?.();
    }

    async function проверитьСтарших() {
        // второй носитель права утверждения обязателен: иначе уехавший старший
        // останавливает и очередь, и расписание
        if (!можноВести()) return;
        const { data, error } = await Layout.db.rpc('worship_approvers_count');
        if (error) return;                       // отсутствие подсказки не ломает экран
        const сколько = data ?? 2;
        if (сколько > 1) { $('#одинСтарший').hidden = true; return; }

        // Сначала содержимое, потом показ: иначе любая осечка посередине
        // оставляла на экране пустую жёлтую полосу без объяснения
        $('#одинСтарший').innerHTML = `
            <span>${сколько === 0
                ? 'Права утверждения нет ни у кого: очередь правок и расписание стоят. '
                  + 'Нужен старший пуджари — тот, кто утверждает стандарты и ведёт расписание.'
                : 'Право утверждать стандарты есть только у одного человека. Уехал — '
                  + 'очередь правок встала, расписание не двигается. Нужен второй.'}</span>
            <a href="../settings/user-management.html" class="link whitespace-nowrap"
               data-permission="manage_users">Кому выдать право</a>`;
        $('#одинСтарший').hidden = false;
        window.applyPermissions?.();
    }

    // ---------- карточка ----------
    /** «в отделе с 26 окт», «участвует по 30 окт», «срок участия кончился 19 сен». */
    function срокСловами(ч) {
        const сегодня = DateUtils.todayAshramISO();
        const к = iso => DateUtils.formatShort(DateUtils.parseDate(iso));
        if (ч.active_from && ч.active_from > сегодня) return `в отделе с ${к(ч.active_from)}`;
        if (ч.active_to && ч.active_to < сегодня) return `срок участия кончился ${к(ч.active_to)}`;
        if (ч.active_to) return `участвует по ${к(ч.active_to)}`;
        return '';
    }

    async function открыть(id) {
        открытый = люди.find(ч => ч.id === id);
        if (!открытый) return;

        рисоватьШапку();

        $('#кСрокС').value = открытый.active_from || '';
        $('#кСрокПо').value = открытый.active_to || '';
        $('#кСрокБлок').hidden = !можноВести();
        рисоватьВид();
        рисоватьПосвящение();
        рисоватьСлужбыЧеловека();
        рисоватьДопуски();
        рисоватьОтметки();
        await рисоватьЗаметки();
        window.applyPermissions?.();
        // в отделе — «В резерв»; в резерве — «Вернуть» и «Убрать из резерва»
        const вРезерве = открытый.is_active === false;
        if (вРезерве) $('#кИсключить').hidden = true;
        $('#кВернуть').hidden = !(вРезерве && можноВести());
        $('#кУбрать').hidden = !(вРезерве && можноВести());
        // свои отметки человек ставит сам, чужие — старший
        $('#кДобавитьОтметку').hidden = !(можноВести() || открытый.мой);
        $('#карточка').showModal();
    }

    const ЗНАЧОК = {
        телефон: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2z"/></svg>',
        телеграм: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 4L3 11l6 2 2 6 3-4 5 4 2-15z"/><path d="M9 13l9-7"/></svg>',
        срок: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    };

    /** Шапка карточки: кто это, в каком он качестве и как с ним связаться. */
    function рисоватьШапку() {
        const ч = открытый;
        $('#кИмя').textContent = ч.имя;
        $('#кИнициалы').textContent = ч.имя.split(/[\s-]+/).filter(Boolean).slice(0, 2)
            .map(с => с[0].toUpperCase()).join('');
        const мирское = ч.worldly && ч.worldly !== ч.имя ? ч.worldly : '';
        $('#кМирское').hidden = !мирское;
        $('#кМирское').textContent = мирское;

        const к = iso => DateUtils.formatShort(DateUtils.parseDate(iso));
        const срок = ч.active_from && ч.active_to ? `${к(ч.active_from)} — ${к(ч.active_to)}`
            : ч.active_to ? `по ${к(ч.active_to)}` : ч.active_from ? `с ${к(ч.active_from)}` : '';
        const чипы = [
            `<span class="кЧип свой">${ч.kind === 'volunteer' ? 'Волонтёр' : 'Команда'}</span>`,
            ч.initiation ? `<span class="кЧип">${WorshipInitiation.значок(ч.initiation).replace('margin-left:.3rem;', '')}${
                WorshipInitiation.ПОДПИСЬ[ч.initiation]}</span>` : '',
            ч.is_active === false ? '<span class="кЧип">в резерве</span>' : '',
            срок ? `<span class="кЧип">${ЗНАЧОК.срок}${e(срок)}</span>` : '',
            ч.телефон ? `<a class="кЧип tabular-nums" href="tel:${e(ч.телефон.replace(/[^\d+]/g, ''))}">${ЗНАЧОК.телефон}${e(ч.телефон)}</a>` : '',
            ч.безВхода ? '<span class="кЧип">нет входа</span>'
                : ч.безБота ? `<span class="кЧип">${ЗНАЧОК.телеграм}без Телеграма</span>`
                : `<span class="кЧип хорошо">${ЗНАЧОК.телеграм}Телеграм подключён</span>`,
        ];
        $('#кЧипы').innerHTML = чипы.join('');

        // что из этого следует — одной строкой и только тому, кто может помочь
        const заметка = ч.безВхода
            ? 'Входа в систему нет — о переменах в расписании говорите ему голосом.'
            : ч.безБота && (можноВести() || ч.мой)
                ? (ч.мой ? 'Напоминания о службах не дойдут, пока вы не подключите Телеграм кнопкой на главной «Поклонения».'
                         : 'Напоминания о службах не дойдут. Попросите нажать «Подключить Телеграм» на главной «Поклонения».')
                : '';
        $('#кТелеграм').hidden = !заметка;
        $('#кТелеграм').textContent = заметка;
    }

    function рисоватьСлужбыЧеловека() {
        const все = назначения.filter(н => н.person_id === открытый.id);
        const свои = все.slice(0, 8);
        // в списке людей «11 служб впереди», а здесь восемь — остаток называем,
        // иначе кажется, что три службы потерялись
        const ещё = все.length - свои.length;
        $('#кСлужбы').innerHTML = свои.map(н => {
            const с = службы.find(x => x.id === н.service_id);
            return `
            <li class="кСлужба">
                <span class="font-semibold text-sm">${e(window.деньПоЧеловечески(н.duty_date))}</span>
                <span class="text-sm opacity-70 tabular-nums">${e((с?.time_of_day || '').slice(0, 5))}</span>
                <span class="min-w-0">
                    ${с?.article_id
                        ? `<a class="link link-hover" href="article.html?id=${с.article_id}">${e(Layout.getName(с))}</a>`
                        : `<span>${e(с ? Layout.getName(с) : 'разовая служба')}</span>`}
                    ${н.role !== 'pujari' ? `<span class="badge badge-sm whitespace-nowrap ml-1">${e(РОЛИ[н.role] || н.role)}</span>` : ''}
                </span>
            </li>`;
        }).join('') + (ещё > 0
            ? `<li class="pt-2 text-sm opacity-70">и ещё ${ещё} — <a class="link" href="schedule.html">все в расписании</a></li>`
            : '') || '<li class="text-sm opacity-70">Впереди служб нет</li>';
    }

    function рисоватьДопуски() {
        const действующие = службы.filter(с => с.is_active);
        // «Все службы» — разом: допуск ко всем действующим, галочка стоит,
        // когда отмечена каждая
        const всеОтмечены = действующие.length > 0 && действующие.every(с => открытый.допуск.has(с.id));
        $('#кДопуски').innerHTML = (действующие.length > 1 ? `
            <label class="кДопуск font-semibold">
                <input type="checkbox" data-допускВсе ${всеОтмечены ? 'checked' : ''}
                       ${можноВести() ? '' : 'disabled'}>
                <span>Все службы</span>
            </label>` : '') + действующие.map(с => `
            <label class="кДопуск">
                <input type="checkbox" data-допуск="${с.id}"
                       ${открытый.допуск.has(с.id) ? 'checked' : ''}
                       ${можноВести() ? '' : 'disabled'}>
                <span>${e(Layout.getName(с))}</span>
            </label>`).join('') || '<span class="text-sm opacity-70">Служб пока нет</span>';
    }

    function рисоватьОтметки() {
        const свои = отметки.filter(а => а.person_id === открытый.id);
        const можноСнимать = можноВести() || открытый.мой;
        $('#кОтметки').innerHTML = свои.map(а => `
            <li class="flex items-center gap-2 py-1.5 border-b border-base-200 last:border-0">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold text-sm">${DateUtils.formatShort(DateUtils.parseDate(а.date_from))} —
                        ${а.date_to ? DateUtils.formatShort(DateUtils.parseDate(а.date_to)) : 'пока не снимет'}</span>
                    ${а.reason ? `<span class="block text-sm opacity-70">${e(а.reason)}</span>` : ''}
                </span>
                ${можноСнимать
                    ? `<button class="btn btn-ghost btn-xs text-error" data-снятьОтметку="${а.id}">снять</button>` : ''}
            </li>`).join('') || '<li class="text-sm opacity-70">Отъездов не отмечено</li>';
    }

    async function рисоватьЗаметки() {
        if (!можноВести()) return;
        // карточку могли закрыть и открыть другую, пока шёл запрос:
        // заметки одного человека не должны лечь в карточку другого
        const чьи = открытый.id;
        const { data, error } = await Layout.db.from('worship_person_notes')
            .select('id, body, created_at, created_by')
            .eq('person_id', чьи).order('created_at', { ascending: false });
        if (открытый?.id !== чьи) return;
        if (error) return Layout.handleError(error, 'Заметки');

        const авторы = [...new Set((data || []).map(з => з.created_by).filter(Boolean))];
        let имена = {};
        if (авторы.length) {
            const { data: в } = await Layout.db.from('vaishnavas')
                .select('user_id, spiritual_name, first_name, last_name').in('user_id', авторы);
            имена = Object.fromEntries((в || []).map(x => [x.user_id,
                x.spiritual_name || `${x.first_name || ''} ${x.last_name || ''}`.trim()]));
            if (открытый?.id !== чьи) return;
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

    /** Допуск ко всем действующим службам разом — или снять все. */
    async function допускКоВсем(включить) {
        const ids = службы.filter(с => с.is_active).map(с => с.id);
        const нужно = включить ? ids.filter(id => !открытый.допуск.has(id)) : ids.filter(id => открытый.допуск.has(id));
        if (!нужно.length) return true;
        const запрос = включить
            ? Layout.db.from('worship_person_services')
                .insert(нужно.map(id => ({ person_id: открытый.id, service_id: id })))
            : Layout.db.from('worship_person_services')
                .delete().eq('person_id', открытый.id).in('service_id', нужно);
        const { data, error } = await запрос.select('service_id');
        if (error) { Layout.handleError(error, 'Допуск'); return false; }
        if (!data?.length) {
            Layout.showNotification('Не сохранилось: допуски ведёт старший пуджари', 'error');
            return false;
        }
        data.forEach(д => включить ? открытый.допуск.add(д.service_id) : открытый.допуск.delete(д.service_id));
        return true;
    }

    async function переключитьДопуск(serviceId, включить) {
        const запрос = включить
            ? Layout.db.from('worship_person_services')
                .insert({ person_id: открытый.id, service_id: serviceId })
            : Layout.db.from('worship_person_services')
                .delete().eq('person_id', открытый.id).eq('service_id', serviceId);
        const { data, error } = await запрос.select('person_id');
        if (error) { Layout.handleError(error, 'Допуск'); return false; }
        if (!data?.length) {
            Layout.showNotification('Не сохранилось: допуски ведёт старший пуджари', 'error');
            return false;
        }
        if (включить) открытый.допуск.add(serviceId); else открытый.допуск.delete(serviceId);
        return true;
    }

    function открытьОтметку(personId) {
        $('#отметкаМодал').dataset.кому = personId;
        const сам = personId === яЧеловек?.id;
        const имя = люди.find(ч => ч.id === personId)?.имя || 'Человек';
        $('#отметкаЗаголовок').textContent = сам ? 'Меня не будет' : `${имя}: не будет на службах`;
        $('#отметкаТекст').textContent = сам
            ? 'Пока отметка стоит, на службу вас не поставят. Старший увидит отметку в расписании — '
              + 'сообщение ему пока не уходит, поэтому о срочном скажите голосом.'
            : `Пока отметка стоит, ${имя} не будет в выборе на службы, а уже стоящие назначения `
              + 'в эти дни станут в расписании жёлтыми — их нужно будет заменить.';
        $('#оtС').value = DateUtils.todayAshramISO();
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
        const сам = personId === яЧеловек?.id;
        const сколько = Layout.pluralize(клеток, {
            ru: ['назначение', 'назначения', 'назначений'], en: ['duty', 'duties'], hi: 'सेवा' });
        Layout.showNotification(!клеток ? 'Отмечено'
            : сам ? `Отмечено. На эти дни уже стоит ${сколько} — старший заменит`
            // старшему — прямо, что делать дальше
            : `Отмечено. В эти дни уже стоит ${сколько} — замените в расписании`,
            клеток && !сам ? 'warning' : 'success');
    }

    /**
     * Срок участия волонтёра: после него человек уходит из выбора сам,
     * а старший получает предупреждение, если всё же ставит его в клетку.
     */
    /** Команда или волонтёр: переключатель в карточке, запись сразу. */
    function рисоватьВид() {
        $('#кВидБлок').hidden = !можноВести();
        document.querySelectorAll('[data-вид-человека]').forEach(б =>
            б.classList.toggle('btn-active',
                б.getAttribute('data-вид-человека') === (открытый.kind || 'team')));
        $('#кВидПодпись').textContent = (открытый.kind || 'team') === 'volunteer'
            ? 'Приехал на время. Ставьте с оглядкой на срок участия ниже.'
            : 'Постоянный состав отдела.';
    }

    /** Посвящение — выбор старшего: не указано / нет / первая / вторая. */
    function рисоватьПосвящение() {
        $('#кПосвящениеБлок').hidden = !можноВести();
        document.querySelectorAll('[data-посвящение]').forEach(б =>
            б.classList.toggle('btn-active', б.getAttribute('data-посвящение') === (открытый.initiation || '')));
    }

    async function записатьПосвящение(код) {
        const { data, error } = await Layout.db.from('worship_people')
            .update({ initiation: код || null, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', открытый.id).select('id');
        if (error) return Layout.handleError(error, 'Посвящение');
        if (!data?.length) return Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');
        открытый.initiation = код || null;
        рисоватьПосвящение();
        рисоватьШапку();
        await перечитать();
    }

    async function записатьВид(вид) {
        const { data, error } = await Layout.db.from('worship_people')
            .update({ kind: вид, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', открытый.id).select('id');
        if (error) return Layout.handleError(error, 'Кто в отделе');
        if (!data?.length) return Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');
        открытый.kind = вид;
        рисоватьВид();
        рисоватьШапку();
        await перечитать();
    }

    async function записатьСрок() {
        const с = $('#кСрокС').value || null;
        const по = $('#кСрокПо').value || null;
        if (с && по && по < с) {
            Layout.showNotification('Дата окончания раньше начала', 'warning');
            return false;
        }
        const { data, error } = await Layout.db.from('worship_people')
            .update({ active_from: с, active_to: по, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', открытый.id).select('id');
        if (error) { Layout.handleError(error, 'Срок участия'); return false; }
        if (!data?.length) {
            Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');
            return false;
        }
        await перечитать();
        // шапка карточки показывает срок — обновляем её по свежим данным
        открытый = люди.find(ч => ч.id === открытый.id) || открытый;
        рисоватьШапку();
        return true;
    }

    /** Из резерва — обратно в отдел. Истёкший срок участия снимаем, иначе
     *  вернувшийся сразу горит «срок истёк» в окне «поставить». */
    async function вернуть(id) {
        const ч = люди.find(x => x.id === id);
        if (!ч) return;
        const правка = { is_active: true, updated_at: new Date().toISOString(),
                         updated_by: window.currentUser?.id || null };
        if (ч.active_to && ч.active_to < DateUtils.todayAshramISO()) правка.active_to = null;
        const { data, error } = await Layout.db.from('worship_people').update(правка).eq('id', id).select('id');
        if (error) return Layout.handleError(error, 'Человек');
        if (!data?.length) return Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');
        $('#карточка').open && $('#карточка').close();
        await перечитать();
        Layout.showNotification(`${ч.имя} снова в отделе`, 'success');
    }

    /** Убрать из резерва совсем: со страницы пропадает, прошлые службы остаются. */
    async function убрать(id) {
        const ч = люди.find(x => x.id === id);
        if (!ч) return;
        if (!await спросить(`Убрать из резерва: ${ч.имя}?`,
            'Человек пропадёт со страницы людей. Прошлые службы и записи останутся в истории, '
            + 'назначения впереди снимем. Понадобится снова — добавьте его кнопкой «Добавить человека».')) return;
        const { data, error } = await Layout.db.rpc('worship_person_remove', { p_person: id });
        if (error) return Layout.handleError(error, 'Человек');
        $('#карточка').open && $('#карточка').close();
        await перечитать();
        const снято = data?.['снято_назначений'] || 0;
        Layout.showNotification(`${ч.имя}: убран из резерва${снято ? `, снято назначений: ${снято}` : ''}`, 'success');
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
            `Папок со снимками: ${data?.['наборов'] || 0}`,
            `Заметок о человеке: ${data?.['заметок'] || 0}`,
            '',
            впереди
                ? 'Клетки не очистятся сами — они станут видимо пустыми, и их придётся закрыть кем-то другим.'
                : 'Записи человека останутся на месте. Вернуть из резерва можно в любой момент.',
        ];
        if (!await спросить(`В резерв: ${открытый.имя}?`, строки.join('\n'))) return;

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
    // поиск по мере набора: ответ на «Ра» не должен лечь поверх ответа на «Радха»
    let поколениеПоиска = 0;

    /** Кнопка занята, пока идёт её дело: второй щелчок не создаёт дубль. */
    async function разом(кнопка, дело) {
        if (кнопка.disabled) return;
        кнопка.disabled = true;
        try { return await дело(); } finally { кнопка.disabled = false; }
    }

    async function искатьЛюдей() {
        const моё = ++поколениеПоиска;
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
        if (моё !== поколениеПоиска) return;
        if (error) return Layout.handleError(error, 'Поиск человека');

        // выведенный из отдела — не «уже в отделе»: его можно вернуть,
        // а раньше кнопки не было, и вернуть человека было нельзя вовсе
        const уже = new Set(люди.filter(ч => ч.is_active !== false && !ч.removed_at).map(ч => ч.vaishnava_id));
        const выбыли = new Set(люди.filter(ч => ч.is_active === false && !ч.removed_at).map(ч => ч.vaishnava_id));
        $('#дСписок').innerHTML = (data || []).map(в => {
            // духовные имена повторяются — рядом всегда мирское, иначе
            // двух «Радха дас» в списке не отличить друг от друга
            const мирское = `${в.first_name || ''} ${в.last_name || ''}`.trim();
            const имя2 = в.spiritual_name || мирское || 'без имени';
            return `
            <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${e(имя2)}</span>
                    ${!в.user_id
                        ? '<span class="badge badge-sm whitespace-nowrap badge-ghost ml-1">нет входа</span>'
                        : ''}
                    ${в.spiritual_name && мирское
                        ? `<span class="block text-sm opacity-70">${e(мирское)}</span>` : ''}
                </span>
                ${уже.has(в.id)
                    ? '<span class="text-sm opacity-60">уже в отделе</span>'
                    : `<button class="btn btn-sm btn-outline" data-взять="${в.id}">${
                        выбыли.has(в.id) ? 'Вернуть в отдел' : 'Добавить'}</button>`}
            </li>`;
        }).join('') || '<li class="py-3 text-sm opacity-60">Никого не нашлось</li>';
    }

    /** Кем человека добавляют: выбрано в окне, по умолчанию — команда. */
    let новыйВид = 'team';

    function рисоватьНовыйВид() {
        document.querySelectorAll('[data-новый-вид]').forEach(б =>
            б.classList.toggle('btn-active', б.getAttribute('data-новый-вид') === новыйВид));
        $('#дСрокБлок').hidden = новыйВид !== 'volunteer';
    }

    async function добавить(vaishnavaId) {
        const бессрочно = $('#дБессрочно').checked;
        const срок = новыйВид === 'volunteer' && !бессрочно
            ? ($('#дСрокПо').value || null) : null;
        if (новыйВид === 'volunteer' && !срок && !бессрочно) {
            Layout.showNotification('Поставьте день окончания или отметьте, что срок не известен', 'warning');
            return $('#дСрокПо').focus();
        }
        const с = $('#дСрокС').value || DateUtils.todayAshramISO();
        if (срок && срок < с) {
            Layout.showNotification('День окончания раньше дня начала', 'warning');
            return $('#дСрокПо').focus();
        }

        // вернуть выведенного — это не новая запись: человек один
        const был = люди.find(ч => ч.vaishnava_id === vaishnavaId);
        const запрос = был
            ? Layout.db.from('worship_people').update({
                is_active: true, kind: новыйВид, active_from: с, active_to: срок,
                removed_at: null, removed_by: null,
                updated_at: new Date().toISOString(),
                updated_by: window.currentUser?.id || null }).eq('id', был.id)
            : Layout.db.from('worship_people').insert({
                vaishnava_id: vaishnavaId, kind: новыйВид, active_to: срок,
                active_from: с,
                created_by: window.currentUser?.id || null });

        const { data, error } = await запрос.select('id');
        if (error) return Layout.handleError(error, 'Человек');
        if (!data?.length) return Layout.showNotification('Не сохранилось: состав ведёт старший', 'error');

        $('#добавлениеМодал').close();
        await перечитать();
        // сразу в карточку: следующий шаг — отметить, к каким службам допущен
        if (data[0]?.id) {
            await открыть(data[0].id);
            Layout.showNotification('Добавлен. Отметьте, к каким службам допущен', 'success');
        }
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
            if (взять) return разом(взять, () => добавить(взять.dataset.взять));

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
            const новый = ev.target.closest('[data-новый-вид]');
            if (новый) {
                новыйВид = новый.getAttribute('data-новый-вид');
                рисоватьНовыйВид();
                return;
            }

            if (b.id === 'добавить') {
                $('#дПоиск').value = '';
                новыйВид = 'team';
                $('#дСрокС').value = DateUtils.todayAshramISO();
                $('#дСрокПо').value = '';
                $('#дБессрочно').checked = false;
                рисоватьНовыйВид();
                $('#дСписок').innerHTML = '<li class="py-3 text-sm opacity-60">Впишите часть имени.</li>';
                return $('#добавлениеМодал').showModal();
            }
            if (b.id === 'яНеСмогу') return открытьОтметку(яЧеловек.id);
            if (b.id === 'кДобавитьОтметку') return открытьОтметку(открытый.id);
            if (b.id === 'оtСохранить') return сохранитьОтметку();
            if (b.id === 'кИсключить') return исключить();
            if (b.id === 'кВернуть') return разом(b, () => вернуть(открытый.id));
            if (b.id === 'кУбрать') return разом(b, () => убрать(открытый.id));
            if (b.dataset.вернуть) return разом(b, () => вернуть(b.dataset.вернуть));
            if (b.dataset.убрать) return разом(b, () => убрать(b.dataset.убрать));
            const вид = ev.target.closest('[data-вид-человека]');
            if (вид && открытый) return записатьВид(вид.getAttribute('data-вид-человека'));
            const посв = ev.target.closest('[data-посвящение]');
            if (посв && открытый) return записатьПосвящение(посв.getAttribute('data-посвящение'));

            if (b.id === 'кСрокСохранить') {
                const ок = await записатьСрок();
                if (ок) Layout.showNotification('Срок участия сохранён', 'success');
                return;
            }
            if (b.id === 'кЗаметкаДобавить') return разом(b, async () => {
                const текст = $('#кЗаметкаТекст').value.trim();
                if (!текст) return;
                const { error } = await Layout.db.from('worship_person_notes').insert({
                    person_id: открытый.id, body: текст,
                    created_by: window.currentUser?.id || null,
                });
                if (error) return Layout.handleError(error, 'Заметка');
                $('#кЗаметкаТекст').value = '';
                return рисоватьЗаметки();
            });
        });

        document.addEventListener('change', async ev => {
            const все = ev.target.closest('[data-допускВсе]');
            if (все) {
                все.disabled = true;
                try { await допускКоВсем(все.checked); }
                finally { рисоватьДопуски(); }        // галочки — по тому, что записалось; сбой не запирает кнопку
                return;
            }
            const д = ev.target.closest('[data-допуск]');
            if (!д) return;
            const вышло = await переключитьДопуск(д.dataset.допуск, д.checked);
            if (!вышло) д.checked = !д.checked;       // вернём галочку, раз не записалось
            рисоватьДопуски();                        // «Все службы» отметится или снимется сам
        });

        $('#дПоиск').addEventListener('input', Layout.debounce(искатьЛюдей, 300));
        $('#поиск').addEventListener('input', Layout.debounce(рисовать, 200));
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
