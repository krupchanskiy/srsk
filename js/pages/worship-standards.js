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

    let разделы = [], статьи = [], очередь = [];
    let вид = 'sections';           // sections | flat
    let фильтр = { поиск: '', архив: false };

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('worship_sections')
                .select('id, name_ru, name_en, name_hi, sort_order, is_active')
                .eq('kind', 'standard').order('sort_order'),
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
        return !q || (статья.title || '').toLowerCase().includes(q);
    }

    function строкаСтатьи(статья) {
        return `
        <li class="border-b border-base-200 last:border-0">
            <a href="article.html?id=${статья.id}"
               class="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-base-200/60 transition-colors">
                <span class="flex-1 min-w-0 font-semibold">${e(статья.title)}${значок(статья)}</span>
                <span class="text-sm opacity-60 whitespace-nowrap">${
                    статья.status === 'published' && статья.версия
                        ? `версия ${статья.версия} · ${DateUtils.formatShort(new Date(статья.утверждена))}`
                        : DateUtils.formatShort(new Date(статья.updated_at))}</span>
            </a>
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
            <a href="article.html?id=${в.article_id}"
               class="flex flex-col desktop:flex-row desktop:items-center gap-3 bg-base-100 border border-base-300 rounded-lg px-4 py-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold block">${e(в.title || статья?.title || 'Без названия')}</span>
                    <span class="text-sm opacity-60">${
                        в.change_note ? '«' + e(в.change_note) + '» · ' : ''}${
                        DateUtils.formatShort(new Date(в.updated_at))}</span>
                </span>
                <span class="btn btn-sm self-start" style="background: var(--current-color); color: #fff;">Открыть</span>
            </a>`;
        }).join('');
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
            const порядок = [...видимые].sort((a, b) =>
                new Date(b.утверждена || b.updated_at) - new Date(a.утверждена || a.updated_at));
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
            if (!свои.length && фильтр.поиск) return '';
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
        рисоватьСписок();
        // права на разметке, нарисованной после загрузки: статические элементы
        // auth-check обрабатывает сам, динамические — только этим вызовом
        window.applyPermissions?.();
    }

    // ---------- данные для показа ----------
    async function дополнитьВерсиями() {
        const ids = статьи.map(с => с.id);
        if (!ids.length) return true;
        const { data, error } = await Layout.db.from('worship_versions')
            .select('article_id, status, version_no, approved_at')
            .in('article_id', ids);
        if (error) { Layout.handleError(error, 'Версии статей'); return false; }

        const поСтатье = {};
        (data || []).forEach(в => {
            поСтатье[в.article_id] = поСтатье[в.article_id] || {};
            if (в.status === 'published') {
                поСтатье[в.article_id].версия = в.version_no;
                поСтатье[в.article_id].утверждена = в.approved_at;
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
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисоватьСписок(); });
        $('#showArchive').addEventListener('change', ev => { фильтр.архив = ev.target.checked; рисоватьСписок(); });

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
            if (ev.target.closest('#newSection')) return создатьРаздел();
            if (ev.target.closest('#newArticle')) {
                location.href = 'edit.html';
            }
        });
    }

    async function создатьРаздел() {
        const имя = prompt('Название раздела, например «Арати»');
        if (!имя || !имя.trim()) return;
        const { error } = await Layout.db.from('worship_sections').insert({
            name_ru: имя.trim(),
            sort_order: разделы.length,
            created_by: window.currentUser?.id || null,
        });
        if (error) return Layout.handleError(error, 'Создание раздела');
        if (await загрузить() && await дополнитьВерсиями()) рисовать();
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        if (!await дополнитьВерсиями()) return;
        рисовать();
    }

    return { init };
})();
