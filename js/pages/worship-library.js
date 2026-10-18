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
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

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
            const ids = материалы.map(м2 => м2.id);
            // порциями: PostgREST отдаёт не больше тысячи строк за раз, и у части
            // материалов иначе пропали бы значки «файл» и «ссылка»
            const { data, error } = await Utils.fetchAll((от, до) =>
                Layout.db.from('worship_attachments')
                    .select('id, article_id, kind, name, url, storage_path, size_bytes, mime')
                    .in('article_id', ids).order('sort_order').range(от, до));
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

    const ЗНАЧКИ = {
        file: { имя: 'файл', цвет: 'badge-ghost' },
        link: { имя: 'ссылка', цвет: 'badge-ghost' },
        text: { имя: 'заметка', цвет: 'badge-ghost' },
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
        const файлов = (вложения[м.id] || []).length;
        return `
        <li class="border-b border-base-200 last:border-0">
            <a href="material.html?id=${м.id}"
               class="flex flex-col desktop:flex-row desktop:items-center gap-1 desktop:gap-3
                      px-5 py-3 hover:bg-base-200/60 transition-colors">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${e(м.title)}</span>
                    <span class="badge badge-sm ${ЗНАЧКИ[в].цвет} ml-2 align-middle">${ЗНАЧКИ[в].имя}</span>
                    ${м.status === 'archived'
                        ? '<span class="badge badge-sm ml-1 align-middle">в архиве</span>' : ''}
                    ${м.summary ? `<span class="block text-sm opacity-70 mt-0.5">${e(м.summary)}</span>` : ''}
                </span>
                <span class="text-sm opacity-60 whitespace-nowrap">${
                    м.author_name ? e(м.author_name) + ' · ' : ''}${
                    файлов > 1 ? Layout.pluralize(файлов, {
                        ru: ['файл', 'файла', 'файлов'],
                        en: ['file', 'files'], hi: 'फ़ाइल' }) + ' · ' : ''}${дата(м.updated_at)}</span>
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
        тело.innerHTML = разделы.map(р => {
            const свои = видимые.filter(м => м.section_id === р.id);
            if (!свои.length && (фильтр.поиск || фильтр.вид)) return '';
            return `
            <div class="card bg-base-100 shadow mb-4">
                <div class="px-5 pt-4 pb-2 flex flex-wrap items-center gap-3">
                    <h2 class="card-title text-lg flex-1 min-w-0">${e(Layout.getName(р))}</h2>
                    <span class="text-sm opacity-50">${свои.length}</span>
                    ${р.is_active ? '' : '<span class="badge badge-sm">скрыт</span>'}
                    ${можноПисать()
                        ? `<a href="material.html?section=${р.id}" class="btn btn-ghost btn-xs">+ материал</a>` : ''}
                </div>
                <ul class="list-none m-0 p-0">
                    ${свои.map(строка).join('') ||
                      '<li class="px-5 pb-4 text-sm opacity-60">Пока пусто</li>'}
                </ul>
            </div>`;
        }).join('') + (безРаздела.length ? `
            <div class="card bg-base-100 shadow mb-4">
                <div class="px-5 pt-4 pb-2"><h2 class="card-title text-lg opacity-70">Без раздела</h2></div>
                <ul class="list-none m-0 p-0">${безРаздела.map(строка).join('')}</ul>
            </div>` : '');

        if (!видимые.length) {
            тело.innerHTML = `<div class="card bg-base-100 shadow"><div class="card-body text-center opacity-60">${
                фильтр.поиск || фильтр.вид ? 'Ничего не нашлось' : 'Материалов пока нет'}</div></div>`;
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
            const имя = prompt('Название раздела', Layout.getName(р));
            if (имя === null || !имя.trim() || повтор(имя, id)) return;
            await применить({ name_ru: имя.trim() }, id);
        } else if (действие === 'видимость') {
            await применить({ is_active: !р.is_active }, id);
        } else if (действие === 'убрать') {
            if (!confirm(`Удалить пустой раздел «${Layout.getName(р)}»?`)) return;
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
