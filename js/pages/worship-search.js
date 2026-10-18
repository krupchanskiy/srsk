/**
 * Поиск по модулю.
 *
 * Один поиск на всё: человек не знает, в каком из хранилищ ответ, он помнит
 * слово. Поэтому выдача сгруппирована по видам — стандарты, материалы,
 * наборы фото, — а не свалена в один список.
 *
 * Ищет функция в базе: полнотекстовый поиск плюс похожесть. «Одеть» находит
 * «одевание», «туласе» находит «Туласи» — на штатном словаре это не работает,
 * проверено на боевой базе и записано в ТЗ.
 */
const WorshipSearch = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');

    const ГРУППЫ = [
        { вид: 'standard', имя: 'Стандарты', куда: id => `article.html?id=${id}` },
        { вид: 'material', имя: 'Библиотека', куда: id => `material.html?id=${id}` },
        { вид: 'album', имя: 'Наборы фото', куда: id => `album.html?id=${id}` },
    ];

    let запрос = new URLSearchParams(location.search).get('q') || '';
    let тег = new URLSearchParams(location.search).get('tag') || '';
    let теги = [], строки = [];

    async function найти() {
        if (!запрос.trim() && !тег) { строки = []; return; }

        if (запрос.trim()) {
            const { data, error } = await Layout.db.rpc('worship_search',
                { p_query: запрос.trim(), p_limit: 60 });
            if (error) { Layout.handleError(error, 'Поиск'); return; }
            строки = data || [];
        } else {
            строки = [];
        }

        // тег — фильтр поверх поиска: он сужает найденное, а при пустом
        // запросе сам становится выдачей
        if (тег) {
            const { data: связи } = await Layout.db.from('worship_tag_links')
                .select('article_id, album_id').eq('tag_id', тег);
            const свои = new Set((связи || []).flatMap(с => [с.article_id, с.album_id].filter(Boolean)));

            if (запрос.trim()) {
                строки = строки.filter(с => свои.has(с.id));
            } else {
                строки = await поТегу([...свои]);
            }
        }
    }

    /** Выдача по одному тегу, без слов: «покажи всё про экадаши». */
    async function поТегу(ids) {
        if (!ids.length) return [];
        const [статьи, наборы] = await Promise.all([
            Layout.db.from('worship_articles')
                .select('id, title, summary, kind, status').in('id', ids),
            Layout.db.from('worship_albums')
                .select('id, title, description, event_date').in('id', ids),
        ]);
        const из = [];
        (статьи.data || []).forEach(а => из.push({
            вид: а.kind === 'material' ? 'material' : 'standard',
            id: а.id, заголовок: а.title, кусок: а.summary || '',
            добавочно: а.status === 'archived' ? 'не действует' : null, вес: 1,
        }));
        (наборы.data || []).forEach(н => из.push({
            вид: 'album', id: н.id, заголовок: н.title, кусок: н.description || '',
            добавочно: DateUtils.formatShort(DateUtils.parseDate(н.event_date)), вес: 1,
        }));
        return из;
    }

    async function загрузитьТеги() {
        const { data } = await Layout.db.from('worship_tags').select('id, name').order('name');
        теги = data || [];
    }

    // ---------- отрисовка ----------
    function рисоватьТеги() {
        if (!теги.length) { $('#теги').innerHTML = ''; return; }
        $('#теги').innerHTML = '<span class="text-sm opacity-60 mr-1">Теги:</span>' +
            теги.map(т => `
                <button class="btn btn-xs ${т.id === тег ? 'btn-active' : 'btn-outline'}"
                        data-тег="${т.id}">${e(т.name)}</button>`).join('') +
            (тег ? '<button class="btn btn-xs btn-ghost" data-тег="">сбросить</button>' : '');
    }

    function рисовать() {
        const тело = $('#итог');

        if (!запрос.trim() && !тег) {
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><div class="card-body items-start">
                    <h2 class="card-title text-lg">Что ищем?</h2>
                    <p class="text-sm opacity-70 max-w-xl">Поиск идёт сразу по стандартам,
                        библиотеке и наборам фотографий: достаточно помнить слово.
                        Однокоренные и опечатки тоже находятся — «одеть» найдёт «одевание».</p>
                </div></div>`;
            return;
        }

        if (!строки.length) {
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><div class="card-body text-center opacity-60">
                    Ничего не нашлось${запрос ? ` по запросу «${e(запрос)}»` : ''}
                </div></div>`;
            return;
        }

        тело.innerHTML = ГРУППЫ.map(г => {
            const свои = строки.filter(с => с.вид === г.вид);
            if (!свои.length) return '';
            return `
            <div class="card bg-base-100 shadow mb-4">
                <div class="px-5 pt-4 pb-2 flex items-center gap-3">
                    <h2 class="card-title text-lg flex-1">${г.имя}</h2>
                    <span class="text-sm opacity-50">${свои.length}</span>
                </div>
                <ul class="list-none m-0 p-0">
                    ${свои.map(с => `
                    <li class="border-b border-base-200 last:border-0">
                        <a href="${г.куда(с.id)}" class="block px-5 py-3 hover:bg-base-200/60 transition-colors">
                            <span class="font-semibold">${e(с.заголовок)}</span>
                            ${с.добавочно ? `<span class="badge badge-sm ml-2 align-middle">${e(с.добавочно)}</span>` : ''}
                            ${с.кусок ? `<span class="block text-sm opacity-70 mt-0.5">${e(с.кусок)}</span>` : ''}
                        </a>
                    </li>`).join('')}
                </ul>
            </div>`;
        }).join('');
    }

    async function обновить() {
        const адрес = new URL(location.href);
        if (запрос.trim()) адрес.searchParams.set('q', запрос.trim()); else адрес.searchParams.delete('q');
        if (тег) адрес.searchParams.set('tag', тег); else адрес.searchParams.delete('tag');
        history.replaceState(null, '', адрес);

        await найти();
        рисоватьТеги();
        рисовать();
    }

    function слушать() {
        $('#q').value = запрос;
        $('#форма').addEventListener('submit', ev => { ev.preventDefault(); обновить(); });
        $('#q').addEventListener('input', Layout.debounce(ev => {
            запрос = ev.target.value;
            обновить();
        }, 400));

        $('#словарь').addEventListener('click', вестиТеги);
        document.addEventListener('click', async ev => {
            if (!ev.target.closest('#вестиТеги')) return;
            await рисоватьСловарь();
            $('#tagsModal').showModal();
        });

        $('#теги').addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-тег]');
            if (!кнопка) return;
            тег = кнопка.dataset.тег === тег ? '' : кнопка.dataset.тег;
            обновить();
        });
    }

    // ---------- словарь тегов ----------
    async function рисоватьСловарь() {
        const { data } = await Layout.db.from('worship_tag_links').select('tag_id');
        const сколько = {};
        (data || []).forEach(с => { сколько[с.tag_id] = (сколько[с.tag_id] || 0) + 1; });

        $('#словарь').innerHTML = теги.map(т => `
            <li class="flex flex-wrap items-center gap-2 border-b border-base-200 last:border-0 py-2">
                <span class="flex-1 min-w-40">${e(т.name)}
                    <span class="text-sm opacity-50">· ${сколько[т.id] || 0}</span></span>
                <button class="btn btn-ghost btn-xs" data-переименовать="${т.id}">Переименовать</button>
                <button class="btn btn-ghost btn-xs" data-слить="${т.id}">Слить с другим</button>
            </li>`).join('') || '<li class="py-2 text-sm opacity-60">Тегов пока нет</li>';
    }

    async function вестиТеги(ev) {
        const переименовать = ev.target.closest('[data-переименовать]');
        if (переименовать) {
            const т = теги.find(x => x.id === переименовать.dataset.переименовать);
            const имя = prompt('Новое название тега', т?.name || '');
            if (имя === null || !имя.trim()) return;
            const { error } = await Layout.db.rpc('worship_tag_rename',
                { p_tag: т.id, p_name: имя });
            if (error) return Layout.handleError(error, 'Переименование тега');
            await загрузитьТеги();
            await рисоватьСловарь();
            рисоватьТеги();
            return;
        }

        const слить = ev.target.closest('[data-слить]');
        if (слить) {
            const откуда = теги.find(x => x.id === слить.dataset.слить);
            const имя = prompt(`Слить «${откуда.name}» с каким тегом? Впишите название.`);
            if (имя === null || !имя.trim()) return;
            const куда = теги.find(т => (т.name || '').trim().toLowerCase() === имя.trim().toLowerCase());
            if (!куда) return Layout.showNotification('Такого тега нет в словаре', 'warning');
            if (куда.id === откуда.id) return Layout.showNotification('Это тот же тег', 'warning');
            if (!confirm(`«${откуда.name}» исчезнет, его объекты получат «${куда.name}». Слить?`)) return;

            const { data, error } = await Layout.db.rpc('worship_tag_merge',
                { p_from: откуда.id, p_into: куда.id });
            if (error) return Layout.handleError(error, 'Слияние тегов');
            Layout.showNotification(`Перенесено связей: ${data?.перенесено ?? 0}`, 'success');
            await загрузитьТеги();
            await рисоватьСловарь();
            await обновить();
        }
    }

    async function init() {
        слушать();
        await загрузитьТеги();
        await обновить();
        window.applyPermissions?.();
        $('#q').focus();
    }

    return { init };
})();
