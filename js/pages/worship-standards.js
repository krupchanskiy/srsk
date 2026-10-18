/**
 * Стандарты: разделы со статьями и плоский список.
 *
 * Поиск стоит выше оглавления не для красоты: отдел заходит сюда за конкретной
 * статьёй, а не разглядывать структуру. По той же причине очередь «ждут решения»
 * висит над разделами — это единственное место, где работа ждёт конкретного
 * человека, и пролистывать до неё нельзя.
 */
const WorshipStandards = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const $ = s => document.querySelector(s);

    const ПОРОГ_СВОРАЧИВАНИЯ = 20;       // столько статей список держит развёрнутым
    const КЛЮЧ_РАЗДЕЛОВ = 'worship_sections_collapsed';
    const КЛЮЧ_СОРТИРОВКИ = 'worship_standards_sort';

    // Порядок статей раньше переставляли стрелками вручную. На десятке
    // статей это работало, на полутора сотнях — работа, которую никто
    // не станет делать, и список молча зарастает случайным порядком
    let сортировка = (() => {
        try { return localStorage.getItem(КЛЮЧ_СОРТИРОВКИ) || 'имя'; } catch { return 'имя'; }
    })();

    const когдаМенялась = с => new Date(с.утверждена || с.updated_at).getTime() || 0;

    const поПорядку = список => [...список].sort((a, b) => сортировка === 'дата'
        ? когдаМенялась(b) - когдаМенялась(a)
        : (a.title || '').localeCompare(b.title || '', 'ru'));

    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

    let разделы = [], статьи = [], очередь = [], замечания = [];
    let вид = 'sections';           // sections | flat
    // запрос с главной приходит в адресе: два разных поиска в модуле ни к чему
    let фильтр = { поиск: new URLSearchParams(location.search).get('q') || '', архив: false };

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('worship_sections')
                .select('id, name_ru, name_en, name_hi, sort_order, is_active')
                .eq('kind', 'standard').order('sort_order').order('name_ru'),
            Layout.db.from('worship_articles')
                .select('id, section_id, title, status, sort_order, updated_at, current_version_id')
                .eq('kind', 'standard').order('sort_order'),
        ]);
        if (ответы.some(о => о.error)) {
            Layout.handleError(ответы.find(о => о.error).error, 'Загрузка стандартов');
            return false;
        }
        разделы = ответы[0].data || [];
        статьи = ответы[1].data || [];

        // очередь — это версии, а не статьи: правка действующего стандарта ждёт
        // решения, пока сама статья продолжает действовать
        if (можноУтверждать()) {
            const { data, error } = await Layout.db.from('worship_versions')
                .select('id, article_id, title, change_note, updated_at, created_by')
                .eq('status', 'submitted').order('updated_at');
            if (error) { Layout.handleError(error, 'Очередь на утверждение'); return false; }
            очередь = data || [];
        }

        // замечания — вторая стопка работы отдела, и смотрит её любой пуджари,
        // а не только тот, кто утверждает
        if (можноПисать()) {
            const зам = await Layout.db.from('worship_remarks')
                .select('id, article_id, body, created_at')
                .eq('state', 'open').order('created_at');
            if (зам.error) { Layout.handleError(зам.error, 'Замечания'); return false; }
            замечания = зам.data || [];
        }
        return true;
    }

    // ---------- отрисовка ----------
    function значок(статья) {
        const открытая = статья.открытаяВерсия;
        if (статья.status === 'archived') {
            return '<span class="badge badge-sm ml-2 align-middle">не действует</span>';
        }
        if (статья.status === 'draft') {
            // статьи ещё нет в храме: ждёт решения она сама
            return открытая === 'submitted'
                ? '<span class="badge badge-sm badge-warning ml-2 align-middle">на утверждении</span>'
                : '<span class="badge badge-sm ml-2 align-middle">черновик</span>';
        }
        if (открытая === 'submitted') {
            // статья действует, решения ждёт только правка к ней
            return '<span class="badge badge-sm badge-warning ml-2 align-middle">есть правка</span>';
        }
        if (открытая === 'draft') {
            return '<span class="badge badge-sm badge-ghost ml-2 align-middle">есть черновик</span>';
        }
        return '';
    }

    /** Человек ищет — значит, он уже не в режиме обзора. */
    const ищем = () => !!фильтр.поиск.trim();

    function подходит(статья) {
        // галочка добавляет отменённые к выдаче, а не заменяет ею: окно архивации
        // обещает, что отменённый стандарт «останется доступным в поиске»
        if (!фильтр.архив && статья.status === 'archived') return false;
        const q = фильтр.поиск.trim().toLowerCase();
        if (!q) return true;
        // ищем и по тексту: «как делается одевание» — это слова изнутри статьи,
        // а не её заголовок. Настоящий поиск с морфологией придёт третьим этапом
        return (статья.title || '').toLowerCase().includes(q)
            || (статья.текст || '').toLowerCase().includes(q);
    }

    /** Кусок текста вокруг найденного: иначе непонятно, почему статья в выдаче. */
    function где(статья) {
        const q = фильтр.поиск.trim().toLowerCase();
        if (!q || (статья.title || '').toLowerCase().includes(q)) return '';
        const текст = статья.текст || '';
        const i = текст.toLowerCase().indexOf(q);
        if (i < 0) return '';
        const от = Math.max(0, i - 40), до = Math.min(текст.length, i + q.length + 60);
        return `<span class="block text-sm opacity-60 mt-0.5">${
            от > 0 ? '…' : ''}${e(текст.slice(от, до))}${до < текст.length ? '…' : ''}</span>`;
    }

    function строкаСтатьи(статья) {
        return `
        <li class="строкаСписка border-b border-base-200 last:border-0 flex items-center gap-1 pr-3">
            <a href="article.html?id=${статья.id}"
               class="flex flex-col desktop:flex-row desktop:items-center gap-1 desktop:gap-3
                      px-5 py-3 flex-1 min-w-0 hover:bg-base-200/60 transition-colors">
                <span class="flex-1 min-w-0 font-semibold">${e(статья.title)}${значок(статья)}${где(статья)}</span>
                <span class="text-sm opacity-60 whitespace-nowrap">${
                    статья.status === 'published' && статья.версия
                        ? `версия ${статья.версия} · ${DateUtils.formatShort(new Date(статья.утверждена))}`
                        : DateUtils.formatShort(new Date(статья.updated_at))}</span>
            </a>
        </li>`;
    }

    function рисоватьОчередь() {
        const блок = $('#queue');
        // во время поиска стопки работы сверху отодвигают выдачу за край
        // экрана: человек печатает и не видит, что нашлось
        if (!можноУтверждать() || !очередь.length || ищем()) { блок.hidden = true; return; }
        блок.hidden = false;
        $('#queueCount').textContent = очередь.length;
        $('#queueList').innerHTML = очередь.map(в => {
            const статья = статьи.find(с => с.id === в.article_id);
            return `
            <div class="flex flex-col desktop:flex-row desktop:items-center gap-3 bg-base-100 border border-base-300 rounded-lg px-4 py-3">
                <input type="checkbox" class="checkbox self-start desktop:self-center"
                       data-очередь="${в.article_id}">
                <a href="article.html?id=${в.article_id}&v=${в.id}" class="flex-1 min-w-0">
                    <span class="font-semibold block">${e(в.title || статья?.title || 'Без названия')}</span>
                    <span class="text-sm opacity-60">${
                        в.change_note ? '«' + e(в.change_note) + '» · ' : ''}${
                        DateUtils.formatShort(new Date(в.updated_at))}</span>
                </a>
                <a href="article.html?id=${в.article_id}&v=${в.id}" class="btn btn-sm self-start"
                   style="background: var(--current-color); color: #fff;">Открыть</a>
            </div>`;
        }).join('');
        обновитьОтмеченные();
    }

    function рисоватьЗамечания() {
        const блок = $('#remarksBox');
        if (!можноПисать() || !замечания.length || ищем()) { блок.hidden = true; return; }
        блок.hidden = false;
        $('#remarksCount').textContent = замечания.length;
        $('#remarksList').innerHTML = замечания.map(з => {
            const статья = статьи.find(с => с.id === з.article_id);
            return `
            <a href="article.html?id=${з.article_id}"
               class="block border border-base-300 rounded-lg px-4 py-3 hover:bg-base-200/60 transition-colors">
                <span class="font-semibold block">${e(статья?.title || 'Статья')}</span>
                <span class="text-sm opacity-70">${e(з.body)}</span>
            </a>`;
        }).join('');
    }

    function отмеченные() {
        return [...document.querySelectorAll('[data-очередь]:checked')].map(ч => ч.dataset.очередь);
    }

    function обновитьОтмеченные() {
        const сколько = отмеченные().length;
        const кнопка = $('#approveMany');
        if (!кнопка) return;
        кнопка.disabled = !сколько;
        кнопка.textContent = сколько ? `Утвердить отмеченные (${сколько})` : 'Утвердить отмеченные';
    }

    async function утвердитьОтмеченные() {
        const список = отмеченные();
        if (!список.length) return;
        if (!await спросить(
            `Утвердить ${Layout.pluralize(список.length, {
                ru: ['правку', 'правки', 'правок'], en: ['edit', 'edits'], hi: 'संपादन' })}?`,
            'По ним сразу начнут служить. Отделу уйдёт одно сообщение.')) return;

        const { data, error } = await Layout.db.rpc('worship_approve_many', { p_articles: список });
        if (error) return Layout.handleError(error, 'Утверждение');

        // повтор — не утверждение: иначе отчёт говорит «утверждено пять»,
        // когда на деле прошли две, а три уже действовали
        const строки = data?.строки || [];
        const плохие = строки.filter(с => !с.ok);
        const повторы = строки.filter(с => с.ok && с.повтор);
        const свежие = строки.length - плохие.length - повторы.length;
        const хвост = [
            повторы.length ? `${повторы.length} уже действовали` : '',
            плохие.length ? `${плохие.length} не прошли: ${плохие[0].ошибка}` : '',
        ].filter(Boolean).join(', ');
        Layout.showNotification(
            `Утверждено: ${свежие}${хвост ? ' · ' + хвост : ''}`,
            плохие.length ? 'warning' : 'success');

        if (await загрузить() && await дополнитьВерсиями()) рисовать();
    }

    function рисоватьСписок() {
        const видимые = статьи.filter(подходит);
        const тело = $('#list');
        рисоватьИтогПоиска(видимые.length);

        if (!разделы.length && !статьи.length) {
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><div class="card-body items-start">
                    <h2 class="card-title text-lg">Разделов пока нет</h2>
                    <p class="text-sm opacity-70 max-w-lg">Разделы создаёт старший пуджари:
                        «Арати», «Одевание», «Бхога», «Праздники». Внутри них живут статьи.</p>
                    ${можноУтверждать()
                        ? '<button class="btn btn-sm mt-2" id="newSection" style="background: var(--current-color); color:#fff;">Создать первый раздел</button>'
                        : ''}
                </div></div>`;
            расставитьСостояния();
            return;
        }

        if (вид === 'flat') {
            // сплошной список: разделы не мешают, порядок общий для страницы
            const порядок = поПорядку(видимые
                .filter(с => с.status === 'published' && с.утверждена
                          || (фильтр.архив && с.status === 'archived')));
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><ul class="list-none m-0 p-0">
                    ${порядок.map(строкаСтатьи).join('') ||
                      `<li class="px-5 py-8 text-center opacity-60">${
                        фильтр.поиск ? 'Ничего не нашлось' : 'Утверждённых стандартов пока нет'}</li>`}
                </ul></div>`;
            расставитьСостояния();
            return;
        }

        const безРаздела = видимые.filter(с => !с.section_id);
        // Пока статей десяток, свёрнутый список — лишний щелчок. Когда их
        // станет полторы сотни, развёрнутые разделы превращаются в ленту,
        // по которой до нужного раздела надо прокручивать экран за экраном
        const сворачивать = видимые.length > ПОРОГ_СВОРАЧИВАНИЯ || разделы.length > 6;

        тело.innerHTML = разделы.map(р => {
            const свои = видимые.filter(с => с.section_id === р.id);
            // при поиске и в архиве пустые разделы только мешают считать
            if (!свои.length && фильтр.поиск) return '';
            return разделHTML(р.id, Layout.getName(р), поПорядку(свои), сворачивать, р);
        }).join('') + (безРаздела.length
            ? разделHTML('без-раздела', 'Без раздела', поПорядку(безРаздела), сворачивать, null) : '');

        расставитьСостояния();
    }

    /** Раздел списка: заголовок со счётчиком и сворачиваемое содержимое. */
    function разделHTML(id, имя, свои, сворачивать, раздел) {
        const открыт = ищем() || !(сохранённые()[id] ?? сворачивать) ? ' open' : '';
        // Заголовок — шапка той же карточки, а не отдельная строка над ней:
        // когда он висел сам по себе, свёрнутый раздел читался как подпись
        // к списку соседа сверху.
        // «+ статья» стоит рядом со свёрткой, а не внутри <summary>: заголовок
        // свёртки сам кнопка, и ссылка в нём — вложенный интерактивный
        // элемент, который экранный диктор читает как одну неясную кнопку
        return `
        <div class="обёрткаРаздела relative mb-3">
        <details class="разделСписка rounded-xl shadow-sm overflow-hidden"
                 style="background: oklch(var(--b1));"
                 data-раздел-ключ="${e(id)}"${открыт}>
            <summary class="flex flex-wrap items-center gap-2 px-5 py-3 cursor-pointer select-none pr-28"
                     style="background: color-mix(in srgb, var(--current-color) 9%, transparent);">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2.5" stroke-linecap="round" aria-hidden="true"
                     class="details-chevron transition-transform opacity-60">
                    <path d="M6 9l6 6 6-6"></path>
                </svg>
                <h2 class="text-base font-bold uppercase tracking-wide ${раздел ? '' : 'opacity-70'}">${e(имя)}</h2>
                <span class="text-sm opacity-70">${свои.length}</span>
                ${раздел && !раздел.is_active ? '<span class="badge badge-sm">скрыт</span>' : ''}
            </summary>
            <ul class="list-none m-0 p-0 border-t"
                style="border-color: color-mix(in srgb, var(--current-color) 18%, transparent);">
                ${свои.map(строкаСтатьи).join('') ||
                  '<li class="px-5 py-4 text-sm opacity-70">Пока пусто</li>'}
            </ul>
        </details>
        ${раздел && можноПисать()
            ? `<a href="edit.html?section=${раздел.id}"
                  class="btn btn-ghost btn-xs ручкиСтроки absolute right-3 top-2"
                  title="Новая статья в этом разделе">+ статья</a>` : ''}
        </div>`;
    }

    /**
     * Какие разделы человек открыл или закрыл руками. Без этого раздел,
     * открытый перед уходом в статью, закрывался бы при каждом возврате.
     */
    function сохранённые() {
        try { return JSON.parse(localStorage.getItem(КЛЮЧ_РАЗДЕЛОВ) || '{}'); }
        catch { return {}; }
    }

    function запомнитьРаздел(ключ, свёрнут) {
        try {
            const всё = сохранённые();
            всё[ключ] = свёрнут;
            localStorage.setItem(КЛЮЧ_РАЗДЕЛОВ, JSON.stringify(всё));
        } catch { /* приватный режим — просто не запомним */ }
    }

    /** Кнопка «свернуть всё» имеет смысл, только когда разделов больше одного. */
    function расставитьСостояния() {
        const блоки = [...document.querySelectorAll('[data-раздел-ключ]')];
        const кнопка = $('#свернутьВсё');
        кнопка.hidden = блоки.length < 2 || ищем();
        const всеОткрыты = блоки.every(б => б.open);
        кнопка.textContent = всеОткрыты ? 'Свернуть всё' : 'Развернуть всё';
        кнопка.dataset.действие = всеОткрыты ? 'свернуть' : 'развернуть';
    }

    /** Сколько нашлось и чем это отличается от полного списка. */
    function рисоватьИтогПоиска(сколько) {
        const строка = $('#итогПоиска');
        if (!ищем()) { строка.hidden = true; return; }
        строка.hidden = false;
        строка.innerHTML = `
            <span class="font-semibold">${сколько
                ? Layout.pluralize(сколько, { ru: ['статья', 'статьи', 'статей'],
                    en: ['article', 'articles'], hi: 'लेख' })
                : 'Ничего не нашлось'}</span>
            <span class="opacity-70">по запросу «${e(фильтр.поиск.trim())}»</span>
            <button class="btn btn-ghost btn-xs" id="сброситьПоиск">показать всё</button>`;
    }

    function рисовать() {
        рисоватьОчередь();
        рисоватьЗамечания();
        рисоватьСписок();
        // права на разметке, нарисованной после загрузки: статические элементы
        // auth-check обрабатывает сам, динамические — только этим вызовом
        window.applyPermissions?.();
    }

    // ---------- данные для показа ----------
    async function дополнитьВерсиями() {
        const ids = статьи.map(с => с.id);
        if (!ids.length) return true;

        // по сотне статей за раз: выдача обрезается на тысяче строк, а версий
        // у статьи несколько — иначе значки и номера начнут молча врать
        const строки = [];
        for (let i = 0; i < ids.length; i += 100) {
            const { data, error } = await Layout.db.from('worship_versions')
                .select('article_id, status, version_no, approved_at, plain_text')
                .in('article_id', ids.slice(i, i + 100));
            if (error) { Layout.handleError(error, 'Версии статей'); return false; }
            строки.push(...(data || []));
        }

        const поСтатье = {};
        (строки).forEach(в => {
            поСтатье[в.article_id] = поСтатье[в.article_id] || {};
            if (в.status === 'published') {
                поСтатье[в.article_id].версия = в.version_no;
                поСтатье[в.article_id].утверждена = в.approved_at;
                поСтатье[в.article_id].текст = в.plain_text || '';
            }
            // у неутверждённой статьи действующего текста нет, но искать по ней
            // тоже нужно — берём то, что написано
            if (в.status === 'draft' && !поСтатье[в.article_id].текст) {
                поСтатье[в.article_id].текст = в.plain_text || '';
            }
            if (в.status === 'draft' || в.status === 'submitted') {
                поСтатье[в.article_id].открытаяВерсия = в.status;
            }
        });
        статьи = статьи.map(с => ({ ...с, ...(поСтатье[с.id] || {}) }));
        return true;
    }

    // ---------- события ----------
    function слушать() {
        if (фильтр.поиск) $('#q').value = фильтр.поиск;
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисовать(); });
        // состояние раздела запоминается: toggle не всплывает, слушаем на погружении
        document.addEventListener('toggle', ev => {
            const блок = ev.target.closest?.('[data-раздел-ключ]');
            if (!блок || ищем()) return;
            запомнитьРаздел(блок.dataset.разделКлюч ?? блок.getAttribute('data-раздел-ключ'), !блок.open);
            расставитьСостояния();
        }, true);

        // «+ статья» живёт в заголовке раздела: без этого щелчок по ней
        // заодно сворачивал бы раздел
        document.addEventListener('click', ev => {
            if (ev.target.closest('summary a, summary button')) ev.stopPropagation();
        });

        $('#сортировка').value = сортировка;
        $('#сортировка').addEventListener('change', ev => {
            сортировка = ev.target.value;
            try { localStorage.setItem(КЛЮЧ_СОРТИРОВКИ, сортировка); } catch { /* приватный режим */ }
            рисоватьСписок();
        });

        $('#свернутьВсё').addEventListener('click', () => {
            const развернуть = $('#свернутьВсё').dataset.действие === 'развернуть';
            document.querySelectorAll('[data-раздел-ключ]').forEach(б => {
                б.open = развернуть;
                запомнитьРаздел(б.getAttribute('data-раздел-ключ'), !развернуть);
            });
            расставитьСостояния();
        });

        document.addEventListener('click', ev => {
            if (!ev.target.closest('#сброситьПоиск')) return;
            фильтр.поиск = '';
            $('#q').value = '';
            рисовать();
            $('#q').focus();
        });
        $('#showArchive').addEventListener('change', ev => { фильтр.архив = ev.target.checked; рисоватьСписок(); });
        $('#queueAll').addEventListener('change', ev => {
            document.querySelectorAll('[data-очередь]').forEach(ч => { ч.checked = ev.target.checked; });
            обновитьОтмеченные();
        });

        document.addEventListener('click', async ev => {
            const кнопка = ev.target.closest('[data-view]');
            if (кнопка) {
                вид = кнопка.dataset.view;
                document.querySelectorAll('[data-view]').forEach(б => {
                    const свой = б.dataset.view === вид;
                    б.classList.toggle('btn-active', свой);
                });
                рисоватьСписок();
                return;
            }
            if (ev.target.closest('[data-очередь]')) return обновитьОтмеченные();
            if (ev.target.closest('#approveMany')) return утвердитьОтмеченные();
            const раздел = ev.target.closest('[data-раздел]');
            if (раздел) return правитьРаздел(раздел.dataset.раздел, раздел.dataset.id);
            if (ev.target.closest('#manageSections')) {
                рисоватьРазделыВОкне();
                $('#sectionsModal').showModal();
                return;
            }
            if (ev.target.closest('#addSection')) {
                const поле = $('#newSectionName');
                const имя = поле.value;
                поле.value = '';
                return создатьРаздел(имя);
            }
            if (ev.target.closest('#newSection')) return создатьРаздел();
            if (ev.target.closest('#newArticle')) {
                location.href = 'edit.html';
            }
        });
    }

    // ---------- разделы ----------
    function рисоватьРазделыВОкне() {
        $('#sectionsList').innerHTML = разделы.map((р, i) => {
            const сколько = статьи.filter(с => с.section_id === р.id).length;
            return `
            <li class="flex flex-wrap items-center gap-2 border-b border-base-200 last:border-0 py-2">
                <span class="flex-1 min-w-40 ${р.is_active ? '' : 'opacity-50'}">
                    ${e(Layout.getName(р))}
                    <span class="text-sm opacity-50">· ${сколько}</span>
                    ${р.is_active ? '' : '<span class="badge badge-sm ml-1">скрыт</span>'}
                </span>
                <button class="btn btn-ghost btn-xs" data-раздел="вверх" data-id="${р.id}"
                        ${i === 0 ? 'disabled' : ''} title="Выше">↑</button>
                <button class="btn btn-ghost btn-xs" data-раздел="вниз" data-id="${р.id}"
                        ${i === разделы.length - 1 ? 'disabled' : ''} title="Ниже">↓</button>
                <button class="btn btn-ghost btn-xs" data-раздел="имя" data-id="${р.id}">Переименовать</button>
                <button class="btn btn-ghost btn-xs" data-раздел="видимость" data-id="${р.id}">${
                    р.is_active ? 'Скрыть' : 'Вернуть'}</button>
                ${сколько === 0
                    ? `<button class="btn btn-ghost btn-xs text-error" data-раздел="убрать"
                               data-id="${р.id}">Удалить</button>` : ''}
            </li>`;
        }).join('') || '<li class="py-2 text-sm opacity-60">Разделов пока нет</li>';
    }

    async function правитьРаздел(действие, id) {
        const р = разделы.find(x => x.id === id);
        if (!р) return;
        let правка = null;

        if (действие === 'имя') {
            const имя = await спроситьСтроку({
                заголовок: 'Название раздела', значение: Layout.getName(р) });
            if (имя === null) return;
            if (повтор(имя, р.id)) return;
            правка = { name_ru: имя.trim() };
        } else if (действие === 'видимость') {
            // раздел с содержимым не удаляется: его статьи остались бы без дома
            правка = { is_active: !р.is_active };
        } else if (действие === 'убрать') {
            if (!await спросить(`Удалить раздел «${Layout.getName(р)}»?`,
                'В нём нет статей, восстанавливать будет нечего.')) return;
            const { error } = await Layout.db.rpc('worship_section_delete', { p_section: id });
            if (error) return Layout.handleError(error, 'Удаление раздела');
            if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
            return;
        } else {
            // перестановка идёт одной операцией: построчными запросами сбой
            // на середине оставлял бы разделы перемешанными
            const { error } = await Layout.db.rpc('worship_section_reorder',
                { p_section: id, p_direction: действие === 'вверх' ? -1 : 1 });
            if (error) return Layout.handleError(error, 'Порядок разделов');
            if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
            return;
        }

        // отказ политики — это ноль строк, а не ошибка: без .select() раздел
        // «сохранялся» на экране и оставался прежним в базе
        const { data, error } = await Layout.db.from('worship_sections')
            .update({ ...правка, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', id).select('id');
        if (error) return Layout.handleError(error, 'Раздел');
        if (!data?.length) {
            return Layout.showNotification('Не сохранилось: разделы ведёт старший пуджари', 'error');
        }
        if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
    }

    /** Два «Арати» в списке — верный способ потерять половину статей. */
    function повтор(имя, кромеId) {
        const есть = разделы.some(р => р.id !== кромеId &&
            (р.name_ru || '').trim().toLowerCase() === имя.trim().toLowerCase());
        if (есть) Layout.showNotification('Раздел с таким названием уже есть', 'warning');
        return есть;
    }

    async function создатьРаздел(имя) {
        const название = (имя ?? await спроситьСтроку({
            заголовок: 'Новый раздел',
            подсказка: 'Например: Арати, Одевание, Бхога' }) ?? '').trim();
        if (!название) return;
        if (повтор(название, null)) return;
        const { error } = await Layout.db.from('worship_sections').insert({
            name_ru: название,
            sort_order: разделы.length,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Создание раздела');
        if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
    }

    /** В очереди видно, что утверждать сейчас некому: старший в отъезде. */
    async function старшийВОтъезде() {
        const узел = document.querySelector('#старшийОтъезд');
        if (!узел) return;
        const { data, error } = await Layout.db.rpc('worship_approvers_away');
        if (error || !data?.length) return;
        const кто = data.map(x => x['имя'] +
            (x['по'] ? ` до ${DateUtils.formatShort(DateUtils.parseDate(x['по']))}` : '')).join(', ');
        узел.hidden = false;
        узел.textContent = `В отъезде: ${кто}. Правки в очереди подождут его возвращения.`;
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        if (!await дополнитьВерсиями()) return;
        рисовать();
        await старшийВОтъезде();
    }

    return { init };
})();