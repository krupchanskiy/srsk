/**
 * Чтение статьи.
 *
 * Главный сценарий — не «изучить», а «свериться»: пуджари стоит у алтаря в 4:20
 * и ищет шаг семь. Поэтому у длинной статьи есть оглавление по заголовкам,
 * а место прокрутки запоминается — вернувшись, человек попадает туда же.
 *
 * Состояние показывается строкой под заголовком, а не значком где-то сбоку:
 * «действует с 14 марта, версия 3» — первое, что нужно знать о стандарте.
 */
const WorshipArticle = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const $ = s => document.querySelector(s);
    // пустая метка времени даёт new Date(null) = 1970, поэтому дату форматируем только при наличии
    const дата = v => v ? DateUtils.formatShort(new Date(v)) : '';
    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

    const id = new URLSearchParams(location.search).get('id');
    let статья = null, версии = [], показана = null, раздел = null;
    let снимки = {};                // путь → адрес ограниченного срока
    let замечания = [];
    let имена = {};                 // user_id → как звать человека
    let вЗакладках = false;
    let заменяет = [];              // статьи, которые эта заменила собой
    let заменено = null;            // статья, которой заменили эту

    async function загрузить() {
        if (!id) { Layout.showNotification('Статья не указана', 'warning'); return false; }

        const [{ data: с, error: ош }, { data: вер, error: ошВ }] = await Promise.all([
            Layout.db.from('worship_articles').select('*').eq('id', id).maybeSingle(),
            Layout.db.from('worship_versions')
                .select('id, status, version_no, title, doc, plain_text, change_note, created_by, created_at, updated_at, approved_at, approved_by, return_reason, returned_at')
                .eq('article_id', id).order('created_at'),
        ]);
        if (ош || ошВ) { Layout.handleError(ош || ошВ, 'Загрузка статьи'); return false; }
        if (!с) { Layout.showNotification('Статья не найдена или скрыта', 'warning'); return false; }

        статья = с;
        версии = вер || [];

        // всё остальное об этой статье — одним заходом: на телефоне у алтаря
        // каждый лишний обмен с сервером виден глазами.
        // Связь замены берём в обе стороны: ТЗ требует показывать её на обеих
        // статьях, иначе противоречие между старым и новым замечают случайно
        const [зам0, зам1, з, зам] = await Promise.all([
            Layout.db.from('worship_articles').select('id, title')
                .eq('replaced_by_id', id).order('title'),
            с.replaced_by_id
                ? Layout.db.from('worship_articles').select('id, title').eq('id', с.replaced_by_id).maybeSingle()
                : Promise.resolve({ data: null }),
            Layout.db.from('worship_bookmarks').select('id')
                .eq('kind', 'bookmark').eq('article_id', id).maybeSingle(),
            Layout.db.from('worship_remarks')
                .select('id, body, state, created_at, created_by, closed_at, close_reason')
                .eq('article_id', id).order('created_at', { ascending: false }),
            статья.section_id
                ? Layout.db.from('worship_sections').select('id, name_ru, name_en, name_hi')
                    .eq('id', статья.section_id).maybeSingle().then(о => { раздел = о.data; })
                : Promise.resolve(),
        ]);
        заменяет = зам0.data || [];      // одним стандартом можно отменить несколько
        заменено = зам1.data || null;
        вЗакладках = !!з.data;
        замечания = зам.data || [];

        // ТЗ просит в карточке версии автора и утвердившего, а у замечания —
        // того, кто его оставил: «кто это писал» — первый вопрос к чужому тексту
        const кто = [...new Set([
            ...версии.flatMap(в => [в.created_by, в.approved_by]),
            ...замечания.map(з2 => з2.created_by),
        ].filter(Boolean))];
        if (кто.length) {
            const { data: люди } = await Layout.db.from('vaishnavas')
                .select('user_id, spiritual_name, first_name, last_name').in('user_id', кто);
            имена = Object.fromEntries((люди || []).map(ч => [ч.user_id,
                ч.spiritual_name || `${ч.first_name || ''} ${ч.last_name || ''}`.trim() || 'кто-то из отдела']));
        }

        // По умолчанию открывается ДЕЙСТВУЮЩИЙ текст: у алтаря в 4:20 человек
        // должен видеть то, по чему служат, а не чужую неутверждённую правку.
        // Правка открывается осознанно — ссылкой из очереди или из строки
        // состояния («есть правка на утверждении»), и тогда приходит в адресе.
        const хотят = new URLSearchParams(location.search).get('v');
        показана = (хотят && версии.find(в => в.id === хотят))
                || версии.find(в => в.status === 'published')
                || версии.find(в => в.status === 'submitted')
                || версии.find(в => в.status === 'draft')
                || null;
        return true;
    }

    // ---------- состояние ----------
    const действующая = () => версии.find(в => в.status === 'published');

    function строкаСостояния() {
        if (!показана) return 'Текста пока нет';

        if (статья.status === 'archived') {
            const замена = заменено
                ? ` · заменено статьёй <a class="link" href="article.html?id=${заменено.id}">${
                    e(заменено.title)}</a>`
                : '';
            return `<span class="text-warning font-semibold">Не действует${
                статья.archived_at ? ' с ' + дата(статья.archived_at) : ''}</span>${
                статья.archive_reason ? ' · ' + e(статья.archive_reason) : ''}${замена}`;
        }

        const д = действующая();
        // ссылка-переключатель: с правки на действующий текст и обратно
        const кДействующей = д && д.id !== показана.id
            ? ` · <a class="link" href="article.html?id=${статья.id}">показать действующую</a>` : '';

        if (показана.status === 'published') {
            const правка = версии.find(в => в.status === 'submitted');
            return `<span class="text-success font-semibold">Действует${
                показана.approved_at ? ' с ' + дата(показана.approved_at) : ''}</span> · версия ${показана.version_no}${
                правка ? ` · <a class="link" href="article.html?id=${статья.id}&v=${
                    правка.id}">есть правка на утверждении</a>` : ''}${
                заменяет.length ? ' · заменил ' + заменяет.map(з =>
                    `<a class="link" href="article.html?id=${з.id}">${e(з.title)}</a>`).join(', ') : ''}`;
        }
        if (показана.status === 'submitted') {
            return `<span class="text-warning font-semibold">Правка ждёт утверждения</span>${
                д ? ` · в храме действует версия ${д.version_no}` : ''}${кДействующей}`;
        }
        if (показана.status === 'superseded') {
            return `<span class="opacity-70 font-semibold">Версия ${показана.version_no}, больше не действует</span>${кДействующей}`;
        }
        return `<span class="opacity-70 font-semibold">Черновик</span> · видит только отдел${кДействующей}`;
    }

    function рисоватьШапку() {
        $('#crumb').innerHTML = раздел
            ? `<a href="standards.html" class="link link-hover opacity-70">${e(Layout.getName(раздел))}</a>`
            : '<a href="standards.html" class="link link-hover opacity-70">Стандарты</a>';
        $('#title').textContent = показана?.title || статья.title;
        $('#state').innerHTML = строкаСостояния();

        const угол = $('#printHeader');
        if (угол) {
            угол.textContent = показана?.status === 'published' && показана.approved_at
                ? `${статья.title} · версия ${показана.version_no} · утверждена ${дата(показана.approved_at)}`
                : '';
        }

        // возврат автору виден только автору правки и старшему — остальным он ничего не говорит
        const открытая = версии.find(в => в.status === 'draft' || в.status === 'submitted');
        const возврат = открытая?.return_reason;
        $('#returned').hidden = !возврат;
        if (возврат) $('#returnReason').textContent = открытая.return_reason;
    }

    function рисоватьДействия() {
        const открытая = версии.find(в => в.status === 'draft' || в.status === 'submitted');
        // утверждают и возвращают только тот текст, который сейчас на экране
        const наЭкранеПравка = показана?.status === 'submitted';
        const кнопки = [];

        if (можноПисать() && статья.status !== 'archived') {
            кнопки.push(`<a href="edit.html?id=${статья.id}" class="btn btn-sm"
                style="background: var(--current-color); color:#fff;">${
                открытая ? 'Продолжить правку' : 'Править'}</a>`);
        }
        if (можноУтверждать() && наЭкранеПравка) {
            кнопки.push('<button class="btn btn-sm btn-success text-white" id="approve">Утвердить</button>');
            кнопки.push('<button class="btn btn-sm btn-outline" id="return">Вернуть автору</button>');
        }
        if (можноПисать() && наЭкранеПравка) {
            кнопки.push('<button class="btn btn-sm btn-ghost" id="withdraw">Отозвать</button>');
        }
        // библиотека сравнения приезжает со стороны: без неё кнопка только обманет
        if (предыдущая(показана) && window.Diff) {
            кнопки.push('<button class="btn btn-sm btn-outline" id="diff">Что изменилось</button>');
        }
        кнопки.push(`<button class="btn btn-sm btn-ghost" id="bookmark" title="${
            вЗакладках ? 'Убрать из закладок' : 'В закладки'}">${
            вЗакладках ? '★' : '☆'}</button>`);
        // печатаем только действующее: лист на стене не должен спорить с храмом,
        // поэтому отменённый стандарт не печатается, даже если его версия когда-то действовала
        if (показана?.status === 'published' && статья.status === 'published') {
            кнопки.push('<button class="btn btn-sm btn-outline" id="print">Печать</button>');
        }
        if (можноУтверждать() && статья.status === 'published') {
            кнопки.push(открытая?.status === 'submitted'
                ? `<button class="btn btn-sm btn-ghost" id="archiveBlocked"
                           title="Сначала решите по правке: утвердите или верните автору"
                           >Вывести из действия</button>`
                : '<button class="btn btn-sm btn-ghost" id="archive">Вывести из действия</button>');
        }
        if (можноУтверждать() && статья.status === 'archived') {
            кнопки.push('<button class="btn btn-sm btn-outline" id="unarchive">Вернуть из архива</button>');
        }
        $('#actions').innerHTML = кнопки.join('');
    }

    /**
     * Предыдущая версия: для правки — действующая, для утверждённой — та,
     * что была до неё. Сравнивать не с чем только у самой первой.
     */
    function предыдущая(в) {
        if (!в) return null;
        if (в.status === 'draft' || в.status === 'submitted') return действующая() || null;
        const готовые = версии.filter(x => x.version_no).sort((a, b) => a.version_no - b.version_no);
        const i = готовые.findIndex(x => x.id === в.id);
        return i > 0 ? готовые[i - 1] : null;
    }

    function показатьСравнение() {
        const было = предыдущая(показана);
        if (!было) return;

        $('#diffSub').textContent = `${было.version_no ? 'Версия ' + было.version_no : 'Прежний текст'} → ${
            показана.status === 'submitted' ? 'правка на утверждении' : 'версия ' + показана.version_no}`;

        const тело = $('#diffBody');
        тело.innerHTML = '';
        const части = Diff.diffWords(WorshipDoc.текст(было.doc), WorshipDoc.текст(показана.doc));
        части.forEach(ч => {
            const узел = document.createElement(ч.added ? 'ins' : ч.removed ? 'del' : 'span');
            if (ч.added) узел.className = 'bg-success/20 no-underline';
            if (ч.removed) узел.className = 'bg-error/20 opacity-70';
            узел.textContent = ч.value;
            тело.appendChild(узел);
        });
        if (части.every(ч => !ч.added && !ч.removed)) {
            тело.textContent = 'Текст не изменился — поправили только заголовок или раздел.';
        }
        $('#diffModal').showModal();
    }

    async function дополнитьСнимками() {
        снимки = await WorshipDoc.ссылкиНаСнимки(Layout.db, показана?.doc);
    }

    function рисоватьТекст() {
        const тело = $('#body');
        тело.innerHTML = '';
        тело.appendChild(WorshipDoc.нарисовать(показана?.doc, снимки));

        const главы = WorshipDoc.заголовки(показана?.doc);
        $('#toc').hidden = главы.length < 2;
        // на компьютере оглавление раскрыто, на телефоне свёрнуто: иначе оно
        // стоит между заголовком статьи и первой строкой текста
        const коробка = $('#tocBox');
        if (коробка) коробка.open = window.matchMedia('(min-width: 1200px)').matches;
        $('#tocList').innerHTML = главы.map(г => `
            <li class="${г.уровень === 3 ? 'ml-3' : ''}">
                <a href="#${г.якорь}" class="link link-hover text-sm opacity-80">${e(г.текст)}</a>
            </li>`).join('');
    }

    function рисоватьЗамечания() {
        const открытые = замечания.filter(з => з.state === 'open');
        const закрытые = замечания.filter(з => з.state !== 'open').slice(0, 5);

        // Самое свежее открытое замечание поднимаем над текстом: человек
        // служит по стандарту, про который отдел уже знает, что там неточность.
        // Внизу страницы, равным весом с историей, он его не увидит.
        const первое = открытые[0];
        $('#openRemark').hidden = !первое;
        if (первое) {
            $('#openRemarkBody').textContent = первое.body;
            const кто = имена[первое.created_by];
            $('#openRemarkWho').textContent = [кто, дата(первое.created_at)].filter(Boolean).join(' · ');
        }

        // в заголовке свёрнутого блока — сколько там всего, чтобы не раскрывать вслепую
        $('#remarksCount').textContent = открытые.length
            ? `${открытые.length} открыто` : (замечания.length ? `${замечания.length} разобрано` : 'нет');

        const имяАвтора = id => имена[id] || '';
        $('#remarks').innerHTML = [...открытые, ...закрытые].map(з => {
            const пометка = з.state === 'accepted'
                ? '<span class="badge badge-sm badge-success">учтено</span>'
                : з.state === 'declined'
                ? '<span class="badge badge-sm">не согласен</span>'
                : '<span class="badge badge-sm badge-warning">открыто</span>';
            const закрыть = з.state === 'open' && можноПисать()
                ? `<div class="flex gap-3 mt-1">
                       <button class="link text-sm" data-remark-ok="${з.id}">Учтено</button>
                       <button class="link text-sm" data-remark-no="${з.id}">Не согласен</button>
                   </div>` : '';
            return `
            <li class="border-b border-base-200 last:border-0 py-3">
                <div class="flex flex-wrap items-baseline gap-2">
                    ${пометка}
                    <span class="text-sm opacity-60">${
                        имяАвтора(з.created_by) ? e(имяАвтора(з.created_by)) + ' · ' : ''}${
                        дата(з.created_at)}</span>
                </div>
                <div class="mt-1">${e(з.body)}</div>
                ${з.close_reason ? `<div class="text-sm opacity-70 mt-1">Ответ: ${e(з.close_reason)}</div>` : ''}
                ${закрыть}
            </li>`;
        }).join('') || '<li class="py-2 text-sm opacity-60">Пока никто ничего не заметил</li>';
    }

    function рисоватьИсторию() {
        const готовые = версии.filter(в => в.status !== 'draft' && в.status !== 'submitted')
                              .sort((a, b) => b.version_no - a.version_no);
        // сколько редакций — видно, не раскрывая блок
        const счётчик = $('#historyCount');
        if (счётчик) {
            счётчик.textContent = готовые.length > 1
                ? Layout.pluralize(готовые.length, {
                    ru: ['редакция', 'редакции', 'редакций'],
                    en: ['version', 'versions'], hi: 'संस्करण' })
                : '';
        }
        $('#history').innerHTML = готовые.map(в => `
            <li class="border-b border-base-200 last:border-0 py-3">
                <div class="flex flex-wrap items-baseline gap-2">
                    <span class="font-semibold">Версия ${в.version_no}</span>
                    ${в.status === 'published' ? '<span class="badge badge-sm badge-success">сейчас</span>' : ''}
                    <span class="text-sm opacity-60">${дата(в.approved_at)}</span>
                </div>
                <div class="text-sm opacity-60">${
                    имена[в.created_by] ? 'написал ' + e(имена[в.created_by]) : ''}${
                    имена[в.approved_by] ? ' · утвердил ' + e(имена[в.approved_by]) : ''}</div>
                ${в.change_note ? `<div class="text-sm mt-1">«${e(в.change_note)}»</div>` : ''}
                <div class="flex gap-3 mt-1">
                    <button class="link text-sm" data-show="${в.id}">Открыть</button>
                    ${в.status !== 'published' && можноПисать() && статья.status !== 'archived'
                        ? `<button class="link text-sm" data-restore="${в.id}">Вернуть эту версию</button>` : ''}
                </div>
            </li>`).join('') || '<li class="py-3 text-sm opacity-60">Утверждённых версий ещё нет</li>';
    }

    /** Теги и соседи по ним: словарь общий, поэтому «есть ещё» честное. */
    async function рисоватьТеги() {
        await WorshipTags.нарисовать(
            document.querySelector('#теги'), { article_id: id }, { можноПравить: можноПисать() });

        const { статьи, наборы } = await WorshipTags.соседи({ article_id: id });
        const блок = document.querySelector('#соседи');
        if (!статьи.length && !наборы.length) { блок.innerHTML = ''; return; }

        блок.innerHTML = `
            <div class="text-sm opacity-60 mb-1">По этим тегам есть ещё:</div>
            <ul class="list-none m-0 p-0 flex flex-wrap gap-x-4 gap-y-1">
                ${статьи.map(а => `<li><a class="link text-sm" href="${
                    а.kind === 'material' ? 'material' : 'article'}.html?id=${а.id}">${e(а.title)}</a></li>`).join('')}
                ${наборы.map(н => `<li><a class="link text-sm" href="album.html?id=${н.id}">${
                    e(н.title)} (фото)</a></li>`).join('')}
            </ul>`;
    }

    function рисовать() {
        рисоватьШапку();
        рисоватьДействия();
        рисоватьТекст();
        рисоватьЗамечания();
        рисоватьИсторию();
        window.applyPermissions?.();
        рисоватьТеги();
        восстановитьПрокрутку();
    }

    // ---------- память прокрутки ----------
    // Возвращаем на прежнее место только при «назад» и перезагрузке: открыв
    // статью из списка, человек ждёт начала, а не середины вчерашнего чтения.
    const ключПрокрутки = () => `srsk_worship_scroll_${id}`;
    function восстановитьПрокрутку() {
        const как = performance.getEntriesByType('navigation')[0]?.type;
        if (как !== 'back_forward' && как !== 'reload') return;
        try {
            const y = Number(sessionStorage.getItem(ключПрокрутки()));
            if (y > 0) setTimeout(() => scrollTo({ top: y }), 50);
        } catch { /* приватный режим */ }
    }
    addEventListener('scroll', Layout.debounce(() => {
        try { sessionStorage.setItem(ключПрокрутки(), String(scrollY)); } catch { /* приватный режим */ }
    }, 300));

    // ---------- действия ----------
    /**
     * Окно для связного текста: замечание, причина возврата, ответ на замечание.
     * Возвращает введённое либо null, если человек передумал.
     */
    function спроситьТекст({ заголовок, подсказка, кнопка = 'Отправить', обязательно = true }) {
        return new Promise(готово => {
            const окно = $('#textModal');
            $('#textTitle').textContent = заголовок;
            $('#textHint').textContent = подсказка || '';
            $('#textBody').value = '';
            $('#textGo').textContent = кнопка;

            const отправить = () => {
                const текст = $('#textBody').value.trim();
                if (обязательно && !текст) { $('#textBody').focus(); return; }
                убрать();
                окно.close();
                готово(текст);
            };
            const закрыть = () => { убрать(); готово(null); };
            const убрать = () => {
                $('#textGo').removeEventListener('click', отправить);
                окно.removeEventListener('close', закрыть);
            };

            $('#textGo').addEventListener('click', отправить);
            окно.addEventListener('close', закрыть, { once: true });
            окно.showModal();
            setTimeout(() => $('#textBody').focus(), 50);
        });
    }

    async function открытьАрхивацию() {
        const { data } = await Layout.db.from('worship_articles')
            .select('id, title').eq('kind', 'standard').eq('status', 'published')
            .neq('id', статья.id).order('title');
        $('#archiveReplacement').innerHTML = '<option value="">Ничем — просто отменяем</option>' +
            (data || []).map(с => `<option value="${с.id}">${e(с.title)}</option>`).join('');
        $('#archiveReason').value = '';
        $('#archiveModal').showModal();
    }

    let закладкаВРаботе = false;

    async function переключитьЗакладку() {
        const я = window.currentUser?.id;
        if (!я || закладкаВРаботе) return;   // второй клик подряд давал ошибку вместо закладки
        закладкаВРаботе = true;
        const запрос = вЗакладках
            ? Layout.db.from('worship_bookmarks').delete()
                .eq('kind', 'bookmark').eq('article_id', id).eq('user_id', я)
            : Layout.db.from('worship_bookmarks')
                .insert({ user_id: я, kind: 'bookmark', article_id: id });
        const { error } = await запрос;
        закладкаВРаботе = false;
        if (error) return Layout.handleError(error, 'Закладка');
        вЗакладках = !вЗакладках;
        рисоватьДействия();
        Layout.showNotification(вЗакладках ? 'В закладках' : 'Убрано из закладок', 'success');
    }

    async function перечитать() {
        if (!await загрузить()) return;
        await дополнитьСнимками();
        рисовать();
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const показать = ev.target.closest('[data-show]');
            if (показать) {
                показана = версии.find(в => в.id === показать.dataset.show);
                await дополнитьСнимками();
                рисоватьШапку(); рисоватьДействия(); рисоватьТекст();
                scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }
            const вернуть = ev.target.closest('[data-restore]');
            if (вернуть) {
                const в = версии.find(x => x.id === вернуть.dataset.restore);
                if (!confirm(`Вернуть версию ${в.version_no}? Она станет черновиком и пройдёт утверждение заново.`)) return;
                const { error } = await Layout.db.rpc('worship_restore_version', { p_version: в.id });
                if (error) return Layout.handleError(error, 'Возврат версии');
                Layout.showNotification('Версия скопирована в черновик', 'success');
                return перечитать();
            }

            const учтено = ev.target.closest('[data-remark-ok]');
            const несогласие = ev.target.closest('[data-remark-no]');
            if (учтено || несогласие) {
                const id = (учтено || несогласие).dataset.remarkOk
                        || (учтено || несогласие).dataset.remarkNo;
                const причина = await спроситьТекст(несогласие
                    ? { заголовок: 'Не согласен', кнопка: 'Закрыть замечание',
                        подсказка: 'Почему? Автор замечания это увидит.' }
                    : { заголовок: 'Учтено', кнопка: 'Закрыть замечание', обязательно: false,
                        подсказка: 'Можно коротко ответить — или просто закрыть.' });
                if (причина === null) return;             // передумали
                const { error } = await Layout.db.rpc('worship_remark_close', {
                    p_remark: id, p_state: несогласие ? 'declined' : 'accepted', p_reason: причина });
                if (error) return Layout.handleError(error, 'Замечание');
                return перечитать();
            }

            const b = ev.target.closest('button');
            if (!b) return;

            if (b.id === 'addRemark') {
                const текст = await спроситьТекст({
                    заголовок: 'Что не так?',
                    подсказка: 'Одной-двумя фразами. Уйдёт автору последней версии и старшему.',
                });
                if (!текст) return;
                const { error } = await Layout.db.rpc('worship_remark_add',
                    { p_article: статья.id, p_body: текст });
                if (error) return Layout.handleError(error, 'Замечание');
                Layout.showNotification('Замечание отправлено', 'success');
                return перечитать();
            }

            if (b.id === 'bookmark') return переключитьЗакладку();
            if (b.id === 'print') return print();
            if (b.id === 'diff') return показатьСравнение();

            if (b.id === 'approve') {
                if (!confirm('Утвердить? С этого момента по этому тексту служат в храме.')) return;
                const { data, error } = await Layout.db.rpc('worship_approve', { p_article: статья.id });
                if (error) return Layout.handleError(error, 'Утверждение');
                if (data?.отозвана) {
                    Layout.showNotification(data.сообщение || 'Правку отозвали', 'warning');
                    return перечитать();
                }
                Layout.showNotification(data?.повтор ? 'Уже утверждено' : `Утверждено, версия ${data?.номер}`, 'success');
                return перечитать();
            }
            if (b.id === 'return') {
                const причина = await спроситьТекст({
                    заголовок: 'Вернуть автору',
                    подсказка: 'Что поправить? Автор увидит это над текстом, когда откроет правку.',
                    кнопка: 'Вернуть',
                });
                if (!причина) return;
                const { error } = await Layout.db.rpc('worship_return', { p_article: статья.id, p_reason: причина });
                if (error) return Layout.handleError(error, 'Возврат автору');
                Layout.showNotification('Возвращено автору', 'success');
                return перечитать();
            }
            if (b.id === 'withdraw') {
                const { error } = await Layout.db.rpc('worship_withdraw', { p_article: статья.id });
                if (error) return Layout.handleError(error, 'Отзыв правки');
                Layout.showNotification('Правка снова у вас в черновиках', 'success');
                return перечитать();
            }
            if (b.id === 'archiveBlocked') {
                Layout.showNotification(
                    'Сначала решите по правке: утвердите её или верните автору', 'info');
                return;
            }
            if (b.id === 'archive') return открытьАрхивацию();
            if (b.id === 'archiveGo') {
                const причина = $('#archiveReason').value.trim();
                if (!причина) {
                    Layout.showNotification('Без причины отмену не понять через полгода', 'warning');
                    return $('#archiveReason').focus();
                }
                const { error } = await Layout.db.rpc('worship_archive', {
                    p_article: статья.id, p_reason: причина,
                    p_replaced_by: $('#archiveReplacement').value || null });
                if (error) return Layout.handleError(error, 'Архивация');
                $('#archiveModal').close();
                Layout.showNotification('Стандарт отменён', 'success');
                return перечитать();
            }
            if (b.id === 'unarchive') {
                if (!confirm(заменено
                        ? `Вернуть в действие? Сейчас вместо него действует «${заменено.title}», и два стандарта станут противоречить друг другу.`
                        : 'Вернуть стандарт в действие?')) return;
                const { error } = await Layout.db.rpc('worship_unarchive', { p_article: статья.id });
                if (error) return Layout.handleError(error, 'Возврат из архива');
                Layout.showNotification('Стандарт снова действует', 'success');
                return перечитать();
            }
        });
    }

    /** Ссылка из чата может вести в никуда: статью удалили или прав не хватило. */
    function пусто(сообщение) {
        document.querySelector('main').innerHTML = `
            <div class="card bg-base-100 shadow max-w-xl">
                <div class="card-body items-start">
                    <h1 class="card-title text-xl">${e(сообщение)}</h1>
                    <p class="text-sm opacity-70">Возможно, статью отменили и удалили,
                        либо ссылка ведёт на чужой черновик.</p>
                    <a href="standards.html" class="btn btn-sm mt-2"
                       style="background: var(--current-color); color:#fff;">К списку стандартов</a>
                </div>
            </div>`;
    }

    async function init() {
        слушать();
        if (!await загрузить()) {
            пусто(id ? 'Статья не найдена' : 'Статья не указана');
            return;
        }
        await дополнитьСнимками();
        рисовать();
        // «недавно открытое» ведётся функцией: она же подрезает список до семи строк.
        // .then обязателен: запрос supabase-js ленивый и без него не уходит вовсе
        Layout.db.rpc('worship_touch_recent', { p_article: id })
            .then(({ error }) => { if (error) console.debug('недавнее:', error.message); });
    }

    return { init };
})();
