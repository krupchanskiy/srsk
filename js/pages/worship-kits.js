/**
 * Список подборок.
 *
 * Подборки видны и внутри модуля, не только снаружи: приехавший волонтёр
 * открывает «Поклонение» и с главной попадает в ту же дорожку, которую читал
 * дома. Это же ответ на вопрос «с чего начать», который иначе остаётся
 * без экрана.
 */
const WorshipKits = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноПисать = () => !!window.hasPermission?.('worship_write');

    let подборки = [], пунктов = {}, выдач = {};

    async function загрузить() {
        const { data, error } = await Layout.db.from('worship_kits')
            .select('id, title, description, lang, is_active, updated_at')
            .order('title');
        if (error) { Layout.handleError(error, 'Загрузка подборок'); return false; }
        подборки = data || [];

        if (подборки.length) {
            const ids = подборки.map(п => п.id);
            const [и, в] = await Promise.all([
                Layout.db.from('worship_kit_items').select('kit_id, article_id, album_id').in('kit_id', ids),
                можноПисать()
                    ? Layout.db.from('worship_kit_grants')
                        .select('kit_id, vaishnava_id, retreat_id').in('kit_id', ids).is('revoked_at', null)
                    : Promise.resolve({ data: [] }),
            ]);
            // считаем только то, что читают и смотрят: пояснения между
            // пунктами — подводка к ним, а не содержание подборки
            пунктов = {};
            (и.data || []).filter(п => п.article_id || п.album_id)
                .forEach(п => { пунктов[п.kit_id] = (пунктов[п.kit_id] || 0) + 1; });
            // подборку выдают человеку или целому ретриту — считаем порознь
            выдач = {};
            (в.data || []).forEach(г => {
                const к = выдач[г.kit_id] ||= { людям: 0, ретритам: 0 };
                if (г.vaishnava_id) к.людям++; else if (г.retreat_id) к.ретритам++;
            });
        }
        return true;
    }

    /** «выдана 2 людям и 1 ретриту» — кому подборка сейчас открыта в портале. */
    function выдана(в) {
        if (!в || !(в.людям || в.ретритам)) return '';
        const части = [
            в.людям && Layout.pluralize(в.людям, { ru: ['человеку', 'людям', 'людям'], en: ['person', 'people'], hi: 'व्यक्ति' }),
            в.ретритам && Layout.pluralize(в.ретритам, { ru: ['ретриту', 'ретритам', 'ретритам'], en: ['retreat', 'retreats'], hi: 'रिट्रीट' }),
        ].filter(Boolean);
        return `<span class="opacity-70"> · выдана ${части.join(' и ')}</span>`;
    }

    function рисовать() {
        const тело = $('#list');
        if (!подборки.length) {
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><div class="card-body items-start">
                    <h2 class="card-title text-lg">Подборок пока нет</h2>
                    <p class="text-sm opacity-70 max-w-xl">Подборка — это дорожка:
                        два-три стандарта, материал и набор фотографий в нужном порядке,
                        со своими пояснениями между пунктами. Её выдают человеку,
                        и он читает её ещё до приезда.</p>
                    ${можноПисать()
                        ? '<button class="btn btn-sm mt-2" id="newKitEmpty" style="background: var(--current-color); color:#fff;">Собрать первую</button>'
                        : ''}
                </div></div>`;
            return;
        }

        тело.innerHTML = `
            <div class="card bg-base-100 shadow"><ul class="list-none m-0 p-0">
                ${подборки.map(п => `
                <li class="border-b border-base-200 last:border-0">
                    <a href="kit.html?id=${п.id}"
                       class="flex flex-col desktop:flex-row desktop:items-center gap-1 desktop:gap-3
                              px-5 py-3 hover:bg-base-200/60 transition-colors">
                        <span class="flex-1 min-w-0">
                            <span class="font-semibold">${e(п.title)}</span>
                            ${п.lang !== 'ru'
                                ? `<span class="badge badge-sm ml-2" title="Язык подборки">${
                                    e(п.lang === 'en' ? 'на английском' : п.lang)}</span>` : ''}
                            ${п.is_active ? '' : '<span class="badge badge-sm ml-1">отключена</span>'}
                            ${п.description ? `<span class="block text-sm opacity-70 mt-0.5">${e(п.description)}</span>` : ''}
                        </span>
                        <!-- пустая подборка и подборка из десяти пунктов читались
                             одинаково: «0 пунктов» теряется среди цифр. Незаконченную
                             работу видно сразу -->
                        <span class="text-sm whitespace-nowrap ${
                            пунктов[п.id] ? 'opacity-70' : 'text-warning font-semibold'}">
                            ${пунктов[п.id]
                                ? Layout.pluralize(пунктов[п.id], {
                                    ru: ['пункт', 'пункта', 'пунктов'],
                                    en: ['item', 'items'], hi: 'मद' })
                                : 'пока пусто'}
                            ${выдана(выдач[п.id])}
                        </span>
                    </a>
                </li>`).join('')}
            </ul></div>`;
    }

    let создаётся = false;

    async function создать() {
        // двойной щелчок по «Новая подборка» открывал окно дважды
        // и создавал две подборки с одним названием
        if (создаётся) return;
        создаётся = true;
        try { await создатьОдну(); } finally { создаётся = false; }
    }

    async function создатьОдну() {
        const название = await спроситьСтроку({
            заголовок: 'Новая подборка',
            подсказка: 'Для кого она: «Для нового волонтёра», «Перед Гаура-пурнимой»' });
        if (!название) return;
        const { data, error } = await Layout.db.from('worship_kits').insert({
            title: название.trim(),
            created_by: window.currentUser?.id || null,
        }).select('id').maybeSingle();
        if (error) return Layout.handleError(error, 'Создание подборки');
        if (!data) return Layout.showNotification('Не сохранилось: подборки собирает пуджари', 'error');
        location.href = `kit.html?id=${data.id}`;
    }

    async function init() {
        document.addEventListener('click', ev => {
            if (ev.target.closest('#newKit') || ev.target.closest('#newKitEmpty')) создать();
        });
        if (!await загрузить()) return;
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
