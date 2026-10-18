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
    let статья = null, версия = null, разделы = [], вложения = [], блоки = [];
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
        блоки = WorshipDoc.разобрать(версия?.doc).blocks;
        return true;
    }

    // ---------- отрисовка ----------
    function рисоватьШапку() {
        $('#режим').textContent = id ? (статья.title || 'Материал') : 'Новый материал';
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

        const кнопки = [];
        if (можноПисать()) {
            кнопки.push(`<button class="btn btn-sm" id="сохранить"
                style="background: var(--current-color); color:#fff;">Сохранить</button>`);
        }
        if (id && можноУтверждать() && статья.status === 'published') {
            кнопки.push('<button class="btn btn-sm btn-ghost" id="вАрхив">Убрать в архив</button>');
        }
        if (id && можноУтверждать() && статья.status === 'archived') {
            кнопки.push('<button class="btn btn-sm btn-outline" id="изАрхива">Вернуть из архива</button>');
            кнопки.push('<button class="btn btn-sm btn-ghost text-error" id="удалить">Удалить насовсем</button>');
        }
        $('#actions').innerHTML = кнопки.join('');

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

    function полеТекста(значение, классы, подсказка) {
        const поле = document.createElement('div');
        поле.className = классы;
        поле.contentEditable = можноПисать() ? 'true' : 'false';
        поле.dataset.подсказка = подсказка || '';
        поле.dataset.текст = '1';
        const времянка = document.createElement('div');
        времянка.appendChild(WorshipDoc.нарисовать({ blocks: [{ type: 'p', spans: значение }] }));
        const абзац = времянка.firstElementChild;
        while (абзац && абзац.firstChild) поле.appendChild(абзац.firstChild);
        return поле;
    }

    function рисоватьБлоки() {
        const тело = $('#блоки');
        тело.innerHTML = '';
        блоки.forEach((б, i) => {
            const обёртка = document.createElement('div');
            обёртка.className = 'блок group pl-3 -ml-3 py-1';
            обёртка.dataset.i = i;

            if (можноПисать()) {
                const ручки = document.createElement('div');
                ручки.className = 'ручки flex items-center gap-1 mb-1';
                ручки.innerHTML = `
                    <span class="text-[11px] uppercase tracking-widest opacity-40 mr-1">${НАЗВАНИЯ[б.type]}</span>
                    <button class="btn btn-ghost btn-sm px-2" data-действие="вверх">↑</button>
                    <button class="btn btn-ghost btn-sm px-2" data-действие="вниз">↓</button>
                    <button class="btn btn-ghost btn-sm px-2 text-error" data-действие="убрать">✕</button>`;
                обёртка.appendChild(ручки);
            }

            if (б.type === 'ul' || б.type === 'ol') {
                const список = document.createElement(б.type);
                список.className = 'mb-2 pl-6 space-y-1 ' + (б.type === 'ul' ? 'list-disc' : 'list-decimal');
                (б.items.length ? б.items : [[]]).forEach((пункт, j) => {
                    const li = document.createElement('li');
                    const поле = полеТекста(пункт, 'кусок кусок-p', 'Пункт списка');
                    поле.dataset.пункт = j;
                    li.appendChild(поле);
                    список.appendChild(li);
                });
                обёртка.appendChild(список);
                if (можноПисать()) {
                    const добавить = document.createElement('button');
                    добавить.className = 'btn btn-ghost btn-xs opacity-60';
                    добавить.dataset.действие = 'пункт';
                    добавить.textContent = '+ пункт';
                    обёртка.appendChild(добавить);
                }
            } else {
                обёртка.appendChild(полеТекста(б.spans,
                    `кусок кусок-${б.type}` + (б.type === 'note' ? ' bg-base-200 rounded-lg px-4 py-3' : ''),
                    ПОДСКАЗКИ[б.type]));
            }
            тело.appendChild(обёртка);
        });

        if (!блоки.length) {
            тело.innerHTML = '<p class="text-sm opacity-50">Текста нет. ' +
                (можноПисать() ? 'Добавьте абзац кнопкой ниже.' : '') + '</p>';
        }
    }

    // ---------- сбор формы ----------
    function собратьОтрезки(поле) {
        const отрезки = [];
        const обойти = (узел, жирный, адрес) => {
            узел.childNodes.forEach(у => {
                if (у.nodeType === Node.TEXT_NODE) {
                    if (у.nodeValue) отрезки.push({ t: у.nodeValue, b: жирный, href: адрес });
                    return;
                }
                if (у.nodeType !== Node.ELEMENT_NODE) return;
                const имя = у.tagName.toLowerCase();
                if (имя === 'br') { отрезки.push({ t: ' ' }); return; }
                обойти(у, жирный || имя === 'strong' || имя === 'b',
                       адрес || (имя === 'a' ? WorshipDoc.адрес(у.getAttribute('href')) : null));
            });
        };
        обойти(поле, false, null);

        const готовые = [];
        отрезки.forEach(о => {
            const чистый = { t: о.t };
            if (о.b) чистый.b = true;
            if (о.href) чистый.href = о.href;
            const пред = готовые[готовые.length - 1];
            if (пред && !!пред.b === !!чистый.b && пред.href === чистый.href) пред.t += чистый.t;
            else готовые.push(чистый);
        });
        return готовые.filter(о => о.t !== '');
    }

    function собрать() {
        const собранные = [];
        document.querySelectorAll('#блоки .блок').forEach(узел => {
            const б = блоки[Number(узел.dataset.i)];
            if (!б) return;
            if (б.type === 'ul' || б.type === 'ol') {
                собранные.push({ type: б.type,
                                 items: [...узел.querySelectorAll('[data-пункт]')].map(собратьОтрезки) });
            } else {
                собранные.push({ type: б.type,
                                 spans: собратьОтрезки(узел.querySelector('[data-текст]')) });
            }
        });
        блоки = собранные;
        return WorshipDoc.разобрать({ blocks: собранные });
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

        const документ = собрать();
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
        const адрес = prompt('Адрес: ссылка на лекцию, видео или страницу');
        if (!адрес || !адрес.trim()) return;
        if (!/^https?:\/\//i.test(адрес.trim())) {
            return Layout.showNotification('Ссылка должна начинаться с http:// или https://', 'warning');
        }
        const имя = prompt('Как подписать ссылку?', адрес.trim().slice(0, 80));
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
        if (!в || !confirm(`Убрать «${в.name}»?`)) return;

        const { error } = await Layout.db.from('worship_attachments').delete().eq('id', вид);
        if (error) return Layout.handleError(error, 'Удаление вложения');
        // файл в хранилище сам не исчезает: убираем следом
        if (в.storage_path) {
            Layout.db.storage.from('worship').remove([в.storage_path])
                .then(({ error: ош }) => { if (ош) console.debug('файл остался:', ош.message); });
        }
        await перечитать();
    }

    // ---------- блоки текста ----------
    function новыйБлок(тип) {
        return тип === 'ul' || тип === 'ol' ? { type: тип, items: [[]] } : { type: тип, spans: [] };
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
        if (await загрузить()) { рисоватьШапку(); рисоватьВложения(); рисоватьБлоки(); window.applyPermissions?.(); }
    }

    function слушать() {
        const тело = $('#блоки');
        тело.addEventListener('input', пометить);
        тело.addEventListener('paste', ev => {
            if (!ev.target.closest('[data-текст]')) return;
            ev.preventDefault();
            const текст = (ev.clipboardData || window.clipboardData).getData('text/plain');
            document.execCommand('insertText', false, текст.replace(/\s+/g, ' ').trim());
        });
        тело.addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-действие]');
            if (!кнопка) return;
            const i = Number(кнопка.closest('.блок').dataset.i);
            собрать();
            switch (кнопка.dataset.действие) {
                case 'вверх': if (i > 0) [блоки[i - 1], блоки[i]] = [блоки[i], блоки[i - 1]]; break;
                case 'вниз': if (i < блоки.length - 1) [блоки[i + 1], блоки[i]] = [блоки[i], блоки[i + 1]]; break;
                case 'убрать': блоки.splice(i, 1); break;
                case 'пункт': блоки[i].items.push([]); break;
            }
            рисоватьБлоки();
            пометить();
        });

        document.querySelectorAll('[data-добавить]').forEach(б =>
            б.addEventListener('click', () => {
                собрать();
                блоки.push(новыйБлок(б.dataset.добавить));
                рисоватьБлоки();
                пометить();
                document.querySelector(`.блок[data-i="${блоки.length - 1}"] [data-текст]`)?.focus();
            }));

        try { document.execCommand('styleWithCSS', false, false); } catch { /* старый браузер */ }
        $('#жирный').addEventListener('click', () => { document.execCommand('bold'); пометить(); });
        $('#ссылка').addEventListener('click', () => {
            const выделение = getSelection();
            if (!выделение.rangeCount || выделение.isCollapsed) {
                return Layout.showNotification('Выделите слова, которые станут ссылкой', 'info');
            }
            const куда = prompt('Адрес ссылки');
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
                const причина = prompt('Почему убираем материал в архив?');
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
                if (!confirm('Удалить материал насовсем вместе с файлами? Это не отменить.')) return;
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
        рисоватьБлоки();
        слушать();
        window.applyPermissions?.();
        if (id) WorshipTags.нарисовать($('#теги'), { article_id: id }, { можноПравить: можноПисать() });
        состояние('');
    }

    return { init };
})();
