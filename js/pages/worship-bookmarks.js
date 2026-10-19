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

    async function загрузить() {
        const { data, error } = await Layout.db.from('worship_bookmarks')
            .select('id, kind, article_id, created_at')
            .order('created_at', { ascending: false });
        if (error) { Layout.handleError(error, 'Закладки'); return false; }

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
        return true;
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
                ? `<button class="btn btn-ghost btn-xs ручкиСтроки shrink-0" data-убрать="${з.article_id}"
                           title="Убрать из закладок" aria-label="Убрать из закладок">✕</button>` : ''}
        </li>`;
    }

    function рисовать() {
        const живые = закладки.filter(з => статьи[з.article_id]);

        $('#список').innerHTML = живые.map(з => строка(з, true)).join('') || `
            <li class="px-5 py-8 text-center">
                <div class="font-semibold mb-1">Закладок пока нет</div>
                <div class="text-sm opacity-70 max-w-md mx-auto">Открывая стандарт или материал,
                    нажмите звёздочку в шапке — он появится здесь. Список личный:
                    у каждого в отделе свой.</div>
            </li>`;

        const свежие = недавние.filter(з => статьи[з.article_id]);
        $('#недавнееБлок').hidden = !свежие.length;
        $('#недавнее').innerHTML = свежие.map(з => строка(з, false)).join('');
    }

    async function убрать(articleId) {
        const я = window.currentUser?.id;
        if (!я) return;
        const { error } = await Layout.db.from('worship_bookmarks').delete()
            .eq('kind', 'bookmark').eq('article_id', articleId).eq('user_id', я);
        if (error) return Layout.handleError(error, 'Закладка');
        закладки = закладки.filter(з => з.article_id !== articleId);
        рисовать();
        Layout.showNotification('Убрано из закладок', 'success');
    }

    async function init() {
        document.addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-убрать]');
            if (кнопка) убрать(кнопка.dataset.убрать);
        });

        if (!await загрузить()) return;
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
