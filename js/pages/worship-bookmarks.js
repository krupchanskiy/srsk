/**
 * Закладки.
 *
 * Личный список: у каждого свой, чужих отметок здесь не бывает. Звёздочку
 * ставят в шапке стандарта или материала, а возвращаются к отмеченному
 * отсюда — раньше список жил только тихим блоком в сводке на главной,
 * и его не находили.
 *
 * Рядом — «Недавно открытое»: его система ведёт сама, без звёздочки.
 * Статья, уже лежащая в закладках, из недавнего убирается, иначе один
 * и тот же стандарт стоял бы в двух списках подряд.
 */
const WorshipBookmarks = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');

    const НЕДАВНИХ = 10;

    let закладки = [], недавние = [], статьи = {};
    // избранные снимки: { id, путь, миниатюра, подпись, album_id, папка }
    let снимки = [], ссылки = {};

    async function загрузить() {
        const { data, error } = await Layout.db.from('worship_bookmarks')
            .select('id, kind, article_id, image_id, created_at')
            .order('created_at', { ascending: false });
        if (error) { Layout.handleError(error, 'Избранное'); return false; }

        закладки = (data || []).filter(з => з.kind === 'bookmark' && з.article_id);
        недавние = (data || []).filter(з => з.kind === 'recent' && з.article_id)
            .filter(з => !закладки.some(з2 => з2.article_id === з.article_id))
            .slice(0, НЕДАВНИХ);

        const ids = [...new Set([...закладки, ...недавние].map(з => з.article_id))];
        if (ids.length) {
            // отмеченное могли отменить или удалить: тогда строки в списке
            // просто не будет, а не битая ссылка в никуда
            const { data: ст } = await Layout.db.from('worship_articles')
                .select('id, title, kind, status, summary').in('id', ids);
            статьи = Object.fromEntries((ст || []).map(с => [с.id, с]));
        }
        await загрузитьСнимки((data || []).filter(з => з.kind === 'bookmark' && з.image_id).map(з => з.image_id));
        return true;
    }

    /** Избранные снимки — с папкой и ссылками на миниатюры, в порядке отметки. */
    async function загрузитьСнимки(ids) {
        снимки = [];
        if (!ids.length) return;
        const { data: им } = await Layout.db.from('worship_images')
            .select('id, storage_path, thumb_path, caption, album_id').in('id', ids);
        const папкиIds = [...new Set((им || []).map(и => и.album_id))];
        const { data: па } = папкиIds.length
            ? await Layout.db.from('worship_albums').select('id, title').in('id', папкиIds) : { data: [] };
        const папки = Object.fromEntries((па || []).map(п => [п.id, п.title]));
        const поId = Object.fromEntries((им || []).map(и => [и.id, и]));
        // снимок из закрытой папки или удалённый — просто не показываем
        снимки = ids.map(id => поId[id]).filter(и => и && папки[и.album_id] !== undefined)
            .map(и => ({ ...и, папка: папки[и.album_id] }));
        ссылки = await WorshipLinks.подписать(Layout.db, снимки.map(и => и.thumb_path || и.storage_path));
    }

    function рисоватьСнимки() {
        $('#снимкиБлок').hidden = !снимки.length;
        $('#снимкиСчёт').textContent = снимки.length || '';
        $('#снимкиИзбр').innerHTML = снимки.map((и, i) => `
            <figure class="rounded-xl overflow-hidden bg-base-200">
                <button type="button" class="block w-full aspect-square cursor-zoom-in" data-снимок="${i}"
                        aria-label="${e(и.caption || 'Открыть снимок')}">
                    ${ссылки[и.thumb_path || и.storage_path]
                        ? `<img src="${e(ссылки[и.thumb_path || и.storage_path])}" alt="${e(и.caption)}" loading="lazy"
                                class="w-full h-full object-cover">`
                        : '<span class="text-xs opacity-50 p-2 block">снимок не загрузился</span>'}
                </button>
                <figcaption class="px-2 py-1.5 text-xs leading-snug">
                    ${и.caption ? `<span class="block">${e(и.caption)}</span>` : ''}
                    <a class="link link-hover opacity-70" href="album.html?id=${и.album_id}">${e(и.папка)}</a>
                </figcaption>
            </figure>`).join('');
    }

    /** Просмотр избранных снимков; звёздочкой в нём же снимок убирают. */
    async function смотреть(начало) {
        const оригиналы = await WorshipLinks.подписать(Layout.db, снимки.map(и => и.storage_path));
        const убранные = new Set();
        Media.открыть(снимки.map(и => ({
            id: и.id, адрес: оригиналы[и.storage_path] || ссылки[и.thumb_path || и.storage_path],
            подпись: [и.caption, и.папка].filter(Boolean).join(' · '),
        })), начало, {
            избранное: {
                есть: с => !убранные.has(с.id),
                переключить: async с => {
                    const я = window.currentUser?.id;
                    const убрать = !убранные.has(с.id);
                    const { error } = убрать
                        ? await Layout.db.from('worship_bookmarks').delete()
                            .eq('kind', 'bookmark').eq('image_id', с.id).eq('user_id', я)
                        : await Layout.db.from('worship_bookmarks').insert({ user_id: я, kind: 'bookmark', image_id: с.id });
                    if (error && error.code !== '23505') return Layout.handleError(error, 'Избранное');
                    убрать ? убранные.add(с.id) : убранные.delete(с.id);
                },
            },
            // убранные звёздочкой пропадают из списка, когда просмотр закрыли:
            // посреди листания снимки не должны уезжать из-под пальца
            закрыт: () => {
                снимки = снимки.filter(и => !убранные.has(и.id));
                рисоватьСнимки();
            },
        });
    }

    const куда = с => `${с.kind === 'material' ? 'material' : 'article'}.html?id=${с.id}`;

    function строка(з, сУбиранием) {
        const с = статьи[з.article_id];
        if (!с) return '';
        return `
        <li class="border-b border-base-200 last:border-0 flex items-center gap-2 pr-3">
            <a href="${куда(с)}" class="flex-1 min-w-0 px-5 py-3 hover:bg-base-200/60 transition-colors">
                <span class="font-semibold">${e(с.title)}</span>
                ${с.status === 'archived'
                    ? '<span class="badge badge-sm ml-2">не действует</span>' : ''}
                <span class="block text-sm opacity-70">${
                    с.kind === 'material' ? 'материал библиотеки' : 'стандарт'}${
                    с.summary ? ' · ' + e(с.summary) : ''}</span>
            </a>
            ${сУбиранием
                ? `<button class="btn btn-ghost btn-xs ручкиСтроки shrink-0 цельПальцаКрупно" data-убрать="${з.article_id}"
                           title="Убрать из избранного" aria-label="Убрать из избранного">✕</button>` : ''}
        </li>`;
    }

    function рисовать() {
        const живые = закладки.filter(з => статьи[з.article_id]);

        $('#список').innerHTML = живые.map(з => строка(з, true)).join('') || (снимки.length
            ? '<li class="px-5 py-4 text-sm opacity-70">Стандартов и материалов здесь пока нет — только снимки ниже.</li>'
            : `
            <li class="px-5 py-8 text-center">
                <div class="font-semibold mb-1">В избранном пока пусто</div>
                <div class="text-sm opacity-70 max-w-md mx-auto">Открывая стандарт или материал,
                    нажмите звёздочку в шапке — он появится здесь. Снимок галереи —
                    звёздочкой в просмотре. Список личный: у каждого в отделе свой.</div>
            </li>`);

        рисоватьСнимки();

        const свежие = недавние.filter(з => статьи[з.article_id]);
        $('#недавнееБлок').hidden = !свежие.length;
        $('#недавнее').innerHTML = свежие.map(з => строка(з, false)).join('');
    }

    async function убрать(articleId) {
        const я = window.currentUser?.id;
        if (!я) return;
        const { error } = await Layout.db.from('worship_bookmarks').delete()
            .eq('kind', 'bookmark').eq('article_id', articleId).eq('user_id', я);
        if (error) return Layout.handleError(error, 'Избранное');
        // ✕ легко задеть пальцем: строка остаётся на месте с «Вернуть»,
        // пока страницу не перерисуют
        const строкаСписка = document.querySelector(`[data-убрать="${articleId}"]`)?.closest('li');
        закладки = закладки.filter(з => з.article_id !== articleId);
        if (!строкаСписка) return рисовать();
        строкаСписка.innerHTML = `
            <span class="flex-1 min-w-0 px-5 py-3 opacity-70">«${e(статьи[articleId]?.title)}» убрано из избранного</span>
            <button class="btn btn-ghost btn-sm shrink-0 цельПальцаКрупно" data-вернуть="${articleId}">Вернуть</button>`;
    }

    async function вернуть(articleId, кнопка) {
        const я = window.currentUser?.id;
        if (!я) return;
        кнопка.disabled = true;
        const { error } = await Layout.db.from('worship_bookmarks')
            .insert({ user_id: я, kind: 'bookmark', article_id: articleId });
        if (error) { кнопка.disabled = false; return Layout.handleError(error, 'Избранное'); }
        закладки.unshift({ kind: 'bookmark', article_id: articleId });
        рисовать();
    }

    async function init() {
        document.addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-убрать]');
            if (кнопка) return убрать(кнопка.dataset.убрать);
            const снимок = ev.target.closest('[data-снимок]');
            if (снимок) return смотреть(Number(снимок.dataset.снимок));
            const назад = ev.target.closest('[data-вернуть]');
            if (назад) вернуть(назад.dataset.вернуть, назад);
        });

        if (!await загрузить()) return;
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
