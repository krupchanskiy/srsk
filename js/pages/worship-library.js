/**
 * Библиотека: книги, сканы, записи и заметки отдела.
 *
 * Разведена со стандартами нарочно: стандарт обязывает, материал помогает.
 * Поэтому здесь нет ни утверждения, ни версий на виду — материал действует
 * сразу, а «убрать лишнее» означает архив: на материал могли сослаться
 * из стандарта, и исчезнуть молча он не должен.
 */
const WorshipLibrary = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const дата = v => v ? DateUtils.formatShort(new Date(v)) : '';

    const можноПисать = () => !!window.hasPermission?.('worship_write');

    let разделы = [], материалы = [], вложения = {};
    let фильтр = { поиск: new URLSearchParams(location.search).get('q') || '', вид: '', архив: false };

    async function загрузить() {
        const [р, м] = await Promise.all([
            Layout.db.from('worship_sections')
                .select('id, name_ru, name_en, name_hi, sort_order, is_active')
                .eq('kind', 'library').order('sort_order').order('name_ru'),
            Layout.db.from('worship_articles')
                .select('id, section_id, title, summary, status, updated_at, source, author_name')
                .eq('kind', 'material').order('title'),
        ]);
        if (р.error || м.error) { Layout.handleError(р.error || м.error, 'Загрузка библиотеки'); return false; }
        разделы = р.data || [];
        материалы = м.data || [];

        вложения = {};
        if (материалы.length) {
            // порциями: PostgREST отдаёт не больше тысячи строк за раз, и у части
            // материалов иначе пропали бы значки «файл» и «ссылка».
            // Без фильтра по списку id: вложения бывают только у материалов,
            // а лишнее отсекает RLS. Список из трёхсот id в адресе запроса
            // упирался в предел длины URL, и библиотека переставала грузиться.
            const { data, error } = await Utils.fetchAll((от, до) =>
                Layout.db.from('worship_attachments')
                    .select('id, article_id, kind, name, url, storage_path, size_bytes, mime')
                    .order('sort_order').order('id').range(от, до));
            if (error) { Layout.handleError(error, 'Вложения'); return false; }
            (data || []).forEach(в => {
                вложения[в.article_id] = вложения[в.article_id] || [];
                вложения[в.article_id].push(в);
            });
        }
        return true;
    }

    /** Вид материала виден по тому, чем он является, а не по отдельному полю. */
    function вид(м) {
        const свои = вложения[м.id] || [];
        if (свои.some(в => в.kind === 'file')) return 'file';
        if (свои.some(в => в.kind === 'link')) return 'link';
        return 'text';
    }

    // Вид материала узнаётся значком: в списке из сорока записей подпись
    // «файл» у каждой второй строки не помогает, а рисунок читается сразу.
    const СТРЕЛКА = 'stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
    const ЗНАЧКИ = {
        file: {
            имя: 'файл или скан', цвет: 'badge-ghost',
            рисунок: `<svg width="18" height="18" viewBox="0 0 24 24" ${СТРЕЛКА} class="opacity-70">
                <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11l1.5 2.5H19A1.5 1.5 0 0 1 20.5 8v10.5A1.5 1.5 0 0 1 19 20H5.5A1.5 1.5 0 0 1 4 18.5Z"></path>
                <path d="M8 12h8M8 15.5h5"></path></svg>`,
        },
        link: {
            имя: 'ссылка наружу', цвет: 'badge-ghost',
            рисунок: `<svg width="18" height="18" viewBox="0 0 24 24" ${СТРЕЛКА} class="opacity-70">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5"></path>
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"></path></svg>`,
        },
        text: {
            имя: 'заметка', цвет: 'badge-ghost',
            рисунок: `<svg width="18" height="18" viewBox="0 0 24 24" ${СТРЕЛКА} class="opacity-70">
                <path d="M5 4h14v16l-7-3-7 3Z"></path><path d="M9 9h6M9 12.5h4"></path></svg>`,
        },
    };

    function подходит(м) {
        if (!фильтр.архив && м.status === 'archived') return false;
        if (фильтр.вид && вид(м) !== фильтр.вид) return false;
        const q = фильтр.поиск.trim().toLowerCase();
        if (!q) return true;
        return (м.title || '').toLowerCase().includes(q)
            || (м.summary || '').toLowerCase().includes(q)
            || (м.author_name || '').toLowerCase().includes(q);
    }

    function строка(м) {
        const в = вид(м);
        const свои = вложения[м.id] || [];
        // «4 файла» раньше включало ссылки на ютуб: человек ждал четыре скана,
        // а находил один файл и три адреса
        const файлов = свои.filter(п => п.kind !== 'link').length;
        const ссылок = свои.length - файлов;

        const чем = [];
        if (файлов) чем.push(Layout.pluralize(файлов, {
            ru: ['файл', 'файла', 'файлов'], en: ['file', 'files'], hi: 'फ़ाइल' }));
        if (ссылок) чем.push(Layout.pluralize(ссылок, {
            ru: ['ссылка', 'ссылки', 'ссылок'], en: ['link', 'links'], hi: 'लिंक' }));

        return `
        <li class="border-b border-base-200 last:border-0">
            <a href="material.html?id=${м.id}"
               class="flex items-start gap-3 px-4 py-3 hover:bg-base-200/60 transition-colors">
                <!-- значок вида: книгу от записи и заметки отличают взглядом,
                     а не чтением подписи -->
                <span class="shrink-0 w-9 h-9 rounded-lg bg-base-200 flex items-center justify-center"
                      title="${e(ЗНАЧКИ[в].имя)}">${ЗНАЧКИ[в].рисунок || ''}</span>

                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${e(м.title)}</span>
                    ${м.status === 'archived'
                        ? '<span class="badge badge-sm ml-2 align-middle">в архиве</span>' : ''}
                    ${м.summary ? `<span class="block text-sm opacity-70 mt-0.5">${e(м.summary)}</span>` : ''}
                    <span class="block text-sm opacity-70 mt-0.5">${
                        [м.author_name && e(м.author_name), чем.join(' · '), дата(м.updated_at)]
                            .filter(Boolean).join(' · ')}</span>
                </span>
            </a>
        </li>`;
    }

    function рисовать() {
        const видимые = материалы.filter(подходит);
        const тело = $('#list');

        if (!материалы.length) {
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><div class="card-body items-start">
                    <h2 class="card-title text-lg">Библиотека пока пуста</h2>
                    <p class="text-sm opacity-70 max-w-lg">Сюда кладут то, что помогает разобраться:
                        книги и сканы, свои заметки, ссылки на лекции, записи, которых больше нигде нет.
                        Утверждать материалы не нужно — они действуют сразу.</p>
                    ${можноПисать()
                        ? '<a href="material.html" class="btn btn-sm mt-2" style="background: var(--current-color); color:#fff;">Добавить первый материал</a>'
                        : ''}
                </div></div>`;
            return;
        }

        const безРаздела = видимые.filter(м => !м.section_id);
        // Заголовок — шапка той же карточки, как на странице стандартов:
        // отдельной строкой над списком он читался как подпись к соседу сверху
        const разделHTML = (имя, свои, раздел) => `
            <section class="разделСписка mb-3 rounded-xl shadow-sm overflow-hidden"
                     style="background: oklch(var(--b1));">
                <div class="flex flex-wrap items-center gap-3 px-5 py-3"
                     style="background: color-mix(in srgb, var(--current-color) 9%, transparent);">
                    <h2 class="text-base font-bold uppercase tracking-wide ${
                        раздел ? '' : 'opacity-70'}">${e(имя)}</h2>
                    <span class="text-sm opacity-70">${свои.length}</span>
                    ${раздел && !раздел.is_active ? '<span class="badge badge-sm">скрыт</span>' : ''}
                    <span class="flex-1"></span>
                    ${раздел && можноПисать()
                        ? `<a href="material.html?section=${раздел.id}"
                              class="btn btn-ghost btn-xs ручкиСтроки">+ материал</a>` : ''}
                </div>
                <ul class="list-none m-0 p-0 border-t"
                    style="border-color: color-mix(in srgb, var(--current-color) 18%, transparent);">
                    ${свои.map(строка).join('') ||
                      '<li class="px-5 py-4 text-sm opacity-70">Пока пусто</li>'}
                </ul>
            </section>`;

        тело.innerHTML = разделы.map(р => {
            const свои = видимые.filter(м => м.section_id === р.id);
            if (!свои.length && (фильтр.поиск || фильтр.вид)) return '';
            return разделHTML(Layout.getName(р), свои, р);
        }).join('') + (безРаздела.length
            ? разделHTML('Без раздела', безРаздела, null) : '');

        if (!видимые.length) {
            тело.innerHTML = фильтр.поиск || фильтр.вид
                ? `<div class="bg-base-100 rounded-xl shadow-sm p-8 text-center">
                       <div class="font-semibold mb-1">Ничего не нашлось</div>
                       <div class="text-sm opacity-70">Поиск идёт по названию, описанию и автору.
                           Попробуйте короче — «виласа» вместо «Хари-бхакти-виласа».</div>
                   </div>`
                : `<div class="bg-base-100 rounded-xl shadow-sm p-8 text-center">
                       <div class="font-semibold mb-1">Библиотека пока пуста</div>
                       <div class="text-sm opacity-70 max-w-md mx-auto">Сюда кладут книги, сканы, записи
                           лекций и заметки — всё, что помогает разобраться, но ничего не предписывает.
                           В отличие от стандарта, материал не проходит утверждение.</div>
                       ${можноПисать()
                           ? '<a href="material.html" class="btn btn-sm mt-3" style="background: var(--current-color); color:#fff;">Добавить первый материал</a>'
                           : ''}
                   </div>`;
        }
        window.applyPermissions?.();
    }

    // ---------- разделы библиотеки ----------
    function рисоватьРазделыВОкне() {
        $('#sectionsList').innerHTML = разделы.map((р, i) => {
            const сколько = материалы.filter(м => м.section_id === р.id).length;
            return `
            <li class="flex flex-wrap items-center gap-2 border-b border-base-200 last:border-0 py-2">
                <span class="flex-1 min-w-40 ${р.is_active ? '' : 'opacity-50'}">
                    ${e(Layout.getName(р))} <span class="text-sm opacity-50">· ${сколько}</span>
                    ${р.is_active ? '' : '<span class="badge badge-sm ml-1">скрыт</span>'}
                </span>
                <button class="btn btn-ghost btn-xs" data-раздел="вверх" data-id="${р.id}"
                        ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-ghost btn-xs" data-раздел="вниз" data-id="${р.id}"
                        ${i === разделы.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-ghost btn-xs" data-раздел="имя" data-id="${р.id}">Переименовать</button>
                <button class="btn btn-ghost btn-xs" data-раздел="видимость" data-id="${р.id}">${
                    р.is_active ? 'Скрыть' : 'Вернуть'}</button>
                ${сколько === 0
                    ? `<button class="btn btn-ghost btn-xs text-error" data-раздел="убрать" data-id="${р.id}">Удалить</button>` : ''}
            </li>`;
        }).join('') || '<li class="py-2 text-sm opacity-60">Разделов пока нет</li>';
    }

    function повтор(имя, кромеId) {
        const есть = разделы.some(р => р.id !== кромеId &&
            (р.name_ru || '').trim().toLowerCase() === имя.trim().toLowerCase());
        if (есть) Layout.showNotification('Раздел с таким названием уже есть', 'warning');
        return есть;
    }

    async function правитьРаздел(действие, id) {
        const р = разделы.find(x => x.id === id);
        if (!р) return;

        if (действие === 'имя') {
            const имя = await спроситьСтроку({
                заголовок: 'Название раздела', значение: Layout.getName(р) });
            if (имя === null || повтор(имя, id)) return;
            await применить({ name_ru: имя.trim() }, id);
        } else if (действие === 'видимость') {
            await применить({ is_active: !р.is_active }, id);
        } else if (действие === 'убрать') {
            if (!await спросить(`Удалить раздел «${Layout.getName(р)}»?`,
                'В нём нет материалов, восстанавливать будет нечего.')) return;
            const { error } = await Layout.db.rpc('worship_section_delete', { p_section: id });
            if (error) return Layout.handleError(error, 'Удаление раздела');
            await перечитать();
        } else {
            const { error } = await Layout.db.rpc('worship_section_reorder',
                { p_section: id, p_direction: действие === 'вверх' ? -1 : 1 });
            if (error) return Layout.handleError(error, 'Порядок разделов');
            await перечитать();
        }
    }

    async function применить(правка, id) {
        // отказ политики — это ноль строк, а не ошибка: без .select() раздел
        // «сохраняется» на экране и остаётся прежним в базе
        const { data, error } = await Layout.db.from('worship_sections')
            .update({ ...правка, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', id).select('id');
        if (!error && !data?.length) {
            Layout.showNotification('Не сохранилось: разделы ведёт старший пуджари', 'error');
            return;
        }
        if (error) return Layout.handleError(error, 'Раздел');
        await перечитать();
    }

    async function создатьРаздел(имя) {
        const название = (имя ?? '').trim();
        if (!название || повтор(название, null)) return;
        const { error } = await Layout.db.from('worship_sections').insert({
            kind: 'library',
            name_ru: название,
            sort_order: разделы.length,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Создание раздела');
        await перечитать();
    }

    async function перечитать() {
        if (await загрузить()) { рисовать(); рисоватьРазделыВОкне(); }
    }

    // ---------- события ----------
    function слушать() {
        if (фильтр.поиск) $('#q').value = фильтр.поиск;
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисовать(); });
        $('#вид').addEventListener('change', ev => { фильтр.вид = ev.target.value; рисовать(); });
        $('#showArchive').addEventListener('change', ev => { фильтр.архив = ev.target.checked; рисовать(); });

        document.addEventListener('click', ev => {
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
            if (ev.target.closest('#newMaterial')) location.href = 'material.html';
        });
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        рисовать();
    }

    return { init };
})();
