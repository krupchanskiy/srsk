/**
 * Главная модуля.
 *
 * Почти каждое обращение к отделу — это «как это делается», а не «покажи
 * оглавление». Поэтому первым стоит поиск во всю ширину, а не список разделов.
 * Ниже — то, что ждёт конкретного человека: очередь у старшего, черновики
 * у пуджари, лента изменений у всех.
 *
 * Блоки расписания появятся вторым этапом; пустых заглушек под них здесь нет —
 * страница показывает только то, что уже работает.
 */
const WorshipHome = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const дата = v => v ? DateUtils.formatShort(new Date(v)) : '';

    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

    let разделы = [], статьи = [];

    /** `подпись` — уже готовая разметка: собирают её вызывающие, экранируя текст. */
    function строка(id, заголовок, подписьHTML) {
        return `
        <li class="border-b border-base-200 last:border-0">
            <a href="article.html?id=${id}" class="block py-2.5 hover:opacity-70 transition-opacity">
                <span class="font-semibold block">${e(заголовок)}</span>
                ${подписьHTML ? `<span class="text-sm opacity-60">${подписьHTML}</span>` : ''}
            </a>
        </li>`;
    }

    async function лента() {
        const { data, error } = await Layout.db.from('worship_versions')
            .select('id, article_id, title, version_no, change_note, approved_at')
            .eq('status', 'published').not('approved_at', 'is', null)
            .order('approved_at', { ascending: false }).limit(8);
        if (error) { Layout.handleError(error, 'Лента изменений'); return; }

        // отменённые в ленту не попадают: «утверждён» рядом с «не действует»
        // читается как противоречие, а не как история
        const действующие = new Set(статьи.filter(с => с.status === 'published').map(с => с.id));
        $('#feed').innerHTML = (data || []).filter(в => действующие.has(в.article_id)).map(в => строка(в.article_id, в.title,
            `${дата(в.approved_at)}${в.version_no > 1 && в.change_note
                ? ' · ' + e(в.change_note) : в.version_no === 1 ? ' · новый стандарт' : ''}`
        )).join('') || '<li class="py-2 text-sm opacity-60">Пока ничего не утверждали</li>';
    }

    async function черновики() {
        if (!можноПисать()) return;
        const я = window.currentUser?.id;
        const { data, error } = await Layout.db.from('worship_versions')
            .select('article_id, title, status, updated_at, created_by, return_reason')
            .in('status', ['draft', 'submitted'])
            .order('updated_at', { ascending: false });
        if (error) { Layout.handleError(error, 'Черновики'); return; }

        // свои сверху, чужие ниже: отдел пишет сообща, но спрашивают с автора
        const свои = (data || []).filter(в => в.created_by === я);
        const чужие = (data || []).filter(в => в.created_by !== я);
        const список = [...свои, ...чужие];
        if (!список.length) return;

        // имена авторов: «чей это черновик» — первый вопрос к чужой строке
        const кто = [...new Set(список.map(в => в.created_by).filter(Boolean))];
        let имена = {};
        if (кто.length) {
            const { data: люди } = await Layout.db.from('vaishnavas')
                .select('user_id, spiritual_name, first_name, last_name').in('user_id', кто);
            имена = Object.fromEntries((люди || []).map(ч => [ч.user_id,
                ч.spiritual_name || `${ч.first_name || ''} ${ч.last_name || ''}`.trim() || 'отдел']));
        }

        $('#draftsCard').hidden = false;
        $('#drafts').innerHTML = список.map(в => {
            // возврат старшего виден прямо здесь: иначе о нём узнают случайно,
            // открыв статью — рассылка до подключения чата молчит
            const возврат = в.return_reason
                ? `<span class="badge badge-sm badge-warning mr-1">вернули</span>${e(в.return_reason)} · `
                : '';
            const чей = в.created_by === я ? '' : `${e(имена[в.created_by] || 'отдел')} · `;
            const что = в.status === 'submitted' ? 'ждёт утверждения' : 'черновик';
            return строка(в.article_id, в.title, `${возврат}${чей}${что} · ${дата(в.updated_at)}`);
        }).join('');
    }

    async function очередь() {
        if (!можноУтверждать()) return;
        const { data, error } = await Layout.db.from('worship_versions')
            .select('article_id, title, change_note, updated_at')
            .eq('status', 'submitted').order('updated_at');
        if (error) { Layout.handleError(error, 'Очередь'); return; }
        if (!data?.length) return;

        $('#queueBox').hidden = false;
        $('#queueCount').textContent = data.length;
        $('#queueList').innerHTML = data.map(в => `
            <a href="article.html?id=${в.article_id}"
               class="flex flex-col desktop:flex-row desktop:items-center gap-2 bg-base-100 border border-base-300 rounded-lg px-4 py-3">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold block">${e(в.title)}</span>
                    <span class="text-sm opacity-60">${
                        в.change_note ? '«' + e(в.change_note) + '» · ' : ''}${дата(в.updated_at)}</span>
                </span>
                <span class="btn btn-sm self-start" style="background: var(--current-color); color:#fff;">Открыть</span>
            </a>`).join('');
    }

    /** Подборки: ответ на вопрос «с чего начать», который иначе без экрана. */
    async function подборки() {
        const { data } = await Layout.db.from('worship_kits')
            .select('id, title, description').eq('is_active', true).order('title').limit(5);
        if (!data?.length) return;

        $('#kitsCard').hidden = false;
        $('#kits').innerHTML = data.map(п => `
            <li class="border-b border-base-200 last:border-0">
                <a href="kit.html?id=${п.id}" class="block py-2.5 hover:opacity-70 transition-opacity">
                    <span class="font-semibold block">${e(п.title)}</span>
                    ${п.description ? `<span class="text-sm opacity-60">${e(п.description)}</span>` : ''}
                </a>
            </li>`).join('');
    }

    async function личное() {
        const { data, error } = await Layout.db.from('worship_bookmarks')
            .select('kind, article_id, created_at').order('created_at', { ascending: false });
        if (error) return;                       // личный список не повод ломать страницу

        const заголовок = id => статьи.find(с => с.id === id)?.title || 'Статья';

        const закладки = (data || []).filter(з => з.kind === 'bookmark' && з.article_id);
        if (закладки.length) {
            $('#marksCard').hidden = false;
            $('#marks').innerHTML = закладки.map(з => строка(з.article_id, заголовок(з.article_id), '')).join('');
        }

        const недавние = (data || []).filter(з => з.kind === 'recent' && з.article_id)
            .filter(з => !закладки.some(з2 => з2.article_id === з.article_id)).slice(0, 5);
        if (недавние.length) {
            $('#recentCard').hidden = false;
            $('#recent').innerHTML = недавние.map(з => строка(з.article_id, заголовок(з.article_id), '')).join('');
        }
    }

    function рисоватьРазделы() {
        $('#sections').innerHTML = разделы.map(р => {
            const сколько = статьи.filter(с => с.section_id === р.id && с.status === 'published').length;
            return `
            <li class="border-b border-base-200 last:border-0">
                <a href="standards.html" class="flex items-baseline gap-2 py-2 hover:opacity-70 transition-opacity">
                    <span class="flex-1 min-w-0 font-semibold">${e(Layout.getName(р))}</span>
                    <span class="text-sm opacity-50">${сколько}</span>
                </a>
            </li>`;
        }).join('') || '<li class="py-2 text-sm opacity-60">Разделов пока нет</li>';
    }

    async function init() {
        // поиск идёт сразу по стандартам, библиотеке и наборам фото: человек
        // не знает, в каком хранилище ответ. Слушатель вешаем первым — иначе
        // Enter, нажатый до конца загрузки, перезагрузит страницу
        $('#searchForm').addEventListener('submit', ev => {
            ev.preventDefault();
            const q = $('#q').value.trim();
            location.href = q ? `search.html?q=${encodeURIComponent(q)}` : 'search.html';
        });

        const [р, с] = await Promise.all([
            Layout.db.from('worship_sections').select('id, name_ru, name_en, name_hi')
                .eq('kind', 'standard').eq('is_active', true).order('sort_order'),
            Layout.db.from('worship_articles').select('id, title, section_id, status').eq('kind', 'standard'),
        ]);
        // без этого сбой запроса выглядит как «модуль пуст», а не как ошибка
        if (р.error || с.error) { Layout.handleError(р.error || с.error, 'Загрузка модуля'); return; }
        разделы = р.data || [];
        статьи = с.data || [];

        рисоватьРазделы();
        await Promise.all([лента(), черновики(), очередь(), личное(), подборки()]);
    }

    return { init };
})();
