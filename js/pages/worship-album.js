/**
 * Набор снимков: загрузка пачкой, подписи, порядок, просмотр.
 *
 * Загрузка идёт по одному со счётчиком «3 из 12»: уже загруженные не теряются,
 * неудавшиеся остаются в списке и грузятся кнопкой. Обещания «дозагрузим после
 * закрытия вкладки» здесь нет сознательно — после перезагрузки страницы браузер
 * теряет доступ к выбранным файлам, и обещать это значит обмануть.
 */
const WorshipAlbum = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноПисать = () => !!window.hasPermission?.('worship_write');
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');
    // снимки в папку грузит каждый, кто видит модуль; убирает — старший;
    // подписи, порядок и сама папка — пуджари (миграция 276)
    const можноДобавлять = () => !!window.hasPermission?.('worship_view');
    // ← → ★ ✕ у каждого снимка — только в режиме «Упорядочить»: при просмотре
    // их задевали пальцем и случайно двигали снимок или меняли обложку
    let упорядочиваем = false;

    const id = new URLSearchParams(location.search).get('id');
    let набор = null, снимки = [], ссылки = {};
    let неудачи = [];

    async function загрузить() {
        if (!id) return false;
        const [н, с] = await Promise.all([
            Layout.db.from('worship_albums').select('*').eq('id', id).maybeSingle(),
            Utils.fetchAll((от, до) => Layout.db.from('worship_images')
                .select('id, storage_path, thumb_path, caption, sort_order, shot_at, width, height')
                .eq('album_id', id).order('sort_order').order('shot_at').range(от, до)),
        ]);
        if (н.error || с.error) { Layout.handleError(н.error || с.error, 'Загрузка папки'); return false; }
        if (!н.data) { Layout.showNotification('Папка не найдена или закрыта', 'warning'); return false; }

        набор = н.data;
        снимки = с.data || [];
        await обновитьСсылки();
        return true;
    }

    /** В плитке — миниатюра, если она уже есть; оригинал — только при просмотре. */
    const плитка = с => с.thumb_path || с.storage_path;

    async function обновитьСсылки() {
        ссылки = {};
        if (!снимки.length) return;
        // запомненные ссылки: при каждом действии в папке перечитываются все
        // снимки, и без этого браузер заново качал их целиком
        ссылки = await WorshipLinks.подписать(Layout.db, снимки.map(плитка));
    }

    // ---------- миниатюры ----------
    const ПРЕДЕЛ_МИНИАТЮРЫ = 480;
    const путьМиниатюры = путь => путь.replace(/\.jpg$/i, '') + '.thumb.jpg';

    /**
     * Снимки, загруженные до миниатюр, получают их, когда папку открывает
     * пуджари: тихо, по одному, в фоне. Не вышло — плитка просто покажет
     * оригинал, как раньше.
     */
    let миниатюрыИдут = false;
    async function дописатьМиниатюры() {
        if (миниатюрыИдут || !можноДобавлять() || typeof Media === 'undefined') return;
        const без = снимки.filter(с => !с.thumb_path).slice(0, 40);
        if (!без.length) return;
        миниатюрыИдут = true;
        try {
            const адреса = await WorshipLinks.подписать(Layout.db, без.map(с => с.storage_path));
            for (const с of без) {
                try {
                    if (!адреса[с.storage_path]) continue;
                    const ответ = await fetch(адреса[с.storage_path]);
                    if (!ответ.ok) continue;
                    const кусок = await ответ.blob();
                    const мини = await Media.подготовить(new File([кусок], 'снимок.jpg', { type: кусок.type || 'image/jpeg' }),
                        { предел: ПРЕДЕЛ_МИНИАТЮРЫ, качество: 0.78 });
                    const путь = `${window.currentUser?.id}/${crypto.randomUUID()}.thumb.jpg`;
                    const { error } = await Layout.db.storage.from('worship')
                        .upload(путь, мини.тело, { contentType: 'image/jpeg' });
                    if (error) continue;
                    const { data, error: ош } = await Layout.db.rpc('worship_image_set_thumb',
                        { p_image: с.id, p_path: путь });
                    if (ош || !data?.['записано']) {
                        // кто-то успел раньше — свой лишний файл убираем
                        Layout.db.storage.from('worship').remove([путь]).then(() => {});
                        continue;
                    }
                    с.thumb_path = путь;
                } catch (ош) {
                    console.debug('миниатюра не вышла:', ош?.message);
                }
            }
        } finally {
            миниатюрыИдут = false;
        }
    }

    // ---------- отрисовка ----------
    function рисоватьШапку() {
        $('#название').textContent = набор.title;
        $('#подзаголовок').innerHTML = `
            ${Layout.pluralize(снимки.length, {
                ru: ['снимок', 'снимка', 'снимков'], en: ['photo', 'photos'], hi: 'चित्र' })}
            ${набор.is_private ? ' · <span class="text-warning font-semibold">только для отдела</span>' : ''}
            ${набор.is_guide ? ' · инструкция к стандарту' : ''}
            ${набор.is_archived ? ' · <span class="opacity-70">в архиве</span>' : ''}
            ${набор.description ? `<span class="block opacity-70 mt-1">${e(набор.description)}</span>` : ''}`;

        // На экран приходят смотреть снимки. Поэтому наверху — одно действие,
        // которым пользуются («добавить»), а редкие решения о наборе собраны
        // под «ещё»: раньше четыре равнозначные кнопки стояли в ряд, и глаз
        // не понимал, какая из них обычная работа, а какая — раскрытие отдела.
        const редкие = [];
        if (можноПисать() && !набор.is_archived) {
            редкие.push('<li><button id="правка">Изменить название и дату</button></li>');
        }
        if (можноПисать()) {
            редкие.push(`<li><button id="видимость">${
                набор.is_private ? 'Открыть всему ашраму' : 'Закрыть для отдела'}</button></li>`);
        }
        if (можноУтверждать()) {
            редкие.push(`<li><button id="архив">${
                набор.is_archived ? 'Вернуть из архива' : 'Убрать в архив'}</button></li>`);
        }

        $('#actions').innerHTML = `
            ${можноПисать() && !набор.is_archived && снимки.length
                ? `<button class="btn btn-sm ${упорядочиваем ? 'btn-active' : 'btn-outline'}" id="упорядочить">${
                    упорядочиваем ? 'Готово' : 'Править снимки'}</button>` : ''}
            ${можноДобавлять() && !набор.is_archived
                ? `<button class="btn btn-sm" id="добавить"
                        style="background: var(--current-color); color:#fff;">Добавить снимки</button>`
                : ''}
            ${редкие.length ? `
            <div class="dropdown dropdown-end">
                <button tabindex="0" class="btn btn-sm px-2 bg-base-100 border-base-300 hover:bg-base-200" aria-label="Ещё действия">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle>
                        <circle cx="12" cy="19" r="1.7"></circle>
                    </svg>
                </button>
                <ul tabindex="0" class="dropdown-content z-30 menu menu-sm p-2 shadow bg-base-100 rounded-box w-56">
                    ${редкие.join('')}
                </ul>
            </div>` : ''}`;

        // закрытый набор нельзя молча положить в стандарт или подборку —
        // об этом честно сказано здесь, а не только в момент отказа
        $('#предупреждение').hidden = !набор.is_private;
        if (набор.is_private) {
            $('#предупреждение').innerHTML =
                'Папка закрыта: её снимки видят только пуджари. Такой снимок нельзя вставить ' +
                'в стандарт, который читает весь ашрам, и нельзя выдать в подборке — ' +
                'сначала откройте папку или положите снимок в открытую.';
        }
    }

    function рисоватьСнимки() {
        $('#снимки').innerHTML = снимки.map((с, i) => `
            <figure class="группа relative rounded-xl overflow-hidden bg-base-200">
                <div class="relative aspect-square cursor-zoom-in" data-смотреть="${i}">
                    ${ссылки[плитка(с)]
                        ? `<img src="${e(ссылки[плитка(с)])}" alt="${e(с.caption)}" loading="lazy"
                                class="w-full h-full object-cover">`
                        : '<span class="text-xs opacity-50 p-2 block">снимок не загрузился</span>'}
                    <!-- внизу снимка, а не вверху: на телефоне ручки видны всегда,
                         и метка «обложка» ложилась прямо на стрелки -->
                    ${набор.cover_image_id === с.id
                        ? `<span class="absolute bottom-2 left-2 badge badge-sm bg-base-100/90 border-0">обложка</span>`
                        : ''}
                </div>

                <!-- Ручки появляются при наведении: на экран приходят смотреть,
                     как наряжали, а не переставлять кадры. Раньше под каждым
                     снимком стояли четыре кнопки и поле ввода — они занимали
                     больше места, чем сам снимок. -->
                ${можноПисать() && !набор.is_archived && упорядочиваем ? `
                <div class="ручки absolute top-2 right-2 flex gap-1" style="opacity: 1;">
                    <button class="btn btn-sm btn-circle bg-base-100/90 border-0" data-двигать="-1"
                            data-id="${с.id}" title="Левее">←</button>
                    <button class="btn btn-sm btn-circle bg-base-100/90 border-0" data-двигать="1"
                            data-id="${с.id}" title="Правее">→</button>
                    <button class="btn btn-sm btn-circle bg-base-100/90 border-0" data-обложка="${с.id}"
                            title="Сделать обложкой" ${набор.cover_image_id === с.id ? 'disabled' : ''}>★</button>
                    ${можноУтверждать() ? `<button class="btn btn-sm btn-circle bg-base-100/90 border-0 text-error"
                            data-убрать="${с.id}" title="Убрать снимок">✕</button>` : ''}
                </div>` : ''}

                <!-- Подпись есть не у каждого снимка, и приглашение «подписать»
                     под каждой плиткой складывалось в колонку одинаковых серых
                     строк. Поле появляется при наведении, пустая подпись места
                     не занимает. -->
                <figcaption class="px-1 pt-2 pb-1 ${с.caption ? '' : 'подписьПустая'}">
                    ${можноПисать() && !набор.is_archived && упорядочиваем
                        ? `<input class="w-full bg-transparent border-0 border-b border-transparent
                                        hover:border-base-300 focus:border-base-300 focus:outline-none
                                        text-sm py-0.5 px-0 placeholder:opacity-50"
                                  data-подпись="${с.id}" value="${e(с.caption)}"
                                  placeholder="Подписать" maxlength="200">`
                        // подпись целиком, в несколько строк: в одну строку
                        // «Корона: как садится…» обрывалась на полуслове
                        : `<span class="text-sm opacity-80 block leading-snug">${e(с.caption)}</span>`}
                </figcaption>
            </figure>`).join('') ||
            `<div class="bg-base-100 rounded-xl shadow-sm p-8 text-center" style="grid-column: 1 / -1;">
                <div class="font-semibold mb-1">Снимков пока нет</div>
                <p class="text-sm opacity-70">Можно выбрать сразу несколько файлов —
                    они загрузятся по очереди, с подсчётом.</p>
            </div>`;
    }

    // ---------- загрузка ----------
    async function загрузитьПачку(файлы) {
        if (!файлы.length) return;
        const предел = набор.is_guide ? Media.ПРЕДЕЛ_ИНСТРУКЦИИ : Media.ПРЕДЕЛ_СТОРОНЫ;

        $('#ход').hidden = false;
        $('#повторить').hidden = true;
        $('#ходСписок').innerHTML = '';
        неудачи = [];

        const итог = await Media.очередь(файлы, async файл => {
            const готовый = await Media.подготовить(файл, { предел });
            const путь = `${window.currentUser?.id}/${crypto.randomUUID()}.jpg`;
            const { error } = await Layout.db.storage.from('worship')
                .upload(путь, готовый.тело, { contentType: 'image/jpeg' });
            if (error) throw new Error(error.message);

            // миниатюра для плитки; не вышла — плитка покажет оригинал
            let мини = null;
            try {
                const м = await Media.подготовить(файл, { предел: ПРЕДЕЛ_МИНИАТЮРЫ, качество: 0.78 });
                const { error: ошМ } = await Layout.db.storage.from('worship')
                    .upload(путьМиниатюры(путь), м.тело, { contentType: 'image/jpeg' });
                if (!ошМ) мини = путьМиниатюры(путь);
            } catch { /* без миниатюры */ }

            const { error: ош } = await Layout.db.from('worship_images').insert({
                album_id: id,
                storage_path: путь,
                thumb_path: мини,
                caption: null,
                // первоначальный порядок — по времени съёмки, а не по тому,
                // в каком порядке человек выбрал файлы
                shot_at: готовый.снято || null,
                width: готовый.ширина,
                height: готовый.высота,
                sort_order: снимки.length,
                created_by: window.currentUser?.id || null,
            });
            if (ош) throw new Error(ош.message);
        }, {
            наШаг: ({ номер, всего, файл, состояние, ошибка }) => {
                $('#ходПодпись').textContent = `${номер} из ${всего}`;
                $('#полоса').value = Math.round((номер - (состояние === 'идёт' ? 1 : 0)) / всего * 100);
                const строка = document.createElement('li');
                строка.className = состояние === 'ошибка' ? 'text-error' : 'opacity-70';
                строка.textContent = состояние === 'ошибка'
                    ? `${файл.name} — не вышло: ${ошибка}`
                    : состояние === 'готово' ? `${файл.name} — готово` : `${файл.name}…`;
                if (состояние !== 'идёт') $('#ходСписок').appendChild(строка);
            },
        });

        неудачи = итог.неудачи.map(н => н.файл);
        $('#полоса').value = 100;
        $('#ходПодпись').textContent = неудачи.length
            ? `Загружено ${итог.удалось.length}, не вышло ${неудачи.length}`
            : `Загружено ${итог.удалось.length}`;
        $('#повторить').hidden = !неудачи.length;

        await перечитать();
        if (!неудачи.length) setTimeout(() => { $('#ход').hidden = true; }, 2500);
    }

    function пометкаСохранения(поле, текст, цвет = 'opacity-60') {
        let метка = поле.parentElement.querySelector('[data-метка]');
        if (!метка) {
            метка = document.createElement('span');
            метка.dataset.метка = '1';
            метка.className = 'block text-xs mt-0.5';
            поле.parentElement.insertBefore(метка, поле.nextSibling);
        }
        метка.className = `block text-xs mt-0.5 ${цвет}`;
        метка.textContent = текст;
    }

    async function сохранитьПодпись(поле) {
        const id = поле.dataset.подпись;
        const было = снимки.find(с => с.id === id)?.caption || '';
        const стало = поле.value.trim();
        if (было === стало) { пометкаСохранения(поле, ''); return; }

        const { error } = await Layout.db.rpc('worship_image_caption',
            { p_image: id, p_caption: стало });
        if (error) {
            пометкаСохранения(поле, 'не сохранилось', 'text-error');
            return Layout.handleError(error, 'Подпись');
        }
        const с = снимки.find(x => x.id === id);
        if (с) с.caption = стало || null;
        пометкаСохранения(поле, 'сохранено', 'text-success');
        setTimeout(() => пометкаСохранения(поле, ''), 2000);
    }

    // Подписи, которые ещё пишутся. Щелчок по «обложке» или «закрыть папку»
    // сразу после набора подписи перечитывал папку раньше, чем подпись
    // доходила до базы, — и поле показывало старый текст, будто правка пропала.
    const подписиВПути = new Set();
    const таймеры = new Map();

    function записатьПодпись(поле) {
        clearTimeout(таймеры.get(поле.dataset.подпись));
        таймеры.delete(поле.dataset.подпись);
        const путь = сохранитьПодпись(поле).finally(() => подписиВПути.delete(путь));
        подписиВПути.add(путь);
        return путь;
    }

    async function дописатьПодписи() {
        for (const id of [...таймеры.keys()]) {
            const поле = document.querySelector(`[data-подпись="${CSS.escape(id)}"]`);
            if (поле) записатьПодпись(поле);
        }
        await Promise.all([...подписиВПути]);
    }

    async function перечитать() {
        await дописатьПодписи();
        if (await загрузить()) { рисоватьШапку(); рисоватьСнимки(); window.applyPermissions?.(); }
    }

    // ---------- события ----------
    function слушать() {
        $('#файлы').addEventListener('change', async ev => {
            const файлы = [...(ev.target.files || [])];
            ev.target.value = '';
            await загрузитьПачку(файлы);
        });

        // У каждого поля свой таймер: один общий debounce гасил предыдущий,
        // и при подписывании двадцати снимков подряд выживали единицы —
        // причём молча, человек был уверен, что всё записалось.
        document.addEventListener('input', ev => {
            const поле = ev.target.closest('[data-подпись]');
            if (!поле) return;
            const id = поле.dataset.подпись;
            clearTimeout(таймеры.get(id));
            пометкаСохранения(поле, 'пишу…');
            таймеры.set(id, setTimeout(() => записатьПодпись(поле), 600));
        });
        // уход с поля сохраняет сразу: не ждать таймера, если человек уже дальше
        document.addEventListener('focusout', ev => {
            const поле = ev.target.closest('[data-подпись]');
            if (!поле) return;
            записатьПодпись(поле);
        });

        document.addEventListener('click', async ev => {
            const смотреть = ev.target.closest('[data-смотреть]');
            if (смотреть) {
                // в просмотре — оригиналы: плитки показывают миниатюры
                const оригиналы = await WorshipLinks.подписать(Layout.db, снимки.map(с => с.storage_path));
                return Media.открыть(снимки.map(с => ({
                    адрес: оригиналы[с.storage_path] || ссылки[плитка(с)], подпись: с.caption || '',
                })), Number(смотреть.dataset.смотреть));
            }

            const двигать = ev.target.closest('[data-двигать]');
            if (двигать) {
                const { error } = await Layout.db.rpc('worship_image_reorder',
                    { p_image: двигать.dataset.id, p_direction: Number(двигать.dataset.двигать) });
                if (error) return Layout.handleError(error, 'Порядок снимков');
                return перечитать();
            }

            const обложка = ev.target.closest('[data-обложка]');
            if (обложка) {
                const { error } = await Layout.db.rpc('worship_album_update',
                    { p_album: id, p_payload: { cover_image_id: обложка.dataset.обложка } });
                if (error) return Layout.handleError(error, 'Обложка');
                return перечитать();
            }

            const убрать = ev.target.closest('[data-убрать]');
            if (убрать) {
                if (!await спросить('Убрать снимок?', 'Файл удалится вместе с ним.')) return;
                const { data, error } = await Layout.db.rpc('worship_image_delete',
                    { p_image: убрать.dataset.убрать });
                if (error) return Layout.handleError(error, 'Удаление снимка');
                if (data?.путь) {
                    const файлы = [data.путь, data['миниатюра']].filter(Boolean);
                    WorshipLinks.забыть(файлы);
                    Layout.db.storage.from('worship').remove(файлы)
                        .then(({ error: ош }) => { if (ош) console.debug('файл остался:', ош.message); });
                }
                return перечитать();
            }

            const b = ev.target.closest('button');
            if (!b) return;

            if (b.id === 'добавить') return $('#файлы').click();
            if (b.id === 'упорядочить') { упорядочиваем = !упорядочиваем; рисоватьШапку(); return рисоватьСнимки(); }
            if (b.id === 'повторить') {
                const снова = неудачи;
                неудачи = [];
                return загрузитьПачку(снова);
            }
            if (b.id === 'видимость') {
                const станет = !набор.is_private;
                if (станет && !await спросить('Закрыть папку для отдела?',
                    'Её снимки перестанут видеть все, кроме пуджари.')) return;
                if (!станет && !await спросить('Открыть папку всему ашраму?',
                    'Снимки увидит каждый сотрудник, у кого есть доступ к модулю.')) return;
                const { error } = await Layout.db.rpc('worship_album_visibility',
                    { p_album: id, p_private: станет });
                if (error) return Layout.handleError(error, 'Видимость папки');
                return перечитать();
            }
            if (b.id === 'архив') {
                const { error } = await Layout.db.rpc('worship_album_update',
                    { p_album: id, p_payload: { is_archived: !набор.is_archived } });
                if (error) return Layout.handleError(error, 'Архив папки');
                return перечитать();
            }
            if (b.id === 'правка') return править();
            if (b.id === 'сохранитьПравку') return сохранитьПравку();
        });
    }

    async function править() {
        $('#правкаНазвание').value = набор.title;
        $('#правкаОписание').value = набор.description || '';
        $('#правкаИнструкция').checked = набор.is_guide;

        // связь со статьёй: ТЗ просит её, и по ней на странице стандарта
        // видно, что к нему есть набор снимков
        // архивные тоже в списке: иначе набор, привязанный к отменённому
        // стандарту, при любой правке описания тихо терял эту связь
        const { data: статьи } = await Layout.db.from('worship_articles')
            .select('id, title, status').eq('kind', 'standard')
            .in('status', ['published', 'archived']).order('title');
        $('#правкаСтатья').innerHTML = '<option value="">Ни к чему не привязан</option>' +
            (статьи || []).map(а => `<option value="${а.id}" ${
                набор.article_id === а.id ? 'selected' : ''}>${e(а.title)}${
                а.status === 'archived' ? ' (не действует)' : ''}</option>`).join('');

        $('#правкаМодал').showModal();
    }

    async function сохранитьПравку() {
        const название = $('#правкаНазвание').value.trim();
        if (!название) { Layout.showNotification('Без названия папку не найти', 'warning'); return; }

        // через функцию: политика пускает только завёдшего папку или старшего,
        // а обычный update вернул бы ноль строк без ошибки
        const { error } = await Layout.db.rpc('worship_album_update', {
            p_album: id,
            p_payload: {
                title: название,
                description: $('#правкаОписание').value.trim(),
                article_id: $('#правкаСтатья').value || '',
                is_guide: $('#правкаИнструкция').checked,
            },
        });
        if (error) return Layout.handleError(error, 'Правка папки');
        $('#правкаМодал').close();
        await перечитать();
    }

    async function init() {
        слушать();
        if (!await загрузить()) {
            document.querySelector('main').innerHTML = `
                <div class="card bg-base-100 shadow max-w-xl"><div class="card-body items-start">
                    <h1 class="card-title text-xl">Папка не найдена</h1>
                    <p class="text-sm opacity-70">Возможно, она закрыта для отдела или убрана в архив.</p>
                    <a href="gallery.html" class="btn btn-sm mt-2"
                       style="background: var(--current-color); color:#fff;">К галерее</a>
                </div></div>`;
            return;
        }
        рисоватьШапку();
        рисоватьСнимки();
        window.applyPermissions?.();
        WorshipTags.нарисовать(document.querySelector('#теги'), { album_id: id },
                               { можноПравить: можноПисать() && !набор.is_archived, правкаПоКнопке: true });
        // ссылки на снимки живут час: обновляем, пока страница открыта
        Media.держатьСсылки(async () => { await обновитьСсылки(); рисоватьСнимки(); });
        // старые снимки без миниатюр — дописываем в фоне, плитки сменятся при следующем заходе
        if (!набор.is_archived) дописатьМиниатюры();
    }

    return { init };
})();
