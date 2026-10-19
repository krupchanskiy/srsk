/**
 * Чтение статьи.
 *
 * Главный сценарий — не «изучить», а «свериться»: пуджари стоит у алтаря в 4:20
 * и ищет шаг семь. Поэтому у длинной статьи есть оглавление по заголовкам,
 * а место прокрутки запоминается — вернувшись, человек попадает туда же.
 *
 * Состояние показывается строкой под заголовком, а не значком где-то сбоку:
 * «действует с 14 марта, версия 3» — первое, что нужно знать о стандарте.
 */
const WorshipArticle = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const $ = s => document.querySelector(s);
    // пустая метка времени даёт new Date(null) = 1970, поэтому дату форматируем только при наличии
    const дата = v => v ? DateUtils.formatShort(new Date(v)) : '';
    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');

    const id = new URLSearchParams(location.search).get('id');
    let статья = null, версии = [], показана = null, раздел = null;
    let снимки = {};                // путь → адрес ограниченного срока
    let замечания = [];
    let имена = {};                 // user_id → как звать человека
    let вЗакладках = false;
    let заменяет = [];              // статьи, которые эта заменила собой
    let заменено = null;            // статья, которой заменили эту

    async function загрузить() {
        if (!id) { Layout.showNotification('Статья не указана', 'warning'); return false; }

        const [{ data: с, error: ош }, { data: вер, error: ошВ }] = await Promise.all([
            Layout.db.from('worship_articles').select('*').eq('id', id).maybeSingle(),
            Layout.db.from('worship_versions')
                .select('id, status, version_no, title, doc, plain_text, change_note, created_by, created_at, updated_at, approved_at, approved_by, return_reason, returned_at')
                .eq('article_id', id).order('created_at'),
        ]);
        if (ош || ошВ) { Layout.handleError(ош || ошВ, 'Загрузка статьи'); return false; }
        if (!с) { Layout.showNotification('Статья не найдена или скрыта', 'warning'); return false; }

        статья = с;
        версии = вер || [];

        // По умолчанию открывается ДЕЙСТВУЮЩИЙ текст: у алтаря в 4:20 человек
        // должен видеть то, по чему служат, а не чужую неутверждённую правку.
        // Правка открывается осознанно — ссылкой из очереди или из строки
        // состояния («есть правка на утверждении»), и тогда приходит в адресе.
        const хотят = new URLSearchParams(location.search).get('v');
        показана = (хотят && версии.find(в => в.id === хотят))
                || версии.find(в => в.status === 'published')
                || версии.find(в => в.status === 'submitted')
                || версии.find(в => в.status === 'draft')
                || null;
        // ссылки на снимки зависят только от текста — просим их сейчас,
        // параллельно с замечаниями и именами, а не отдельным кругом в конце
        снимкиВПути = WorshipDoc.ссылкиНаСнимки(Layout.db, показана?.doc);

        // всё остальное об этой статье — одним заходом: на телефоне у алтаря
        // каждый лишний обмен с сервером виден глазами.
        // Связь замены берём в обе стороны: ТЗ требует показывать её на обеих
        // статьях, иначе противоречие между старым и новым замечают случайно
        const [зам0, зам1, з, зам] = await Promise.all([
            Layout.db.from('worship_articles').select('id, title')
                .eq('replaced_by_id', id).order('title'),
            с.replaced_by_id
                ? Layout.db.from('worship_articles').select('id, title').eq('id', с.replaced_by_id).maybeSingle()
                : Promise.resolve({ data: null }),
            Layout.db.from('worship_bookmarks').select('id')
                .eq('kind', 'bookmark').eq('article_id', id).maybeSingle(),
            Layout.db.from('worship_remarks')
                .select('id, body, state, created_at, created_by, closed_at, close_reason')
                .eq('article_id', id).order('created_at', { ascending: false }),
            статья.section_id
                ? Layout.db.from('worship_sections').select('id, name_ru, name_en, name_hi')
                    .eq('id', статья.section_id).maybeSingle().then(о => { раздел = о.data; })
                : Promise.resolve(),
        ]);
        заменяет = зам0.data || [];      // одним стандартом можно отменить несколько
        заменено = зам1.data || null;
        вЗакладках = !!з.data;
        замечания = зам.data || [];

        // ТЗ просит в карточке версии автора и утвердившего, а у замечания —
        // того, кто его оставил: «кто это писал» — первый вопрос к чужому тексту
        const кто = [...new Set([
            ...версии.flatMap(в => [в.created_by, в.approved_by]),
            ...замечания.map(з2 => з2.created_by),
        ].filter(Boolean))];
        if (кто.length) {
            const { data: люди } = await Layout.db.from('vaishnavas')
                .select('user_id, spiritual_name, first_name, last_name').in('user_id', кто);
            имена = Object.fromEntries((люди || []).map(ч => [ч.user_id,
                ч.spiritual_name || `${ч.first_name || ''} ${ч.last_name || ''}`.trim() || 'кто-то из отдела']));
        }

        return true;
    }

    // ---------- состояние ----------
    const действующая = () => версии.find(в => в.status === 'published');

    function строкаСостояния() {
        if (!показана) return 'Текста пока нет';

        if (статья.status === 'archived') {
            const замена = заменено
                ? ` · заменено статьёй <a class="link" href="article.html?id=${заменено.id}">${
                    e(заменено.title)}</a>`
                : '';
            return `<span class="text-warning font-semibold">Не действует${
                статья.archived_at ? ' с ' + дата(статья.archived_at) : ''}</span>${
                статья.archive_reason ? ' · ' + e(статья.archive_reason) : ''}${замена}`;
        }

        const д = действующая();
        // ссылка-переключатель: с правки на действующий текст и обратно
        const кДействующей = д && д.id !== показана.id
            ? ` · <a class="link" href="article.html?id=${статья.id}">показать действующую</a>` : '';

        if (показана.status === 'published') {
            const правка = версии.find(в => в.status === 'submitted');
            // Про черновик здесь не говорилось ничего: на экране стояло
            // «Действует, версия 1», а кнопка звала «продолжить правку» —
            // и человек не понимал, почему в редакторе текст длиннее
            const черновик = !правка && версии.find(в => в.status === 'draft');
            return `<span class="text-success font-semibold">Действует${
                показана.approved_at ? ' с ' + дата(показана.approved_at) : ''}</span> · версия ${показана.version_no}${
                правка ? ` · <a class="link font-semibold" href="article.html?id=${статья.id}&v=${
                    правка.id}">есть правка на утверждении</a>` : ''}${
                черновик ? ` · <a class="link font-semibold" href="article.html?id=${статья.id}&v=${
                    черновик.id}">есть незаконченная правка</a>` : ''}${
                заменяет.length ? ' · заменил ' + заменяет.map(з =>
                    `<a class="link" href="article.html?id=${з.id}">${e(з.title)}</a>`).join(', ') : ''}`;
        }
        if (показана.status === 'submitted') {
            return `<span class="text-warning font-semibold">Правка ждёт утверждения</span>${
                д ? ` · в храме действует версия ${д.version_no}` : ''}${кДействующей}`;
        }
        if (показана.status === 'superseded') {
            return `<span class="opacity-70 font-semibold">Версия ${показана.version_no}, больше не действует</span>${кДействующей}`;
        }
        return `<span class="text-warning font-semibold">Незаконченная правка</span> · ${
            д ? `в храме действует версия ${д.version_no}, пока эту не утвердят`
              : 'в храме пока не действует ничего'}${кДействующей}`;
    }

    /**
     * «Пока эту не утвердят» — верно, но не говорит, чего ждать и от кого.
     * Путь правки короткий: дописать → отправить старшему → он утверждает.
     * Строка называет ближайший шаг и того, чей он.
     */
    function рисоватьПутьКУтверждению() {
        const узел = $('#какПринять');
        if (!узел) return;
        const состояние = показана?.status;

        let текст = '';
        if (состояние === 'draft') {
            текст = можноПисать()
                ? 'Чтобы она стала действующей: допишите и нажмите «Отправить старшему» — '
                  + 'дальше решение за ним.'
                : 'Её дописывает автор. Пока он не отправит правку старшему, она никуда не идёт.';
        } else if (состояние === 'submitted') {
            текст = можноУтверждать()
                ? 'Решение за вами: «Утвердить» — и она сразу действует в храме, '
                  + '«Вернуть автору» — уйдёт на доработку с вашим замечанием.'
                : 'Правка у старшего пуджари. Утвердит — станет действующей, вернёт — придёт на доработку.';
        }

        узел.hidden = !текст;
        узел.textContent = текст;
    }

    function рисоватьШапку() {
        $('#crumb').innerHTML = раздел
            ? `<a href="standards.html" class="link link-hover opacity-70">${e(Layout.getName(раздел))}</a>`
            : '<a href="standards.html" class="link link-hover opacity-70">Стандарты</a>';
        $('#title').textContent = показана?.title || статья.title;
        $('#state').innerHTML = строкаСостояния();
        рисоватьПутьКУтверждению();

        const угол = $('#printHeader');
        if (угол) {
            угол.textContent = показана?.status === 'published' && показана.approved_at
                ? `${статья.title} · версия ${показана.version_no} · утверждена ${дата(показана.approved_at)}`
                : '';
        }

        // возврат автору виден только автору правки и старшему — остальным он ничего не говорит
        const открытая = версии.find(в => в.status === 'draft' || в.status === 'submitted');
        const возврат = открытая?.return_reason;
        $('#returned').hidden = !возврат;
        if (возврат) $('#returnReason').textContent = открытая.return_reason;
    }

    function рисоватьДействия() {
        const черновик = версии.find(в => в.status === 'draft');
        const наУтверждении = версии.find(в => в.status === 'submitted');
        // утверждают и возвращают только тот текст, который сейчас на экране
        const наЭкранеПравка = показана?.status === 'submitted';
        const кнопки = [];

        // Правка, отправленная старшему, редактору не отдаётся: он её
        // не откроет, пока её не отзовут. Кнопка «Продолжить правку» всё
        // равно звала туда и возвращала обратно с отказом — теперь её нет,
        // а вместо неё ссылка на сам текст, который ждёт решения.
        if (можноПисать() && статья.status !== 'archived') {
            // тот, кто решает судьбу правки, может доправить её сам —
            // не гоняя автора ради запятой
            if (наУтверждении && наЭкранеПравка && можноУтверждать()) {
                кнопки.push(`<a href="edit.html?id=${статья.id}" class="btn btn-sm btn-outline">Поправить</a>`);
            } else if (наУтверждении && !наЭкранеПравка) {
                кнопки.push(`<a href="article.html?id=${статья.id}&v=${наУтверждении.id}"
                    class="btn btn-sm btn-outline">Открыть правку</a>`);
            } else if (!наУтверждении) {
                кнопки.push(`<a href="edit.html?id=${статья.id}" class="btn btn-sm"
                    style="background: var(--current-color); color:#fff;">${
                    черновик ? 'Продолжить правку' : 'Править'}</a>`);
            }
        }
        if (можноУтверждать() && наЭкранеПравка) {
            кнопки.push('<button class="btn btn-sm btn-success text-white" id="approve">Утвердить</button>');
            кнопки.push('<button class="btn btn-sm btn-outline" id="return">Вернуть автору</button>');
        }
        // отозвать с утверждения — автор правки или старший (так же решает база)
        if (можноПисать() && наЭкранеПравка
            && (показана?.created_by === window.currentUser?.id || можноУтверждать())) {
            кнопки.push('<button class="btn btn-sm btn-ghost" id="withdraw">Отозвать</button>');
        }
        // звёздочка значком, а не текстовым символом: ★ набиралось размером
        // шрифта кнопки и выглядело вдвое мельче соседей
        кнопки.push(`<button class="btn btn-sm px-2 bg-base-100 border-base-300 hover:bg-base-200 цельПальцаКрупно"
            id="bookmark" title="${
            вЗакладках ? 'Убрать из закладок' : 'В закладки'}" aria-label="${
            вЗакладках ? 'Убрать из закладок' : 'В закладки'}"
            aria-pressed="${вЗакладках}">
            <svg width="19" height="19" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"
                 stroke-linejoin="round" aria-hidden="true"
                 fill="${вЗакладках ? 'var(--current-color)' : 'none'}"
                 style="${вЗакладках ? 'color: var(--current-color);' : ''}">
                <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"></path>
            </svg>
        </button>`);

        // Сюда приходят читать, как делается служение. Поэтому на виду одно
        // действие по роли, а разовые решения — печать, сравнение редакций,
        // вывод из действия — собраны под «ещё»: пятью кнопками в два ряда
        // экран начинался с приборной доски, а не со стандарта.
        const редкие = [];
        if (показана?.status === 'published') {
            редкие.push('<li><button id="уАлтаря">У алтаря: крупно и по шагам</button></li>');
        }
        // ночной режим — у алтаря в 4 утра белый экран слепит (см. color-init.js)
        if (window.srskNight) {
            редкие.push(`<li><button id="ночь">${e(window.srskNight.подпись())}</button></li>`);
        }
        // библиотека сравнения подгружается при щелчке (см. библиотекаСравнения)
        if (предыдущая(показана)) {
            редкие.push('<li><button id="diff">Что изменилось</button></li>');
        }
        // печатаем только действующее: лист на стене не должен спорить с храмом,
        // поэтому отменённый стандарт не печатается, даже если его версия когда-то действовала
        if (показана?.status === 'published' && статья.status === 'published') {
            редкие.push('<li><button id="print">Печать</button></li>');
        }
        if (можноУтверждать() && статья.status === 'published') {
            редкие.push(наУтверждении
                ? `<li><button id="archiveBlocked"
                           title="Сначала решите по правке: утвердите или верните автору"
                           >Вывести из действия</button></li>`
                : '<li><button id="archive">Вывести из действия</button></li>');
        }
        if (можноУтверждать() && статья.status === 'archived') {
            редкие.push('<li><button id="unarchive">Вернуть из архива</button></li>');
        }

        if (редкие.length) {
            кнопки.push(`
            <div class="dropdown dropdown-end">
                <button tabindex="0" class="btn btn-sm px-2 bg-base-100 border-base-300 hover:bg-base-200 цельПальцаКрупно" aria-label="Ещё действия">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle>
                        <circle cx="12" cy="19" r="1.7"></circle>
                    </svg>
                </button>
                <ul tabindex="0" class="dropdown-content z-30 menu menu-sm p-2 shadow bg-base-100 rounded-box w-56">
                    ${редкие.join('')}
                </ul>
            </div>`);
        }

        $('#actions').innerHTML = кнопки.join('');
    }

    /**
     * Предыдущая версия: для правки — действующая, для утверждённой — та,
     * что была до неё. Сравнивать не с чем только у самой первой.
     */
    function предыдущая(в) {
        if (!в) return null;
        if (в.status === 'draft' || в.status === 'submitted') return действующая() || null;
        const готовые = версии.filter(x => x.version_no).sort((a, b) => a.version_no - b.version_no);
        const i = готовые.findIndex(x => x.id === в.id);
        return i > 0 ? готовые[i - 1] : null;
    }

    /** jsdiff нужен только тому, кто сравнивает версии: грузим по требованию. */
    function библиотекаСравнения() {
        if (window.Diff) return Promise.resolve();
        return new Promise((готово, сбой) => {
            const с = document.createElement('script');
            с.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.2.0/diff.min.js';
            с.onload = готово; с.onerror = сбой;
            document.head.appendChild(с);
        });
    }

    async function показатьСравнение() {
        const было = предыдущая(показана);
        if (!было) return;
        try { await библиотекаСравнения(); }
        catch { return Layout.showNotification('Не загрузилось сравнение — проверьте связь', 'error'); }

        $('#diffSub').textContent = `${было.version_no ? 'Версия ' + было.version_no : 'Прежний текст'} → ${
            показана.status === 'submitted' ? 'правка на утверждении' : 'версия ' + показана.version_no}`;

        const тело = $('#diffBody');
        тело.innerHTML = '';
        const части = Diff.diffWords(WorshipDoc.текст(было.doc), WorshipDoc.текст(показана.doc));
        части.forEach(ч => {
            const узел = document.createElement(ч.added ? 'ins' : ч.removed ? 'del' : 'span');
            if (ч.added) узел.className = 'bg-success/20 no-underline';
            if (ч.removed) узел.className = 'bg-error/20 opacity-70';
            узел.textContent = ч.value;
            тело.appendChild(узел);
        });
        if (части.every(ч => !ч.added && !ч.removed)) {
            тело.textContent = 'Текст не изменился — поправили только заголовок или раздел.';
        }
        $('#diffModal').showModal();
    }

    let снимкиВПути = null;          // запрос ссылок, начатый ещё в загрузить()

    async function дополнитьСнимками() {
        const запрос = снимкиВПути || WorshipDoc.ссылкиНаСнимки(Layout.db, показана?.doc);
        снимкиВПути = null;
        снимки = await запрос;
    }

    // ---------- «У алтаря» ----------
    // Пуджари проходит стандарт прямо у алтаря, с мокрыми руками: крупный
    // шрифт, шаги отмечаются касанием, экран не гаснет. Отметки живут до
    // конца дня на этом устройстве — завтра служба снова с начала.
    let уАлтаря = false, замокЭкрана = null, отмеченные = null;
    const ключШагов = () => `worship_steps_${id}_${DateUtils.todayAshramISO()}`;
    function сделанные() {
        if (!отмеченные) {
            try { отмеченные = new Set(JSON.parse(sessionStorage.getItem(ключШагов()) || '[]')); }
            catch { отмеченные = new Set(); }
        }
        return отмеченные;
    }
    function запомнитьСделанные() {
        try { sessionStorage.setItem(ключШагов(), JSON.stringify([...сделанные()])); } catch { /* ignore */ }
    }
    function разметитьШаги() {
        const шаги = [...document.querySelectorAll('#body ol > li')];
        шаги.forEach((ш, i) => { ш.dataset.шаг = i; ш.classList.toggle('сделано', сделанные().has(i)); });
        const сделано = шаги.filter(ш => ш.classList.contains('сделано')).length;
        $('#алтарьСчёт').textContent = шаги.length
            ? `Сделано ${сделано} из ${шаги.length}` : 'У алтаря';
    }
    async function держатьЭкран() {
        try { замокЭкрана = await navigator.wakeLock?.request('screen'); } catch { замокЭкрана = null; }
    }
    async function переключитьАлтарь() {
        уАлтаря = !уАлтаря;
        document.body.classList.toggle('уАлтаря', уАлтаря);
        $('#алтарьПанель').hidden = !уАлтаря;
        if (уАлтаря) { разметитьШаги(); await держатьЭкран(); window.scrollTo({ top: 0 }); }
        else { try { await замокЭкрана?.release(); } catch { /* ignore */ } замокЭкрана = null; }
    }
    // замок экрана снимается, когда вкладка уходит в фон, — вернулись, берём снова
    document.addEventListener('visibilitychange', () => {
        if (уАлтаря && document.visibilityState === 'visible') держатьЭкран();
    });
    document.addEventListener('click', ev => {
        if (!уАлтаря) return;
        const шаг = ev.target.closest('#body ol > li');
        if (!шаг || ev.target.closest('a, .термин')) return;   // термин — пояснение, а не отметка
        const i = Number(шаг.dataset.шаг);
        if (сделанные().has(i)) сделанные().delete(i); else сделанные().add(i);
        запомнитьСделанные();
        разметитьШаги();
    });

    /**
     * Открыт из подборки (?из=…): под текстом — следующий пункт. Новичок
     * проходит подборку по порядку, а возвращаться за ним в список было неудобно.
     */
    async function дальшеВПодборке() {
        const подборка = new URLSearchParams(location.search).get('из');
        if (!подборка) return;
        const { data: пункты } = await Layout.db.from('worship_kit_items')
            .select('article_id, album_id, note, sort_order').eq('kit_id', подборка).order('sort_order');
        const список = (пункты || []).filter(п => п.article_id || п.album_id);
        const i = список.findIndex(п => п.article_id === id);
        if (i === -1) return;
        const след = список[i + 1];
        let ссылка = `<a class="link" href="kit.html?id=${подборка}">к подборке</a>`;
        if (след?.article_id) {
            const { data: а } = await Layout.db.from('worship_articles')
                .select('title, kind').eq('id', след.article_id).maybeSingle();
            if (а) ссылка = `<a class="btn btn-sm" style="background: var(--current-color); color:#fff;"
                href="${а.kind === 'material' ? 'material' : 'article'}.html?id=${след.article_id}${
                    а.kind === 'material' ? '' : `&из=${подборка}`}">Дальше: ${e(а.title)} →</a>
                <a class="link text-sm" href="kit.html?id=${подборка}">к подборке</a>`;
        } else if (след?.album_id) {
            const { data: н } = await Layout.db.from('worship_albums')
                .select('title').eq('id', след.album_id).maybeSingle();
            if (н) ссылка = `<a class="btn btn-sm" style="background: var(--current-color); color:#fff;"
                href="album.html?id=${след.album_id}">Дальше: ${e(н.title)} →</a>
                <a class="link text-sm" href="kit.html?id=${подборка}">к подборке</a>`;
        }
        $('#дальше').hidden = false;
        $('#дальше').innerHTML = `
            <div class="flex flex-wrap items-center gap-3 rounded-xl bg-base-100 shadow-sm px-4 py-3">
                <span class="text-sm opacity-70">Пункт ${i + 1} из ${список.length} подборки${
                    след ? '' : ' — последний'}</span>
                <span class="flex-1"></span>
                ${ссылка}
            </div>`;
    }

    function рисоватьТекст() {
        const тело = $('#body');
        тело.innerHTML = '';
        тело.appendChild(WorshipDoc.нарисовать(показана?.doc, снимки));
        // термины подчёркнуты: по касанию — пояснение для новичка
        window.WorshipGlossary?.разметить(тело);

        const главы = WorshipDoc.заголовки(показана?.doc);
        $('#toc').hidden = главы.length < 2;
        // на компьютере оглавление раскрыто, на телефоне свёрнуто: иначе оно
        // стоит между заголовком статьи и первой строкой текста
        const коробка = $('#tocBox');
        if (коробка) коробка.open = window.matchMedia('(min-width: 1200px)').matches;
        $('#tocList').innerHTML = главы.map(г => `
            <li class="${г.уровень === 3 ? 'ml-3' : ''}">
                <a href="#${г.якорь}" class="link link-hover text-sm opacity-80">${e(г.текст)}</a>
            </li>`).join('');
    }

    function рисоватьЗамечания() {
        const открытые = замечания.filter(з => з.state === 'open');
        const закрытые = замечания.filter(з => з.state !== 'open').slice(0, 5);

        // Самое свежее открытое замечание поднимаем над текстом: человек
        // служит по стандарту, про который отдел уже знает, что там неточность.
        // Внизу страницы, равным весом с историей, он его не увидит.
        const первое = открытые[0];
        $('#openRemark').hidden = !первое;
        if (первое) {
            $('#openRemarkBody').textContent = первое.body;
            const кто = имена[первое.created_by];
            $('#openRemarkWho').textContent = [кто, дата(первое.created_at)].filter(Boolean).join(' · ');
            const правка = (версии || []).find(в => в.status === 'submitted');
            $('#openRemarkHint').innerHTML = (показана?.status === 'published'
                    ? 'Пока замечание не разобрано, служат по утверждённому тексту ниже. '
                    : 'Пока замечание не разобрано, служат по действующей версии стандарта. ')
                + 'Если сомневаетесь — спросите старшего пуджари.'
                + (правка ? ` Исправление уже <a class="link" href="article.html?id=${статья.id}&v=${правка.id}">ждёт утверждения</a>.` : '');
        }

        // в заголовке свёрнутого блока — сколько там всего, чтобы не раскрывать вслепую
        $('#remarksCount').textContent = открытые.length
            ? `${открытые.length} открыто` : (замечания.length ? `${замечания.length} разобрано` : 'нет');

        const имяАвтора = id => имена[id] || '';

        /**
         * Суть замечания — первой строкой и крупно. Раньше сверху стоял
         * цветной чип с автором и датой, а само замечание шло под ними
         * обычным текстом: взгляд цеплялся за «кто и когда» вместо «что».
         */
        const строка = (з, приглушить) => {
            const ответ = з.state === 'accepted' ? 'учтено'
                : з.state === 'declined' ? 'не согласен' : '';
            const действия = з.state === 'open' && можноПисать()
                ? `<div class="flex flex-wrap gap-2 mt-2">
                       <button class="btn btn-xs btn-outline" data-remark-ok="${з.id}">Учтено</button>
                       <button class="btn btn-xs btn-ghost" data-remark-no="${з.id}">Не согласен</button>
                   </div>` : '';
            return `
            <li class="${приглушить ? 'opacity-70 ' : ''}border-b border-base-200 last:border-0 py-3">
                <div class="font-medium">${e(з.body)}</div>
                <div class="text-sm opacity-70 mt-0.5">
                    ${имяАвтора(з.created_by) ? e(имяАвтора(з.created_by)) + ' · ' : ''}${дата(з.created_at)}
                    ${ответ ? ` · <span class="${з.state === 'accepted'
                        ? 'text-success' : ''} font-semibold">${ответ}</span>` : ''}
                </div>
                ${з.close_reason
                    ? `<div class="text-sm opacity-70 mt-1">«${e(з.close_reason)}»</div>` : ''}
                ${действия}
            </li>`;
        };

        // разобранные не мешаются с тем, что ещё ждёт решения
        $('#remarks').innerHTML = открытые.map(з => строка(з, false)).join('')
            || (замечания.length
                ? '<li class="py-2 text-sm opacity-70">Всё разобрано</li>'
                : '<li class="py-2 text-sm opacity-70">Пока никто ничего не заметил</li>');

        const блокЗакрытых = $('#remarksDone');
        if (блокЗакрытых) {
            блокЗакрытых.hidden = !закрытые.length;
            $('#remarksDoneCount').textContent = Layout.pluralize(закрытые.length, {
                ru: ['разобранное', 'разобранных', 'разобранных'],
                en: ['resolved', 'resolved'], hi: 'हल' });
            $('#remarksDoneList').innerHTML = закрытые.map(з => строка(з, true)).join('');
        }
    }

    function рисоватьИсторию() {
        const готовые = версии.filter(в => в.status !== 'draft' && в.status !== 'submitted')
                              .sort((a, b) => b.version_no - a.version_no);
        // сколько редакций — видно, не раскрывая блок
        const счётчик = $('#historyCount');
        if (счётчик) {
            счётчик.textContent = готовые.length > 1
                ? Layout.pluralize(готовые.length, {
                    ru: ['редакция', 'редакции', 'редакций'],
                    en: ['version', 'versions'], hi: 'संस्करण' })
                : '';
        }
        $('#history').innerHTML = готовые.map(в => {
            // «написал Пётр · утвердил Пётр» — две одинаковые фамилии подряд,
            // хотя это один и тот же человек
            const автор = имена[в.created_by], утвердил = имена[в.approved_by];
            const кто = автор && утвердил && автор === утвердил
                ? `написал и утвердил ${e(автор)}`
                : [автор ? 'написал ' + e(автор) : '', утвердил ? 'утвердил ' + e(утвердил) : '']
                    .filter(Boolean).join(' · ');
            return `
            <li class="border-b border-base-200 last:border-0 py-3
                       flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="font-semibold whitespace-nowrap">Версия ${в.version_no}</span>
                ${в.status === 'published'
                    ? '<span class="badge badge-sm badge-success">сейчас</span>' : ''}
                <span class="text-sm opacity-70 whitespace-nowrap">${дата(в.approved_at)}</span>
                <span class="flex-1"></span>
                <span class="flex gap-2 shrink-0">
                    <button class="btn btn-xs btn-outline" data-show="${в.id}">Открыть</button>
                    ${в.status !== 'published' && можноПисать() && статья.status !== 'archived'
                        ? `<button class="btn btn-xs btn-ghost" data-restore="${в.id}">Вернуть</button>` : ''}
                </span>
                <!-- кто и что поменял — строкой под шапкой версии: иначе длинное
                     примечание выталкивало кнопки на третью строку -->
                <span class="w-full text-sm opacity-70">${кто}${
                    в.change_note ? ` · «${e(в.change_note)}»` : ''}</span>
            </li>`;
        }).join('') || '<li class="py-3 text-sm opacity-70">Утверждённых версий ещё нет</li>';
    }

    /** Теги и соседи по ним: словарь общий, поэтому «есть ещё» честное. */
    async function рисоватьТеги() {
        await WorshipTags.нарисовать(
            document.querySelector('#теги'), { article_id: id }, { можноПравить: можноПисать(), правкаПоКнопке: true });

        const { статьи, наборы } = await WorshipTags.соседи({ article_id: id });
        const блок = document.querySelector('#соседи');
        if (!статьи.length && !наборы.length) { блок.innerHTML = ''; return; }

        блок.innerHTML = `
            <div class="text-sm opacity-60 mb-1">По этим тегам есть ещё:</div>
            <ul class="list-none m-0 p-0 flex flex-wrap gap-x-4 gap-y-1">
                ${статьи.map(а => `<li><a class="link text-sm" href="${
                    а.kind === 'material' ? 'material' : 'article'}.html?id=${а.id}">${e(а.title)}</a></li>`).join('')}
                ${наборы.map(н => `<li><a class="link text-sm" href="album.html?id=${н.id}">${
                    e(н.title)} (фото)</a></li>`).join('')}
            </ul>`;
    }

    function рисовать() {
        рисоватьШапку();
        рисоватьДействия();
        рисоватьТекст();
        рисоватьЗамечания();
        рисоватьИсторию();
        window.applyPermissions?.();
        рисоватьТеги();
        дальшеВПодборке();
        восстановитьПрокрутку();
    }

    // ---------- память прокрутки ----------
    // Возвращаем на прежнее место только при «назад» и перезагрузке: открыв
    // статью из списка, человек ждёт начала, а не середины вчерашнего чтения.
    const ключПрокрутки = () => `srsk_worship_scroll_${id}`;
    function восстановитьПрокрутку() {
        const как = performance.getEntriesByType('navigation')[0]?.type;
        if (как !== 'back_forward' && как !== 'reload') return;
        try {
            const y = Number(sessionStorage.getItem(ключПрокрутки()));
            if (y > 0) setTimeout(() => scrollTo({ top: y }), 50);
        } catch { /* приватный режим */ }
    }
    addEventListener('scroll', Layout.debounce(() => {
        try { sessionStorage.setItem(ключПрокрутки(), String(scrollY)); } catch { /* приватный режим */ }
    }, 300));

    // ---------- действия ----------
    /**
     * Окно для связного текста: замечание, причина возврата, ответ на замечание.
     * Возвращает введённое либо null, если человек передумал.
     */
    function спроситьТекст({ заголовок, подсказка, кнопка = 'Отправить', обязательно = true }) {
        return new Promise(готово => {
            const окно = $('#textModal');
            $('#textTitle').textContent = заголовок;
            $('#textHint').textContent = подсказка || '';
            $('#textBody').value = '';
            $('#textGo').textContent = кнопка;

            const отправить = () => {
                const текст = $('#textBody').value.trim();
                if (обязательно && !текст) { $('#textBody').focus(); return; }
                убрать();
                окно.close();
                готово(текст);
            };
            const закрыть = () => { убрать(); готово(null); };
            const убрать = () => {
                $('#textGo').removeEventListener('click', отправить);
                окно.removeEventListener('close', закрыть);
            };

            $('#textGo').addEventListener('click', отправить);
            окно.addEventListener('close', закрыть, { once: true });
            окно.showModal();
            setTimeout(() => $('#textBody').focus(), 50);
        });
    }

    async function открытьАрхивацию() {
        const { data } = await Layout.db.from('worship_articles')
            .select('id, title').eq('kind', 'standard').eq('status', 'published')
            .neq('id', статья.id).order('title');
        $('#archiveReplacement').innerHTML = '<option value="">Ничем — просто отменяем</option>' +
            (data || []).map(с => `<option value="${с.id}">${e(с.title)}</option>`).join('');
        $('#archiveReason').value = '';
        $('#archiveModal').showModal();
    }

    let закладкаВРаботе = false;

    async function переключитьЗакладку() {
        const я = window.currentUser?.id;
        if (!я || закладкаВРаботе) return;   // второй клик подряд давал ошибку вместо закладки
        закладкаВРаботе = true;
        const запрос = вЗакладках
            ? Layout.db.from('worship_bookmarks').delete()
                .eq('kind', 'bookmark').eq('article_id', id).eq('user_id', я)
            : Layout.db.from('worship_bookmarks')
                .insert({ user_id: я, kind: 'bookmark', article_id: id });
        const { error } = await запрос;
        закладкаВРаботе = false;
        if (error) return Layout.handleError(error, 'Закладка');
        вЗакладках = !вЗакладках;
        рисоватьДействия();
        // без этого непонятно, куда делась закладка: список живёт на главной модуля
        Layout.showNotification(вЗакладках
            ? 'В закладках — список на главной модуля'
            : 'Убрано из закладок', 'success');
    }

    async function перечитать() {
        if (!await загрузить()) return;
        await дополнитьСнимками();
        рисовать();
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const показать = ev.target.closest('[data-show]');
            if (показать) {
                показана = версии.find(в => в.id === показать.dataset.show);
                await дополнитьСнимками();
                рисоватьШапку(); рисоватьДействия(); рисоватьТекст();
                scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }
            const вернуть = ev.target.closest('[data-restore]');
            if (вернуть) {
                const в = версии.find(x => x.id === вернуть.dataset.restore);
                if (!await спросить(`Вернуть версию ${в.version_no}?`,
                    'Она станет черновиком и пройдёт утверждение заново.')) return;
                const { error } = await Layout.db.rpc('worship_restore_version', { p_version: в.id });
                if (error) return Layout.handleError(error, 'Возврат версии');
                Layout.showNotification('Версия скопирована в черновик', 'success');
                return перечитать();
            }

            const учтено = ev.target.closest('[data-remark-ok]');
            const несогласие = ev.target.closest('[data-remark-no]');
            if (учтено || несогласие) {
                const id = (учтено || несогласие).dataset.remarkOk
                        || (учтено || несогласие).dataset.remarkNo;
                const причина = await спроситьТекст(несогласие
                    ? { заголовок: 'Не согласен', кнопка: 'Закрыть замечание',
                        подсказка: 'Почему? Автор замечания это увидит.' }
                    : { заголовок: 'Учтено', кнопка: 'Закрыть замечание', обязательно: false,
                        подсказка: 'Можно коротко ответить — или просто закрыть.' });
                if (причина === null) return;             // передумали
                const { error } = await Layout.db.rpc('worship_remark_close', {
                    p_remark: id, p_state: несогласие ? 'declined' : 'accepted', p_reason: причина });
                if (error) return Layout.handleError(error, 'Замечание');
                return перечитать();
            }

            const b = ev.target.closest('button');
            if (!b) return;

            if (b.id === 'addRemark') {
                const текст = await спроситьТекст({
                    // вопрос новичка — тоже повод: «непонятно» значит, текст можно сделать яснее
                    заголовок: 'Что не так или что непонятно?',
                    подсказка: 'Одной-двумя фразами. Уйдёт автору последней версии и старшему; '
                        + 'ответ увидите здесь и на главной модуля в «Ваших замечаниях».',
                });
                if (!текст) return;
                const { error } = await Layout.db.rpc('worship_remark_add',
                    { p_article: статья.id, p_body: текст });
                if (error) return Layout.handleError(error, 'Замечание');
                Layout.showNotification('Отправлено — ответ появится на главной в «Ваших замечаниях»', 'success');
                return перечитать();
            }

            if (b.id === 'bookmark') return переключитьЗакладку();
            if (b.id === 'уАлтаря' || b.id === 'алтарьВыйти') return переключитьАлтарь();
            if (b.id === 'алтарьСброс') { сделанные().clear(); запомнитьСделанные(); return разметитьШаги(); }
            if (b.id === 'ночь') {
                const р = window.srskNight.переключить();
                b.textContent = window.srskNight.подпись(р);
                return Layout.showNotification(window.srskNight.подпись(р), 'info');
            }
            if (b.id === 'print') return print();
            if (b.id === 'diff') return показатьСравнение();

            if (b.id === 'approve') {
                if (!await спросить('Утвердить правку?',
                    'С этого момента по этому тексту служат в храме.')) return;
                const { data, error } = await Layout.db.rpc('worship_approve', { p_article: статья.id });
                if (error) return Layout.handleError(error, 'Утверждение');
                if (data?.отозвана) {
                    Layout.showNotification(data.сообщение || 'Правку отозвали', 'warning');
                    return перечитать();
                }
                Layout.showNotification(data?.повтор ? 'Уже утверждено' : `Утверждено, версия ${data?.номер}`, 'success');
                return перечитать();
            }
            if (b.id === 'return') {
                const причина = await спроситьТекст({
                    заголовок: 'Вернуть автору',
                    подсказка: 'Что поправить? Автор увидит это над текстом, когда откроет правку.',
                    кнопка: 'Вернуть',
                });
                if (!причина) return;
                const { error } = await Layout.db.rpc('worship_return', { p_article: статья.id, p_reason: причина });
                if (error) return Layout.handleError(error, 'Возврат автору');
                Layout.showNotification('Возвращено автору', 'success');
                return перечитать();
            }
            if (b.id === 'withdraw') {
                const { error } = await Layout.db.rpc('worship_withdraw', { p_article: статья.id });
                if (error) return Layout.handleError(error, 'Отзыв правки');
                Layout.showNotification('Правка снова у вас в черновиках', 'success');
                return перечитать();
            }
            if (b.id === 'archiveBlocked') {
                Layout.showNotification(
                    'Сначала решите по правке: утвердите её или верните автору', 'info');
                return;
            }
            if (b.id === 'archive') return открытьАрхивацию();
            if (b.id === 'archiveGo') {
                const причина = $('#archiveReason').value.trim();
                if (!причина) {
                    Layout.showNotification('Без причины отмену не понять через полгода', 'warning');
                    return $('#archiveReason').focus();
                }
                const { error } = await Layout.db.rpc('worship_archive', {
                    p_article: статья.id, p_reason: причина,
                    p_replaced_by: $('#archiveReplacement').value || null });
                if (error) return Layout.handleError(error, 'Архивация');
                $('#archiveModal').close();
                Layout.showNotification('Стандарт отменён', 'success');
                return перечитать();
            }
            if (b.id === 'unarchive') {
                if (!await спросить('Вернуть стандарт в действие?', заменено
                        ? `Сейчас вместо него действует «${заменено.title}». Два стандарта станут противоречить друг другу.`
                        : '')) return;
                const { error } = await Layout.db.rpc('worship_unarchive', { p_article: статья.id });
                if (error) return Layout.handleError(error, 'Возврат из архива');
                Layout.showNotification('Стандарт снова действует', 'success');
                return перечитать();
            }
        });
    }

    /** Ссылка из чата может вести в никуда: статью удалили или прав не хватило. */
    function пусто(сообщение) {
        document.querySelector('main').innerHTML = `
            <div class="card bg-base-100 shadow max-w-xl">
                <div class="card-body items-start">
                    <h1 class="card-title text-xl">${e(сообщение)}</h1>
                    <p class="text-sm opacity-70">Возможно, статью отменили и удалили,
                        либо ссылка ведёт на чужой черновик.</p>
                    <a href="standards.html" class="btn btn-sm mt-2"
                       style="background: var(--current-color); color:#fff;">К списку стандартов</a>
                </div>
            </div>`;
    }

    async function init() {
        слушать();
        if (!await загрузить()) {
            пусто(id ? 'Статья не найдена' : 'Статья не указана');
            return;
        }
        await дополнитьСнимками();
        рисовать();
        // «недавно открытое» ведётся функцией: она же подрезает список до семи строк.
        // .then обязателен: запрос supabase-js ленивый и без него не уходит вовсе
        Layout.db.rpc('worship_touch_recent', { p_article: id })
            .then(({ error }) => { if (error) console.debug('недавнее:', error.message); });
    }

    return { init };
})();
