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
        if (открытая === 'submitted') {
            return '<span class="badge badge-sm badge-warning ml-2 align-middle">на утверждении</span>';
        }
        if (статья.status === 'draft') {
            return '<span class="badge badge-sm ml-2 align-middle">черновик</span>';
        }
        if (открытая === 'draft') {
            return '<span class="badge badge-sm badge-ghost ml-2 align-middle">есть правка</span>';
        }
        return '';
    }

    function подходит(статья) {
        if (!фильтр.архив && статья.status === 'archived') return false;
        if (фильтр.архив && статья.status !== 'archived') return false;
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
        // порядок внутри раздела задаётся руками: иначе сверху оказывается
        // «Если пуджари опоздал», а основная статья тонет ниже
        const ручки = можноПисать() && вид === 'sections' && !фильтр.поиск
            ? `<span class="flex gap-1 shrink-0">
                   <button class="btn btn-ghost btn-xs" data-двигать="-1" data-id="${статья.id}" title="Выше">↑</button>
                   <button class="btn btn-ghost btn-xs" data-двигать="1" data-id="${статья.id}" title="Ниже">↓</button>
               </span>` : '';
        return `
        <li class="border-b border-base-200 last:border-0 flex items-center gap-1 pr-3">
            <a href="article.html?id=${статья.id}"
               class="flex flex-col desktop:flex-row desktop:items-center gap-1 desktop:gap-3
                      px-5 py-3 flex-1 min-w-0 hover:bg-base-200/60 transition-colors">
                <span class="flex-1 min-w-0 font-semibold">${e(статья.title)}${значок(статья)}${где(статья)}</span>
                <span class="text-sm opacity-60 whitespace-nowrap">${
                    статья.status === 'published' && статья.версия
                        ? `версия ${статья.версия} · ${DateUtils.formatShort(new Date(статья.утверждена))}`
                        : DateUtils.formatShort(new Date(статья.updated_at))}</span>
            </a>
            ${ручки}
        </li>`;
    }

    function рисоватьОчередь() {
        const блок = $('#queue');
        if (!можноУтверждать() || !очередь.length) { блок.hidden = true; return; }
        блок.hidden = false;
        $('#queueCount').textContent = очередь.length;
        $('#queueList').innerHTML = очередь.map(в => {
            const статья = статьи.find(с => с.id === в.article_id);
            return `
            <div class="flex flex-col desktop:flex-row desktop:items-center gap-3 bg-base-100 border border-base-300 rounded-lg px-4 py-3">
                <input type="checkbox" class="checkbox checkbox-sm self-start desktop:self-center"
                       data-очередь="${в.article_id}">
                <a href="article.html?id=${в.article_id}" class="flex-1 min-w-0">
                    <span class="font-semibold block">${e(в.title || статья?.title || 'Без названия')}</span>
                    <span class="text-sm opacity-60">${
                        в.change_note ? '«' + e(в.change_note) + '» · ' : ''}${
                        DateUtils.formatShort(new Date(в.updated_at))}</span>
                </a>
                <a href="article.html?id=${в.article_id}" class="btn btn-sm self-start"
                   style="background: var(--current-color); color: #fff;">Открыть</a>
            </div>`;
        }).join('');
        обновитьОтмеченные();
    }

    function рисоватьЗамечания() {
        const блок = $('#remarksBox');
        if (!можноПисать() || !замечания.length) { блок.hidden = true; return; }
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
        if (!confirm(`Утвердить ${список.length} шт.? По ним сразу начнут служить, отделу уйдёт одно сообщение.`)) return;

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
            return;
        }

        if (вид === 'flat') {
            // от самых давних к свежим и только действующее: этот список нужен,
            // чтобы увидеть, что давно не пересматривали, а не «что нового»
            const порядок = видимые
                .filter(с => фильтр.архив || (с.status === 'published' && с.утверждена))
                .sort((a, b) => new Date(a.утверждена || a.updated_at) - new Date(b.утверждена || b.updated_at));
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><ul class="list-none m-0 p-0">
                    ${порядок.map(строкаСтатьи).join('') ||
                      '<li class="px-5 py-8 text-center opacity-60">Ничего не нашлось</li>'}
                </ul></div>`;
            return;
        }

        const безРаздела = видимые.filter(с => !с.section_id);
        тело.innerHTML = разделы.map(р => {
            const свои = видимые.filter(с => с.section_id === р.id);
            // при поиске и в архиве пустые разделы только мешают считать
            if (!свои.length && (фильтр.поиск || фильтр.архив)) return '';
            return `
            <div class="card bg-base-100 shadow mb-4">
                <div class="px-5 pt-4 pb-2 flex flex-wrap items-center gap-3">
                    <h2 class="card-title text-lg">${e(Layout.getName(р))}</h2>
                    <span class="text-sm opacity-50">${свои.length}</span>
                    ${р.is_active ? '' : '<span class="badge badge-sm">скрыт</span>'}
                </div>
                <ul class="list-none m-0 p-0">
                    ${свои.map(строкаСтатьи).join('') ||
                      '<li class="px-5 pb-4 text-sm opacity-60">Пока пусто</li>'}
                </ul>
            </div>`;
        }).join('') + (безРаздела.length ? `
            <div class="card bg-base-100 shadow mb-4">
                <div class="px-5 pt-4 pb-2"><h2 class="card-title text-lg opacity-70">Без раздела</h2></div>
                <ul class="list-none m-0 p-0">${безРаздела.map(строкаСтатьи).join('')}</ul>
            </div>` : '');
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
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисоватьСписок(); });
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
            const двигать = ev.target.closest('[data-двигать]');
            if (двигать) {
                const { error } = await Layout.db.rpc('worship_reorder', {
                    p_article: двигать.dataset.id, p_direction: Number(двигать.dataset.двигать) });
                if (error) return Layout.handleError(error, 'Порядок статей');
                if (await загрузить() && await дополнитьВерсиями()) рисовать();
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
            </li>`;
        }).join('') || '<li class="py-2 text-sm opacity-60">Разделов пока нет</li>';
    }

    async function правитьРаздел(действие, id) {
        const р = разделы.find(x => x.id === id);
        if (!р) return;
        let правка = null;

        if (действие === 'имя') {
            const имя = prompt('Название раздела', Layout.getName(р));
            if (имя === null || !имя.trim()) return;
            правка = { name_ru: имя.trim() };
        } else if (действие === 'видимость') {
            // раздел с содержимым не удаляется: его статьи остались бы без дома
            правка = { is_active: !р.is_active };
        } else {
            const шаг = действие === 'вверх' ? -1 : 1;
            const сосед = разделы[разделы.indexOf(р) + шаг];
            if (!сосед) return;
            // порядковые номера раздаём заново: по умолчанию они нулевые у всех
            const номера = разделы.map((_, i) => i);
            const свой = разделы.indexOf(р), чужой = разделы.indexOf(сосед);
            const пары = разделы.map((x, i) => ({
                id: x.id,
                sort_order: i === свой ? номера[чужой] : i === чужой ? номера[свой] : номера[i],
            }));
            for (const пара of пары) {
                const { error } = await Layout.db.from('worship_sections')
                    .update({ sort_order: пара.sort_order, updated_at: new Date().toISOString() })
                    .eq('id', пара.id);
                if (error) return Layout.handleError(error, 'Порядок разделов');
            }
            if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
            return;
        }

        const { error } = await Layout.db.from('worship_sections')
            .update({ ...правка, updated_at: new Date().toISOString(),
                      updated_by: window.currentUser?.id || null })
            .eq('id', id);
        if (error) return Layout.handleError(error, 'Раздел');
        if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
    }

    async function создатьРаздел(имя) {
        const название = (имя ?? prompt('Название раздела, например «Арати»') ?? '').trim();
        if (!название) return;
        const { error } = await Layout.db.from('worship_sections').insert({
            name_ru: название,
            sort_order: разделы.length,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Создание раздела');
        if (await загрузить() && await дополнитьВерсиями()) { рисовать(); рисоватьРазделыВОкне(); }
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        if (!await дополнитьВерсиями()) return;
        рисовать();
    }

    return { init };
})();
