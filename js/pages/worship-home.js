/**
 * Главная модуля.
 *
 * Почти каждое обращение к отделу — это «как это делается», а не «покажи
 * оглавление». Поэтому первым стоит поиск во всю ширину, а не список разделов.
 * Ниже — то, что ждёт конкретного человека: очередь у старшего, черновики
 * у пуджари, лента изменений у всех.
 *
 * Расписание тут двумя блоками: службы на сегодня (следующая выделена) —
 * всем, кто видит модуль, и пустые клетки на завтра — старшему. Пустых
 * заглушек нет: блок, которому нечего показать, не рисуется вовсе.
 */
const WorshipHome = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const дата = v => v ? DateUtils.formatShort(new Date(v)) : '';

    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

    let разделы = [], статьи = [];
    let основа = Promise.resolve();    // разделы и статьи: ждут их лента и закладки

    /** `подпись` — уже готовая разметка: собирают её вызывающие, экранируя текст. */
    /**
     * Строка боковой сводки. Жирное начертание и разделитель у каждой
     * строки превращали список из двух ссылок в лестницу заголовков:
     * справочное кричало громче служб дня. Здесь ссылка и есть ссылка.
     */
    function строка(id, заголовок, подписьHTML) {
        return `
        <li>
            <a href="article.html?id=${id}" class="block text-sm py-1 leading-snug
                      hover:text-[color:var(--current-color)] transition-colors">${e(заголовок)}</a>
            ${подписьHTML ? `<span class="block text-xs opacity-70 pb-1">${подписьHTML}</span>` : ''}
        </li>`;
    }


    /**
     * Группа боковой сводки: счётчик в заголовке и сворачивание. Длинный
     * список подборок или разделов вытеснял всё остальное вниз, поэтому
     * группа, где больше пяти строк, по умолчанию свёрнута — видно, что
     * там есть и сколько, но экран она не занимает.
     */
    const ПОРОГ_СВОРАЧИВАНИЯ = 5;
    const ПОКАЗЫВАЕМ = 10;          // длиннее сводка перестаёт быть сводкой
    // v2: в прежнем ключе вперемешку лежали выборы человека и умолчания по порогу
    const КЛЮЧ_СВОДКИ = 'worship_home_summary_v2';

    /** Последняя строка списка, когда в нём больше, чем помещается. */
    const хвостСписка = (всего, куда) => всего > ПОКАЗЫВАЕМ
        ? `<li><a href="${куда}" class="block text-sm py-1 font-semibold
                  text-[color:var(--current-color)] hover:underline">Посмотреть все · ${всего}</a></li>`
        : '';

    const сохранённоеСводки = () => {
        try { return JSON.parse(localStorage.getItem(КЛЮЧ_СВОДКИ) || '{}'); }
        catch { return {}; }
    };

    function настроитьГруппу(ид, сколько) {
        const блок = $('#' + ид);
        if (!блок) return;
        блок.hidden = !сколько;
        if (!сколько) return;

        блок.querySelector('.счётчикСводки').textContent = сколько;
        const свой = сохранённоеСводки()[ид];
        блок.open = свой !== undefined ? свой : сколько <= ПОРОГ_СВОРАЧИВАНИЯ;
    }

    function помнитьГруппы() {
        // Запоминаем только щелчок человека. toggle срабатывает и от
        // настроитьГруппу(), когда группа сворачивается по порогу, — такое
        // умолчание записывалось как выбор, и группа оставалась свёрнутой
        // навсегда, даже когда в ней становилось два пункта.
        document.addEventListener('click', ev => {
            const заголовок = ev.target.closest('summary');
            const блок = заголовок?.parentElement;
            if (!блок?.matches('.группаСводки') || !блок.id) return;
            try {
                const всё = сохранённоеСводки();
                всё[блок.id] = !блок.open;      // щелчок ещё не применён
                localStorage.setItem(КЛЮЧ_СВОДКИ, JSON.stringify(всё));
            } catch { /* приватный режим — просто не запомним */ }
        });
    }

    /**
     * Имена по id пользователей. vaishnavas отдаёт чужие карточки только
     * сотрудникам — пуджари без этих прав видел бы «отдел» вместо имени,
     * поэтому через worship_user_names (мигр. 277): только имя и только отделу.
     */
    async function именаЛюдей(ids) {
        const кто = [...new Set(ids.filter(Boolean))];
        if (!кто.length) return {};
        const { data } = await Layout.db.rpc('worship_user_names', { p_users: кто });
        return Object.fromEntries((data || []).map(ч => [ч.user_id, ч.name]));
    }

    async function лента() {
        const { data, error } = await Layout.db.from('worship_versions')
            .select('id, article_id, title, version_no, change_note, approved_at, created_by, approved_by')
            .eq('status', 'published').not('approved_at', 'is', null)
            .order('approved_at', { ascending: false }).limit(8);
        if (error) { Layout.handleError(error, 'Лента изменений'); return; }

        // отменённые в ленту не попадают: «утверждён» рядом с «не действует»
        // читается как противоречие, а не как история
        const [, имена] = await Promise.all([основа,
            именаЛюдей((data || []).flatMap(в => [в.created_by, в.approved_by]))]);
        const действующие = new Set(статьи.filter(с => с.status === 'published').map(с => с.id));
        // кто правил — сразу за датой; кто утверждал — только если другой человек
        const кто = в => {
            const автор = имена[в.created_by];
            const утвердил = в.approved_by && в.approved_by !== в.created_by ? имена[в.approved_by] : null;
            return [автор && e(автор), утвердил && `утверждение — ${e(утвердил)}`]
                .filter(Boolean).map(x => ' · ' + x).join('');
        };
        $('#feed').innerHTML = (data || []).filter(в => действующие.has(в.article_id)).map(в => строка(в.article_id, в.title,
            `${дата(в.approved_at)}${кто(в)}${в.version_no > 1 && в.change_note
                ? ' · ' + e(в.change_note) : в.version_no === 1 ? ' · новый стандарт' : ''}`
        )).join('') || '<li class="py-2 text-sm opacity-60">Пока ничего не утверждали</li>';
    }

    async function черновики() {
        if (!можноПисать()) return;
        const я = window.currentUser?.id;
        const { data, error } = await Layout.db.from('worship_versions')
            .select('article_id, title, status, updated_at, created_by, return_reason')
            .in('status', ['draft', 'submitted'])
            .order('updated_at', { ascending: false });
        if (error) { Layout.handleError(error, 'Черновики'); return; }

        // свои сверху, чужие ниже: отдел пишет сообща, но спрашивают с автора
        const свои = (data || []).filter(в => в.created_by === я);
        const чужие = (data || []).filter(в => в.created_by !== я);
        const список = [...свои, ...чужие];
        if (!список.length) return;

        // имена авторов: «чей это черновик» — первый вопрос к чужой строке
        const имена = await именаЛюдей(список.map(в => в.created_by));

        $('#draftsCard').hidden = false;
        $('#drafts').innerHTML = список.map(в => {
            // возврат старшего виден прямо здесь: иначе о нём узнают случайно,
            // открыв статью — рассылка до подключения чата молчит
            const возврат = в.return_reason
                ? `<span class="badge badge-sm badge-warning mr-1">вернули</span>${e(в.return_reason)} · `
                : '';
            const чей = в.created_by === я ? '' : `${e(имена[в.created_by] || 'отдел')} · `;
            const что = в.status === 'submitted' ? 'ждёт утверждения' : 'черновик';
            return строка(в.article_id, в.title, `${возврат}${чей}${что} · ${дата(в.updated_at)}`);
        }).join('');
    }

    async function очередь() {
        if (!можноУтверждать()) return;
        const { data, error } = await Layout.db.from('worship_versions')
            .select('article_id, title, change_note, updated_at, created_by')
            .eq('status', 'submitted').order('updated_at');
        if (error) { Layout.handleError(error, 'Очередь'); return; }
        if (!data?.length) return;
        // старшему важно, чью правку он решает
        const имена = await именаЛюдей(data.map(в => в.created_by));

        $('#queueBox').hidden = false;
        $('#queueCount').textContent = data.length;
        $('#queueList').innerHTML = data.map(в => `
            <a href="article.html?id=${в.article_id}"
               class="flex flex-col desktop:flex-row desktop:items-center gap-2 bg-base-100 border border-base-300 rounded-lg px-4 py-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold block">${e(в.title)}</span>
                    <span class="text-sm opacity-60">${
                        имена[в.created_by] ? e(имена[в.created_by]) + ' · ' : ''}${
                        в.change_note ? '«' + e(в.change_note) + '» · ' : ''}${дата(в.updated_at)}</span>
                </span>
                <span class="btn btn-sm self-start" style="background: var(--current-color); color:#fff;">Открыть</span>
            </a>`).join('');
    }

    /** Подборки: ответ на вопрос «с чего начать», который иначе без экрана. */
    async function подборки() {
        // берём на одну больше, чем показываем: так видно, что список
        // не кончился, даже если точный счёт не пришёл
        const { data: все, count } = await Layout.db.from('worship_kits')
            .select('id, title', { count: 'exact' })
            .eq('is_active', true).order('title').limit(ПОКАЗЫВАЕМ + 1);
        if (!все?.length) return;
        let data = все, всего = count ?? все.length;
        // пустая подборка читателю ни к чему — её ещё собирают
        if (!можноПисать()) {
            const { data: пункты } = await Layout.db.from('worship_kit_items')
                .select('kit_id, article_id, album_id').in('kit_id', все.map(п => п.id));
            const непустые = new Set((пункты || []).filter(п => п.article_id || п.album_id).map(п => п.kit_id));
            data = все.filter(п => непустые.has(п.id));
            всего = data.length;
            if (!data.length) return;
        }

        // описание подборки в сводке не нужно: сюда заходят по названию,
        // а подробности ждут на самой странице подборки
        $('#kits').innerHTML = data.slice(0, ПОКАЗЫВАЕМ).map(п => `
            <li>
                <a href="kit.html?id=${п.id}" class="block text-sm py-1 leading-snug
                          hover:text-[color:var(--current-color)] transition-colors">${e(п.title)}</a>
            </li>`).join('') + хвостСписка(всего, 'kits.html');
        настроитьГруппу('kitsCard', всего);
    }

    /**
     * Службы на сегодня: главный вопрос к отделу — «что сейчас», а не
     * «покажи оглавление». Следующая по времени выделена.
     */
    async function деньСегодня(дата, завтрашний) {
        const сегодня = дата || DateUtils.todayAshramISO();
        // люди и отметки отъезда — в том же круге, что и расписание:
        // вторым кругом они добавляли к главной ещё одну поездку до базы
        const [с, о, н, весь, отм] = await Promise.all([
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day, article_id')
                .eq('is_active', true).order('time_of_day'),
            Layout.db.from('worship_day_overrides')
                .select('id, service_id, title, time_of_day, reason').eq('duty_date', сегодня),
            Layout.db.from('worship_duties')
                .select('id, service_id, override_id, person_id, role').eq('duty_date', сегодня),
            Layout.db.rpc('worship_people_list'),
            Layout.db.from('worship_absences')
                .select('person_id, date_from, date_to').lte('date_from', сегодня),
        ]);
        if (с.error || о.error || н.error) return;      // расписание не повод ронять главную
        const моё = await моёId();                     // тот же запрос, что у «моих служб»
        const службы = с.data || [], отклонения = о.data || [], назначения = н.data || [];
        if (!службы.length && !отклонения.length) return;

        // имена: они нужны только тем, кто видит модуль, гостю этот экран недоступен
        let имена = {};
        let придёт = () => true;
        const persons = [...new Set(назначения.map(д => д.person_id))];
        if (persons.length) {
            const весьОтдел = весь.data, отметки = отм.data;
            const нужные = new Set(persons);
            const люди = (весьОтдел || []).filter(ч => нужные.has(ч.id));
            имена = Object.fromEntries(люди.map(ч => [ч.id, ч.name]));
            // те же правила, что в шахматке: заболевший, выбывший или волонтёр
            // с истёкшим сроком службу не закрывает — и здесь не должен
            // выглядеть тем, кто к ней встанет
            const карта = Object.fromEntries((люди || []).map(ч => [ч.id, ч]));
            придёт = д => {
                const ч = карта[д.person_id];
                if (!ч || ч.is_active === false) return false;
                if (ч.active_to && ч.active_to < сегодня) return false;
                if (ч.active_from && ч.active_from > сегодня) return false;
                return !(отметки || []).some(а => а.person_id === ч.id
                    && а.date_from <= сегодня && (!а.date_to || а.date_to >= сегодня));
            };
        }

        const отменена = id => отклонения.some(о2 => о2.service_id === id);
        const строки = [
            ...службы.filter(с2 => !отменена(с2.id)).map(с2 => ({
                время: с2.time_of_day, имя: Layout.getName(с2), article_id: с2.article_id,
                кто: назначения.filter(д => д.service_id === с2.id), разовая: false })),
            ...отклонения.filter(о2 => о2.title).map(о2 => ({
                время: о2.time_of_day, имя: о2.title, article_id: null,
                кто: назначения.filter(д => д.override_id === о2.id), разовая: true })),
        ].sort((a, b) => (a.время || '').localeCompare(b.время || ''));

        const сейчас = завтрашний ? '00:00:00' : DateUtils.nowAshram().toTimeString().slice(0, 8);
        const следующая = строки.find(с2 => (с2.время || '') >= сейчас);

        // день кончился — показывать прошедшие службы с «никто не поставлен»
        // значит упрекать задним числом за то, чего уже не исправить.
        // Человеку в этот час нужен завтрашний день
        if (!следующая && !завтрашний) {
            const завтра = DateUtils.nowAshram();
            завтра.setDate(завтра.getDate() + 1);
            return деньСегодня(DateUtils.toISO(завтра), true);
        }

        $('#todayЗаголовок').textContent = завтрашний ? 'Службы завтра' : 'Службы сегодня';
        $('#todayHint').textContent = завтрашний ? 'На сегодня службы кончились. ' : '';

        $('#todayCard').hidden = false;
        $('#today').innerHTML = строки.map(с2 => {
            const прошла = !завтрашний && (с2.время || '') < сейчас;
            return `
            <li class="flex items-baseline gap-3 border-b border-base-200 last:border-0 py-2 ${
                прошла ? 'opacity-50' : ''} ${с2 === следующая ? 'font-semibold' : ''}">
                <span class="w-12 shrink-0 tabular-nums ${
                    // у прошедшей строка уже приглушена — второй слой делал время нечитаемым
                    с2 === следующая || прошла ? '' : 'opacity-70'}">${e((с2.время || '').slice(0, 5))}</span>
                <span class="flex-1 min-w-0">
                    ${с2.article_id
                        ? `<a class="link link-hover" href="article.html?id=${с2.article_id}">${e(с2.имя)}</a>`
                        : e(с2.имя)}
                    ${с2.разовая ? '<span class="badge badge-sm ml-1">разовая</span>' : ''}
                    ${с2 === следующая
                        ? '<span class="badge badge-sm ml-1" style="background: var(--current-color); color:#fff; border:0;">следующая</span>'
                        : ''}
                    ${с2.кто.length
                        ? `<span class="block text-sm ${прошла ? "" : "opacity-70"}">${
                            с2.кто.map(д => (придёт(д)
                                ? e(имена[д.person_id] || 'кто-то')
                                // зачёркнутое имя без слов новичку непонятно
                                : `<s>${e(имена[д.person_id] || 'кто-то')}</s> <span class="text-error">не придёт</span>`)
                                + (д.role === 'helper' ? ' (помощник)' : д.role === 'kirtan' ? ' (киртания)' : '')
                                + (д.person_id === моё ? ЗНАК_ВЫ : '')).join(', ')}</span>`
                        : ''}
                    ${!прошла && !с2.кто.some(д => д.role === 'pujari' && придёт(д))
                        ? `<span class="block text-sm text-error">${
                            // помощник пришёл, а вести службу некому — это тоже дыра
                            с2.кто.some(придёт) ? 'нет ведущего — только помощник'
                            : с2.кто.length ? 'поставленный не придёт — нужна замена' : 'никто не поставлен'}</span>`
                        : ''}
                </span>
            </li>`;
        }).join('');
    }

    /**
     * Пуджари открывает модуль в 4:20 не ради общего списка: ему нужно
     * «у вас в 04:45 мангала-арати». Поэтому свои службы идут отдельным
     * блоком и выше общего расписания дня.
     */
    // «я» в отделе — нужно и своим службам, и «вы» в службах дня
    let моёПромис = null;
    const моёId = () => (моёПромис ||= Layout.db.rpc('worship_my_person').then(r => r.data || null));
    const ЗНАК_ВЫ = '<span class="badge badge-xs ml-0.5 border-0" style="background: var(--current-color); color:#fff;">вы</span>';
    const МОЯ_РОЛЬ = { pujari: 'ведёте', kirtan: 'киртания', helper: 'помощник' };

    async function моиСлужбы() {
        const я = await моёId();
        if (!я) return;

        const сегодня = DateUtils.todayAshramISO();
        const { data: свои } = await Layout.db.from('worship_duties')
            .select('id, duty_date, service_id, override_id, role')
            .eq('person_id', я).gte('duty_date', сегодня).order('duty_date').limit(5);
        if (!свои?.length) return;

        const [{ data: службы2 }, { data: откл }, { data: отметки }] = await Promise.all([
            Layout.db.from('worship_services').select('id, name_ru, name_en, name_hi, time_of_day, article_id, is_active'),
            Layout.db.from('worship_day_overrides')
                .select('id, duty_date, service_id, title, time_of_day')
                .in('duty_date', [...new Set(свои.map(н => н.duty_date))]),
            // своя «меня не будет»: после неё служба должна читаться как
            // ждущая замены, а не как обычная
            Layout.db.from('worship_absences').select('date_from, date_to')
                .eq('person_id', я).or(`date_to.is.null,date_to.gte.${сегодня}`),
        ]);
        const меняНеБудет = день => (отметки || []).some(а =>
            а.date_from <= день && (!а.date_to || а.date_to >= день));

        const отключена = н => н.service_id
            && (службы2 || []).find(x => x.id === н.service_id)?.is_active === false;
        const отменена = н => отключена(н) || (н.service_id && (откл || []).some(о =>
            о.service_id === н.service_id && о.duty_date === н.duty_date));

        $('#mineCard').hidden = false;
        $('#mine').innerHTML = свои.map(н => {
            const с = (службы2 || []).find(x => x.id === н.service_id);
            const о = (откл || []).find(x => x.id === н.override_id);
            const имя = с ? Layout.getName(с) : (о?.title || 'служба');
            const время = (с?.time_of_day || о?.time_of_day || '').slice(0, 5);
            const снята = отменена(н);
            return `
            <li class="border-b border-base-200 last:border-0 py-2 ${снята ? 'opacity-60' : ''}">
                <span class="font-semibold">${e(деньПоЧеловечески(н.duty_date))}</span>
                <span class="opacity-70">${e(время)}</span>
                ${с?.article_id && !снята
                    ? `<a class="link" href="article.html?id=${с.article_id}">${e(имя)}</a>`
                    : `<span class="${снята ? 'line-through' : ''}">${e(имя)}</span>`}
                ${снята ? `<span class="badge badge-sm badge-warning ml-1">${отключена(н)
                    ? 'снята с расписания' : 'не проводится'}</span>` : ''}
                ${!снята ? `<span class="badge badge-sm ml-1 ${н.role === 'pujari' ? 'badge-outline' : ''}">${
                    e(МОЯ_РОЛЬ[н.role] || н.role)}</span>` : ''}
                ${!снята && меняНеБудет(н.duty_date)
                    ? '<a href="schedule.html" class="badge badge-sm badge-warning ml-1">вас не будет — нужна замена</a>' : ''}
            </li>`;
        }).join('');
    }

    /** Старшему — пустые клетки на завтра: их закрывают сегодня, а не утром. */
    async function пустыеЗавтра() {
        if (!можноУтверждать()) return;
        const завтра = DateUtils.toISO(DateUtils.addDays(DateUtils.nowAshram(), 1));
        const [с, о, н, л, от] = await Promise.all([
            Layout.db.from('worship_services')
                .select('id, name_ru, name_en, name_hi, time_of_day').eq('is_active', true).order('time_of_day'),
            Layout.db.from('worship_day_overrides').select('id, service_id, title, time_of_day').eq('duty_date', завтра),
            Layout.db.from('worship_duties').select('service_id, override_id, person_id, role').eq('duty_date', завтра),
            Layout.db.from('worship_people').select('id, is_active, active_from, active_to'),
            Layout.db.from('worship_absences').select('person_id, date_from, date_to').lte('date_from', завтра),
        ]);
        if (с.error || о.error || н.error) return;

        // клетку держит только тот, кто придёт: заболевший её не закрывает,
        // иначе «пустых: 2» вместо четырёх ровно в то утро, когда это важно
        const вОтъезде = id => (от.data || []).some(а => а.person_id === id
            && а.date_from <= завтра && (!а.date_to || а.date_to >= завтра));
        const вСоставе = id => {
            const ч = (л.data || []).find(x => x.id === id);
            return !!ч && ч.is_active !== false
                && (!ч.active_to || ч.active_to >= завтра)
                && (!ч.active_from || ч.active_from <= завтра);
        };
        // службу держит ведущий пуджари: один помощник клетку не закрывает
        const придёт = д => д.role === 'pujari' && вСоставе(д.person_id) && !вОтъезде(д.person_id);

        const отменена = id => (о.data || []).some(x => x.service_id === id);
        const занята = id => (н.data || []).some(x => x.service_id === id && придёт(x));
        // разовая служба на завтра — такая же клетка: её тоже надо закрыть
        const разовыеПустые = (о.data || []).filter(x => x.title
            && !(н.data || []).some(д => д.override_id === x.id && придёт(д)))
            .map(x => ({ время: x.time_of_day, имя: x.title, разовая: true }));
        const пустые = [
            ...(с.data || []).filter(x => !отменена(x.id) && !занята(x.id))
                .map(x => ({ время: x.time_of_day, имя: Layout.getName(x), разовая: false })),
            ...разовыеПустые,
        ].sort((a, b) => (a.время || '').localeCompare(b.время || ''));
        if (!пустые.length) return;

        $('#emptyCard').hidden = false;
        $('#emptyCount').textContent = пустые.length;
        $('#empty').innerHTML = пустые.map(x => `
            <li class="py-1 text-sm">
                <span class="inline-block w-14 opacity-60">${e((x.время || '').slice(0, 5))}</span>
                ${e(x.имя)}${x.разовая ? ' <span class="badge badge-sm">разовая</span>' : ''}
            </li>`).join('');
    }

    /**
     * Замечания: свои — каждому (и чем кончились), открытые отдела — старшему.
     * RLS отдаёт пишущим все замечания, остальным — только свои.
     */
    async function замечания() {
        const я = window.currentUser?.id;
        const { data, error } = await Layout.db.from('worship_remarks')
            .select('id, article_id, body, state, created_at, created_by, close_reason, closed_at')
            .order('created_at', { ascending: false }).limit(60);
        if (error || !data?.length) return;
        await основа;
        const заголовок = id => статьи.find(с => с.id === id)?.title || 'Стандарт';
        const свои = data.filter(з => з.created_by === я)
            // открытые и разобранные за последний месяц: старое уже не нужно
            .filter(з => з.state === 'open' || (з.closed_at && Date.now() - new Date(з.closed_at) < 30 * 864e5))
            .slice(0, 5);
        const открытыеОтдела = можноУтверждать() ? data.filter(з => з.state === 'open') : [];
        const имена = await именаЛюдей(открытыеОтдела.map(з => з.created_by));

        const судьба = з => з.state === 'accepted'
            ? `<span class="text-success font-semibold">учтено</span>`
            : з.state === 'declined' ? '<span class="font-semibold">не согласились</span>'
            : '<span class="opacity-70">ждёт ответа</span>';
        if (свои.length) {
            $('#моиЗамечанияКарта').hidden = false;
            $('#моиЗамечания').innerHTML = свои.map(з => `
                <li class="border-b border-base-200 last:border-0 py-2">
                    <a class="link link-hover font-semibold" href="article.html?id=${з.article_id}">${e(заголовок(з.article_id))}</a>
                    <div class="text-sm mt-0.5">${e(з.body)}</div>
                    <div class="text-sm mt-0.5">${судьба(з)}${з.close_reason
                        ? ` <span class="opacity-80">— «${e(з.close_reason)}»</span>` : ''}</div>
                </li>`).join('');
        }
        if (открытыеОтдела.length) {
            $('#отделЗамечанияКарта').hidden = false;
            $('#отделЗамечанийСколько').textContent = открытыеОтдела.length;
            $('#отделЗамечания').innerHTML = открытыеОтдела.slice(0, 6).map(з => `
                <li class="border-b border-base-200 last:border-0 py-2">
                    <a class="link link-hover font-semibold" href="article.html?id=${з.article_id}">${e(заголовок(з.article_id))}</a>
                    <div class="text-sm mt-0.5">${e(з.body)}</div>
                    <div class="text-sm opacity-60 mt-0.5">${[имена[з.created_by], дата(з.created_at)].filter(Boolean).map(e).join(' · ')}</div>
                </li>`).join('');
        }
    }

    /** Подборки, выданные мне (мигр. 278), и сколько в них уже открыто. */
    async function мнеВыдали() {
        const [{ data: мои }, { data: открытые }] = await Promise.all([
            Layout.db.rpc('worship_my_kits'),
            Layout.db.from('worship_bookmarks').select('article_id').eq('kind', 'recent'),
        ]);
        if (!мои?.length) return;
        // «открыто» — по недавно открытому: отметки «прочитано» у нас нет,
        // а открыл ли человек пункт, отвечает на вопрос «где я в подборке»
        const был = new Set((открытые || []).map(з => з.article_id));
        $('#выданоКарта').hidden = false;
        $('#выдано').innerHTML = мои.map(п => {
            const всего = п.articles.length, открыто = п.articles.filter(а => был.has(а)).length;
            return `
            <li class="border-b border-base-200 last:border-0 py-2 flex items-baseline gap-3">
                <a class="link link-hover font-semibold flex-1 min-w-0" href="kit.html?id=${п.kit_id}">${e(п.title)}</a>
                <span class="text-sm tabular-nums whitespace-nowrap ${всего && открыто === всего ? 'text-success font-semibold' : 'opacity-70'}">${
                    !всего ? (п.albums ? 'снимки' : '')
                    : открыто === всего ? 'всё открыто'
                    : `открыто ${открыто} из ${всего}`}</span>
            </li>`;
        }).join('');
    }

    async function личное() {
        const { data, error } = await Layout.db.from('worship_bookmarks')
            .select('kind, article_id, created_at').order('created_at', { ascending: false });
        if (error) return;                       // личный список не повод ломать страницу

        await основа;
        const заголовок = id => статьи.find(с => с.id === id)?.title || 'Статья';

        const закладки = (data || []).filter(з => з.kind === 'bookmark' && з.article_id);
        $('#marks').innerHTML = закладки.slice(0, ПОКАЗЫВАЕМ)
            .map(з => строка(з.article_id, заголовок(з.article_id), '')).join('')
            + хвостСписка(закладки.length, 'bookmarks.html');
        настроитьГруппу('marksCard', закладки.length);

        const недавние = (data || []).filter(з => з.kind === 'recent' && з.article_id)
            .filter(з => !закладки.some(з2 => з2.article_id === з.article_id));
        $('#recent').innerHTML = недавние.slice(0, ПОКАЗЫВАЕМ)
            .map(з => строка(з.article_id, заголовок(з.article_id), '')).join('')
            + хвостСписка(недавние.length, 'bookmarks.html');
        настроитьГруппу('recentCard', недавние.length);
    }

    function рисоватьРазделы() {
        // пустой раздел в боковой сводке — строка, по которой некуда идти
        const живые = разделы.filter(р =>
            статьи.some(с => с.section_id === р.id && с.status === 'published'));

        $('#sections').innerHTML = живые.slice(0, ПОКАЗЫВАЕМ).map(р => {
            const сколько = статьи.filter(с => с.section_id === р.id && с.status === 'published').length;
            return `
            <li>
                <a href="standards.html" class="flex items-baseline gap-2 text-sm py-1 leading-snug
                          hover:text-[color:var(--current-color)] transition-colors">
                    <span class="flex-1 min-w-0">${e(Layout.getName(р))}</span>
                    <span class="text-xs opacity-70 tabular-nums">${сколько}</span>
                </a>
            </li>`;
        }).join('') + хвостСписка(живые.length, 'standards.html')
            || '<li class="py-1 text-sm opacity-70">Пока ни одного утверждённого стандарта</li>';

        const сколько = живые.length;
        настроитьГруппу('sectionsCard', сколько);
        // раздел с кнопкой «Все стандарты» нужен даже пустым: иначе из сводки
        // некуда перейти к полному списку
        $('#sectionsCard').hidden = false;
    }

    async function init() {
        помнитьГруппы();
        $('#словарик')?.addEventListener('click', () => window.WorshipGlossary?.окно());
        // ночной режим: как в телефоне → ночь → день (color-init.js)
        const ночь = $('#ночь');
        if (ночь && window.srskNight) {
            const подписать = () => { ночь.title = ночь.ariaLabel = window.srskNight.подпись(); };
            подписать();
            ночь.addEventListener('click', () => {
                window.srskNight.переключить();
                подписать();
                Layout.showNotification(window.srskNight.подпись(), 'info');
            });
        }
        // поиск идёт сразу по стандартам, библиотеке и наборам фото: человек
        // не знает, в каком хранилище ответ. Слушатель вешаем первым — иначе
        // Enter, нажатый до конца загрузки, перезагрузит страницу
        $('#searchForm').addEventListener('submit', ev => {
            ev.preventDefault();
            const q = $('#q').value.trim();
            location.href = q ? `search.html?q=${encodeURIComponent(q)}` : 'search.html';
        });

        // Все блоки главной запрашиваются разом. Раньше они ждали, пока придут
        // разделы и статьи, — лишний круг до базы перед всем остальным.
        // Список статей нужен только ленте и закладкам, и они ждут его сами.
        основа = (async () => {
            const [р, с] = await Promise.all([
                Layout.db.from('worship_sections').select('id, name_ru, name_en, name_hi')
                    .eq('kind', 'standard').eq('is_active', true).order('sort_order'),
                Layout.db.from('worship_articles').select('id, title, section_id, status').eq('kind', 'standard'),
            ]);
            // без этого сбой запроса выглядит как «модуль пуст», а не как ошибка
            if (р.error || с.error) { Layout.handleError(р.error || с.error, 'Загрузка модуля'); return; }
            разделы = р.data || [];
            статьи = с.data || [];
            рисоватьРазделы();
        })();
        await Promise.all([основа, лента(), черновики(), очередь(), личное(), подборки(),
                           моиСлужбы(), деньСегодня(), пустыеЗавтра(), замечания(), мнеВыдали()]);
    }

    return { init };
})();
