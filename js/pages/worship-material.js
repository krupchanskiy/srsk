/**
 * Карточка материала библиотеки.
 *
 * Правка и чтение на одном экране: утверждения у материала нет, версия сразу
 * действующая, и разводить «посмотреть» и «поправить» было бы церемонией
 * на пустом месте. Поля заблокированы для тех, кто не пишет.
 *
 * Файл у нас либо ссылка наружу — выбор делается тем, что человек добавил,
 * а не отдельным переключателем «вид материала»: переключатель всегда
 * расходится с содержимым.
 */
const WorshipMaterial = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

    const ПРЕДЕЛ_ФАЙЛА = 200 * 1024 * 1024;

    let id = new URLSearchParams(location.search).get('id');
    let статья = null, версия = null, разделы = [], вложения = [];
    let грязно = false, сохраняется = false;

    const ПОДСКАЗКИ = { p: 'Текст', h2: 'Заголовок', h3: 'Подзаголовок', note: 'Заметка' };
    const НАЗВАНИЯ = { p: 'Абзац', h2: 'Заголовок', h3: 'Подзаголовок',
                       ul: 'Список', ol: 'По шагам', note: 'Заметка' };

    // ---------- загрузка ----------
    async function загрузить() {
        const запросы = [
            Layout.db.from('worship_sections')
                .select('id, name_ru, name_en, name_hi, is_active')
                .eq('kind', 'library').order('sort_order').order('name_ru'),
        ];
        if (id) {
            запросы.push(Layout.db.from('worship_articles').select('*').eq('id', id).maybeSingle());
            запросы.push(Layout.db.from('worship_versions').select('*')
                .eq('article_id', id).eq('status', 'published').maybeSingle());
            запросы.push(Layout.db.from('worship_attachments')
                .select('*').eq('article_id', id).order('sort_order'));
        }
        const ответы = await Promise.all(запросы);
        const плохой = ответы.find(о => о.error);
        if (плохой) { Layout.handleError(плохой.error, 'Загрузка материала'); return false; }

        разделы = ответы[0].data || [];
        if (id) {
            статья = ответы[1].data;
            if (!статья) { Layout.showNotification('Материал не найден', 'warning'); return false; }
            версия = ответы[2].data || null;
            вложения = ответы[3].data || [];
        }
        return true;
    }

    // ---------- отрисовка ----------
    function рисоватьШапку() {
        // в служебной строке — что это за запись, а не её название:
        // название стоит заголовком страницей ниже
        $('#режим').textContent = !id ? 'Новый материал'
            : статья.status === 'archived' ? 'Материал · в архиве'
            : 'Материал библиотеки';
        $('#заголовок').value = статья?.title || '';
        $('#описание').value = статья?.summary || '';
        $('#автор').value = статья?.author_name || '';
        $('#источник').value = статья?.source || '';

        const изАдреса = new URLSearchParams(location.search).get('section');
        const выбран = статья?.section_id || изАдреса || '';
        $('#раздел').innerHTML = '<option value="">Без раздела</option>' + разделы.map(р =>
            `<option value="${р.id}" ${выбран === р.id ? 'selected' : ''}>${
                e(Layout.getName(р))}${р.is_active ? '' : ' (скрыт)'}</option>`).join('');

        ['#заголовок', '#описание', '#автор', '#источник', '#раздел'].forEach(s => {
            $(s).disabled = !можноПисать();
        });

        // «Сохранить» теперь одна — липкая внизу страницы: раньше на экране
        // висели две одинаковые кнопки, и было непонятно, чем они отличаются.
        // Редкие решения о судьбе материала собраны под «ещё».
        const редкие = [];
        if (id && можноУтверждать() && статья.status === 'published') {
            редкие.push('<li><button id="вАрхив">Убрать в архив</button></li>');
        }
        if (id && можноУтверждать() && статья.status === 'archived') {
            редкие.push('<li><button id="изАрхива">Вернуть из архива</button></li>');
            редкие.push('<li><button id="удалить" class="text-error">Удалить насовсем</button></li>');
        }

        $('#actions').innerHTML = редкие.length ? `
            <div class="dropdown dropdown-end">
                <button tabindex="0" class="btn btn-sm btn-ghost px-2" aria-label="Ещё действия">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle>
                        <circle cx="12" cy="19" r="1.7"></circle>
                    </svg>
                </button>
                <ul tabindex="0" class="dropdown-content z-30 menu menu-sm p-2 shadow bg-base-100 rounded-box w-56">
                    ${редкие.join('')}
                </ul>
            </div>` : '';

        if (статья?.status === 'archived') {
            $('#режим').insertAdjacentHTML('beforeend',
                '<span class="badge badge-warning ml-2 align-middle">в архиве</span>');
        }
    }

    function рисоватьВложения() {
        $('#вложения').innerHTML = вложения.map(в => `
            <li class="flex flex-wrap items-center gap-3 border-b border-base-200 last:border-0 py-2">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold block">${e(в.name)}</span>
                    <span class="text-sm opacity-60">${
                        в.kind === 'link' ? e(в.url)
                        : `${(в.size_bytes / 1024 / 1024).toFixed(1)} МБ${в.mime ? ' · ' + e(в.mime) : ''}`}</span>
                </span>
                <button class="btn btn-sm btn-outline" data-открыть="${в.id}">Открыть</button>
                ${можноПисать()
                    ? `<button class="btn btn-sm btn-ghost text-error" data-убрать="${в.id}">Убрать</button>` : ''}
            </li>`).join('') || '<li class="py-2 text-sm opacity-60">Пока ничего не приложено</li>';
    }

    // Текст материала правится тем же редактором, что и стандарт: формат
    // документа один, и два разных редактора на него — ровно та странность,
    // из-за которой интерфейс читается как собранный для неизвестно кого.
    function наполнитьПоле(документ) {
        const т = $('#текст');
        т.replaceChildren();
        т.appendChild(WorshipEditorDoc.вДом(документ || версия?.doc || { blocks: [] }, {}));
    }

    const документИзПоля = () => WorshipDoc.разобрать(WorshipEditorDoc.изДома($('#текст')));

    /** Оформление идёт через execCommand: только так правка попадает
        в историю браузера, то есть работает обычный Ctrl+Z. */
    function команда(имя, значение = null) {
        $('#текст').focus();
        document.execCommand(имя, false, значение);
        пометить();
    }

    function текущийТег() {
        let узел = getSelection()?.anchorNode;
        while (узел && узел !== $('#текст')) {
            if (узел.nodeType === Node.ELEMENT_NODE) {
                const имя = узел.tagName.toLowerCase();
                if (['h1', 'h2', 'h3', 'h4', 'blockquote', 'li', 'p'].includes(имя)) return имя;
            }
            узел = узел.parentNode;
        }
        return 'p';
    }

    function обновитьПанель() {
        const внутри = $('#текст')?.contains(getSelection()?.anchorNode);
        const тег = текущийТег();
        const нажата = (кнопка, условие) => кнопка?.classList.toggle('btn-active', !!(внутри && условие));
        document.querySelectorAll('[data-стиль]').forEach(б => {
            const свой = б.dataset.стиль;
            нажата(б, (свой === 'h2' && (тег === 'h2' || тег === 'h1'))
                   || (свой === 'h3' && (тег === 'h3' || тег === 'h4'))
                   || (свой === 'note' && тег === 'blockquote'));
        });
        try {
            нажата($('#жирный'), document.queryCommandState('bold'));
            нажата($('#список'), document.queryCommandState('insertUnorderedList'));
            нажата($('#поШагам'), document.queryCommandState('insertOrderedList'));
        } catch { /* старый браузер */ }
    }

    /** Повторное нажатие снимает оформление — иначе из заголовка не выбраться. */
    function стиль(какой) {
        const теги = { p: 'P', h2: 'H2', h3: 'H3', note: 'BLOCKQUOTE' };
        const сейчас = текущийТег();
        const снять = (какой === 'h2' && (сейчас === 'h2' || сейчас === 'h1'))
            || (какой === 'h3' && (сейчас === 'h3' || сейчас === 'h4'))
            || (какой === 'note' && сейчас === 'blockquote');
        команда('formatBlock', `<${снять ? 'P' : теги[какой]}>`);
        if (!снять && какой === 'note') {
            const узел = getSelection()?.anchorNode;
            const цитата = (узел?.nodeType === 1 ? узел : узел?.parentElement)?.closest('blockquote');
            цитата?.classList.add('worship-заметка');
        }
        обновитьПанель();
    }

    function пометить() {
        грязно = true;
        состояние('не сохранено', 'text-sm text-warning');
    }

    /** Одно состояние на две кнопки: наверху страницы и в липкой полосе внизу. */
    function состояние(текст, класс = 'text-sm opacity-60') {
        [$('#сохранение'), $('#сохранениеНизу')].forEach(у => {
            if (!у) return;
            у.textContent = текст;
            у.className = класс;
        });
    }

    // ---------- сохранение ----------
    async function сохранить() {
        if (сохраняется) return null;
        const заголовок = $('#заголовок').value.trim();
        const описание = $('#описание').value.trim();
        if (!заголовок) {
            Layout.showNotification('Без названия материал не найти', 'warning');
            return $('#заголовок').focus(), null;
        }
        // описание обязательно: это прямое требование ТЗ, и оно про то,
        // чтобы через полгода библиотека оставалась читаемой
        if (!описание) {
            Layout.showNotification('Напишите одной фразой, о чём материал', 'warning');
            return $('#описание').focus(), null;
        }

        сохраняется = true;
        состояние('сохраняю…');

        const документ = документИзПоля();
        // всё одним вызовом: у worship_articles нет политик записи, и обычный
        // update молча не меняет ни строки — человек видит «сохранено»,
        // а в библиотеке остаётся материал без описания
        const { data, error } = await Layout.db.rpc('worship_save_draft', {
            payload: {
                article_id: id || null,
                kind: 'material',
                section_id: $('#раздел').value || null,
                title: заголовок,
                summary: описание,
                author_name: $('#автор').value.trim(),
                source: $('#источник').value.trim(),
                doc: документ,
                plain_text: WorshipDoc.текст(документ),
                base_known: false,          // версий у материала нет, конфликтовать нечему
            },
        });
        сохраняется = false;

        if (error) {
            состояние('не сохранено', 'text-sm text-error');
            Layout.handleError(error, 'Сохранение');
            return null;
        }

        грязно = false;
        состояние('сохранено', 'text-sm text-success');

        if (!id) {
            id = data.article_id;
            history.replaceState(null, '', `material.html?id=${id}`);
            // перечитываем, а не просто перерисовываем шапку: статья ещё не
            // загружена, и рисоватьШапку() падала на статья.title — а вместе
            // с ней молча обрывалась загрузка приложенных файлов
            await перечитать();
            // теги появляются сразу: раньше блок оставался пустым до перезагрузки
            WorshipTags.нарисовать($('#теги'), { article_id: id }, { можноПравить: true });
        }
        return data;
    }

    // ---------- вложения ----------
    /**
     * Книга сканами — это двадцать файлов, и выбирать их по одному означает
     * двадцать кругов. Грузим пачкой той же очередью, что и снимки в галерее.
     */
    async function загрузитьФайлы(файлы) {
        const слишком = файлы.filter(ф => ф.size > ПРЕДЕЛ_ФАЙЛА);
        if (слишком.length) {
            Layout.showNotification(
                `Больше 200 МБ: ${слишком.map(ф => ф.name).join(', ')}. ` +
                'Видео, которое есть на ютубе, добавьте ссылкой', 'warning');
        }
        const годные = файлы.filter(ф => ф.size <= ПРЕДЕЛ_ФАЙЛА);
        if (!годные.length) return;
        if (!id && !await сохранить()) return;   // файлу нужна карточка, к которой он относится

        $('#ходЗагрузки').hidden = false;
        $('#полоса').removeAttribute('value');

        const итог = await Media.очередь(годные, async файл => {
            const путь = `${window.currentUser?.id}/${crypto.randomUUID()}-${
                файл.name.replace(/[^\w.-]+/g, '_')}`;
            const { error } = await Layout.db.storage.from('worship')
                .upload(путь, файл, { contentType: файл.type || 'application/pdf' });
            if (error) {
                // хранилище принимает конкретный список типов, и его отказ
                // выглядит как «mime type … is not supported» — непонятно
                if (/mime type/i.test(error.message || '')) {
                    throw new Error('такой тип файла библиотека не принимает: ' +
                        'снимки, pdf, аудио и видео — да, остальное нет');
                }
                throw new Error(error.message);
            }

            const { error: ош } = await Layout.db.from('worship_attachments').insert({
                article_id: id, kind: 'file', storage_path: путь, name: файл.name,
                mime: файл.type || null, size_bytes: файл.size,
                sort_order: вложения.length, created_by: window.currentUser?.id || null,
            });
            if (ош) throw new Error(ош.message);
        }, {
            наШаг: ({ номер, всего, файл, состояние, ошибка }) => {
                const большой = файл.size > 20 * 1024 * 1024;
                $('#ходПодпись').textContent = состояние === 'ошибка'
                    ? `${файл.name} — не вышло: ${ошибка}`
                    : `${номер} из ${всего}: ${файл.name}${
                        состояние === 'идёт' && большой ? ' — файл большой, это надолго' : ''}`;
                if (состояние !== 'идёт') $('#полоса').value = Math.round(номер / всего * 100);
            },
        });

        $('#ходЗагрузки').hidden = true;
        await перечитать();
        Layout.showNotification(итог.неудачи.length
            ? `Приложено ${итог.удалось.length}, не вышло ${итог.неудачи.length}`
            : `Приложено файлов: ${итог.удалось.length}`,
            итог.неудачи.length ? 'warning' : 'success');
    }

    async function добавитьСсылку() {
        if (!id && !await сохранить()) return;
        const адрес = await спроситьСтроку({
            заголовок: 'Ссылка на источник',
            подсказка: 'Лекция, видео или страница в сети' });
        if (!адрес || !адрес.trim()) return;
        if (!/^https?:\/\//i.test(адрес.trim())) {
            return Layout.showNotification('Ссылка должна начинаться с http:// или https://', 'warning');
        }
        const имя = await спроситьСтроку({
            заголовок: 'Как подписать ссылку?',
            значение: адрес.trim().slice(0, 80) });
        if (имя === null) return;

        const { error } = await Layout.db.from('worship_attachments').insert({
            article_id: id, kind: 'link', url: адрес.trim(),
            name: имя.trim() || адрес.trim(), sort_order: вложения.length,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Ссылка');
        await перечитать();
    }

    async function открытьВложение(вид) {
        const в = вложения.find(x => x.id === вид);
        if (!в) return;
        if (в.kind === 'link') return window.open(в.url, '_blank', 'noopener');

        // бакет приватный: отдаём ссылку ограниченного срока
        const { data, error } = await Layout.db.storage.from('worship')
            .createSignedUrl(в.storage_path, 300);
        if (error) return Layout.handleError(error, 'Открытие файла');
        window.open(data.signedUrl, '_blank', 'noopener');
    }

    async function убратьВложение(вид) {
        const в = вложения.find(x => x.id === вид);
        if (!в || !await спросить(`Убрать «${в.name}»?`)) return;

        const { error } = await Layout.db.from('worship_attachments').delete().eq('id', вид);
        if (error) return Layout.handleError(error, 'Удаление вложения');
        // файл в хранилище сам не исчезает: убираем следом
        if (в.storage_path) {
            Layout.db.storage.from('worship').remove([в.storage_path])
                .then(({ error: ош }) => { if (ош) console.debug('файл остался:', ош.message); });
        }
        await перечитать();
    }

    /**
     * Перечитывает карточку из базы. Несохранённый текст при этом затёрся бы,
     * поэтому сначала сохраняем — человек приложил скан, а не просил откатить
     * свой абзац.
     */
    async function перечитать({ сохранитьСначала = true } = {}) {
        // несохранённый текст иначе затирается тем, что лежит в базе:
        // человек приложил скан, а абзац, который он только что написал,
        // пропадал без предупреждения
        if (сохранитьСначала && грязно && id) await сохранить();
        if (await загрузить()) { рисоватьШапку(); рисоватьВложения(); наполнитьПоле(); window.applyPermissions?.(); }
    }

    function слушать() {
        const текст = $('#текст');
        текст.addEventListener('input', пометить);
        текст.addEventListener('keyup', обновитьПанель);
        текст.addEventListener('mouseup', обновитьПанель);
        document.addEventListener('selectionchange', () => {
            if ($('#текст')?.contains(getSelection()?.anchorNode)) обновитьПанель();
        });

        // вставка приходит обычным текстом: чужая вёрстка из Word в карточку не едет
        текст.addEventListener('paste', ev => {
            ev.preventDefault();
            const кусок = (ev.clipboardData || window.clipboardData).getData('text/plain');
            команда('insertText', кусок.replace(/\s+/g, ' ').trim());
        });

        document.querySelectorAll('[data-стиль]').forEach(б =>
            б.addEventListener('click', () => стиль(б.dataset.стиль)));
        $('#список')?.addEventListener('click', () => { команда('insertUnorderedList'); обновитьПанель(); });
        $('#поШагам')?.addEventListener('click', () => { команда('insertOrderedList'); обновитьПанель(); });
        $('#откатить')?.addEventListener('click', () => команда('undo'));
        $('#повторить')?.addEventListener('click', () => команда('redo'));

        try { document.execCommand('styleWithCSS', false, false); } catch { /* старый браузер */ }
        $('#жирный').addEventListener('click', () => { document.execCommand('bold'); пометить(); });
        $('#ссылка').addEventListener('click', async () => {
            const выделение = getSelection();
            if (!выделение.rangeCount || выделение.isCollapsed) {
                return Layout.showNotification('Выделите слова, которые станут ссылкой', 'info');
            }
            const куда = await спроситьСтроку({ заголовок: 'Адрес ссылки' });
            const чистый = куда && WorshipDoc.адрес(куда);
            if (!чистый) return куда && Layout.showNotification('Такой адрес не годится', 'warning');
            document.execCommand('createLink', false, чистый);
            пометить();
        });

        ['#заголовок', '#описание', '#автор', '#источник', '#раздел'].forEach(s =>
            $(s).addEventListener('input', пометить));

        $('#файл').addEventListener('change', async ev => {
            const файлы = [...(ev.target.files || [])];
            ev.target.value = '';
            if (файлы.length) await загрузитьФайлы(файлы);
        });

        document.addEventListener('click', async ev => {
            const открыть = ev.target.closest('[data-открыть]');
            if (открыть) return открытьВложение(открыть.dataset.открыть);
            const убрать = ev.target.closest('[data-убрать]');
            if (убрать) return убратьВложение(убрать.dataset.убрать);

            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'сохранить' || b.id === 'сохранитьНизу') return сохранить();
            if (b.id === 'добавитьФайл') return $('#файл').click();
            if (b.id === 'добавитьСсылку') return добавитьСсылку();

            if (b.id === 'вАрхив') {
                const причина = await спроситьСтроку({
                    заголовок: 'Почему убираем в архив?',
                    подсказка: 'Одной строкой — это останется в истории материала',
                    многострочно: true });
                if (!причина || !причина.trim()) return;
                const { error } = await Layout.db.rpc('worship_archive',
                    { p_article: id, p_reason: причина, p_replaced_by: null });
                if (error) return Layout.handleError(error, 'Архив');
                return перечитать();
            }
            if (b.id === 'изАрхива') {
                const { error } = await Layout.db.rpc('worship_unarchive', { p_article: id });
                if (error) return Layout.handleError(error, 'Возврат из архива');
                return перечитать();
            }
            if (b.id === 'удалить') {
                if (!await спросить('Удалить материал насовсем?',
                    'Вместе с приложенными файлами. Это не отменить.')) return;
                const { data, error } = await Layout.db.rpc('worship_material_delete', { p_article: id });
                if (error) return Layout.handleError(error, 'Удаление материала');
                if (data?.файлы?.length) await Layout.db.storage.from('worship').remove(data.файлы);
                Layout.showNotification('Материал удалён', 'success');
                location.href = 'library.html';
            }
        });

        addEventListener('beforeunload', ev => {
            if (!грязно) return;
            ev.preventDefault();
            ev.returnValue = '';
        });
    }

    async function init() {
        if (!await загрузить()) {
            setTimeout(() => location.href = 'library.html', 1500);
            return;
        }
        рисоватьШапку();
        рисоватьВложения();
        наполнитьПоле();
        слушать();
        window.applyPermissions?.();
        if (id) WorshipTags.нарисовать($('#теги'), { article_id: id }, { можноПравить: можноПисать() });
        состояние('');
    }

    return { init };
})();
