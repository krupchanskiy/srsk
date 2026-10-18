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

    const id = new URLSearchParams(location.search).get('id');
    let набор = null, снимки = [], ссылки = {};
    let неудачи = [];

    async function загрузить() {
        if (!id) return false;
        const [н, с] = await Promise.all([
            Layout.db.from('worship_albums').select('*').eq('id', id).maybeSingle(),
            Utils.fetchAll((от, до) => Layout.db.from('worship_images')
                .select('id, storage_path, caption, sort_order, shot_at, width, height')
                .eq('album_id', id).order('sort_order').order('shot_at').range(от, до)),
        ]);
        if (н.error || с.error) { Layout.handleError(н.error || с.error, 'Загрузка набора'); return false; }
        if (!н.data) { Layout.showNotification('Набор не найден или закрыт', 'warning'); return false; }

        набор = н.data;
        снимки = с.data || [];
        await обновитьСсылки();
        return true;
    }

    async function обновитьСсылки() {
        ссылки = {};
        if (!снимки.length) return;
        const { data } = await Layout.db.storage.from('worship')
            .createSignedUrls(снимки.map(с => с.storage_path), 3600);
        (data || []).forEach(з => { if (з.signedUrl) ссылки[з.path] = з.signedUrl; });
    }

    // ---------- отрисовка ----------
    function рисоватьШапку() {
        $('#название').textContent = набор.title;
        $('#подзаголовок').innerHTML = `
            ${DateUtils.formatShort(DateUtils.parseDate(набор.event_date))}
            · ${Layout.pluralize(снимки.length, {
                ru: ['снимок', 'снимка', 'снимков'], en: ['photo', 'photos'], hi: 'चित्र' })}
            ${набор.is_private ? ' · <span class="text-warning font-semibold">только для отдела</span>' : ''}
            ${набор.is_guide ? ' · инструкция к стандарту' : ''}
            ${набор.is_archived ? ' · <span class="opacity-70">в архиве</span>' : ''}
            ${набор.description ? `<span class="block opacity-70 mt-1">${e(набор.description)}</span>` : ''}`;

        const кнопки = [];
        if (можноПисать() && !набор.is_archived) {
            кнопки.push(`<button class="btn btn-sm" id="добавить"
                style="background: var(--current-color); color:#fff;">Добавить снимки</button>`);
            кнопки.push('<button class="btn btn-sm btn-outline" id="правка">Изменить набор</button>');
        }
        if (можноПисать()) {
            кнопки.push(`<button class="btn btn-sm btn-ghost" id="видимость">${
                набор.is_private ? 'Открыть ашраму' : 'Закрыть для отдела'}</button>`);
        }
        if (можноУтверждать()) {
            кнопки.push(`<button class="btn btn-sm btn-ghost" id="архив">${
                набор.is_archived ? 'Вернуть из архива' : 'В архив'}</button>`);
        }
        $('#actions').innerHTML = кнопки.join('');

        // закрытый набор нельзя молча положить в стандарт или подборку —
        // об этом честно сказано здесь, а не только в момент отказа
        $('#предупреждение').hidden = !набор.is_private;
        if (набор.is_private) {
            $('#предупреждение').innerHTML =
                'Набор закрыт: его снимки видят только пуджари. Такой снимок нельзя вставить ' +
                'в стандарт, который читает весь ашрам, и нельзя выдать в подборке — ' +
                'сначала откройте набор или положите снимок в открытый.';
        }
    }

    function рисоватьСнимки() {
        $('#снимки').innerHTML = снимки.map((с, i) => `
            <figure class="card bg-base-100 shadow overflow-hidden">
                <div class="aspect-square bg-base-200 cursor-zoom-in" data-смотреть="${i}">
                    ${ссылки[с.storage_path]
                        ? `<img src="${ссылки[с.storage_path]}" alt="${e(с.caption)}" loading="lazy"
                                class="w-full h-full object-cover">`
                        : '<span class="text-xs opacity-50 p-2 block">снимок не загрузился</span>'}
                </div>
                <figcaption class="p-2">
                    ${можноПисать() && !набор.is_archived
                        ? `<input class="input input-xs input-bordered w-full" data-подпись="${с.id}"
                                  value="${e(с.caption)}" placeholder="Подпись" maxlength="200">`
                        : `<span class="text-sm opacity-70">${e(с.caption)}</span>`}
                    ${можноПисать() && !набор.is_archived ? `
                    <div class="flex flex-wrap gap-1 mt-1">
                        <button class="btn btn-ghost btn-sm px-2" data-двигать="-1" data-id="${с.id}"
                                title="Левее">←</button>
                        <button class="btn btn-ghost btn-sm px-2" data-двигать="1" data-id="${с.id}"
                                title="Правее">→</button>
                        <button class="btn btn-ghost btn-sm px-2" data-обложка="${с.id}"
                                title="Сделать обложкой"
                                ${набор.cover_image_id === с.id ? 'disabled' : ''}>★</button>
                        <button class="btn btn-ghost btn-sm px-2 text-error" data-убрать="${с.id}"
                                title="Убрать снимок">✕</button>
                    </div>` : ''}
                </figcaption>
            </figure>`).join('') ||
            `<div class="desktop:col-span-4 card bg-base-100 shadow"><div class="card-body items-start">
                <h2 class="card-title text-lg">Снимков пока нет</h2>
                <p class="text-sm opacity-70">Можно выбрать сразу несколько файлов —
                    они загрузятся по очереди, с подсчётом.</p>
            </div></div>`;
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

            const { error: ош } = await Layout.db.from('worship_images').insert({
                album_id: id,
                storage_path: путь,
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

    async function перечитать() {
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
        const таймеры = new Map();
        document.addEventListener('input', ev => {
            const поле = ev.target.closest('[data-подпись]');
            if (!поле) return;
            const id = поле.dataset.подпись;
            clearTimeout(таймеры.get(id));
            пометкаСохранения(поле, 'пишу…');
            таймеры.set(id, setTimeout(() => сохранитьПодпись(поле), 600));
        });
        // уход с поля сохраняет сразу: не ждать таймера, если человек уже дальше
        document.addEventListener('focusout', ev => {
            const поле = ev.target.closest('[data-подпись]');
            if (!поле) return;
            clearTimeout(таймеры.get(поле.dataset.подпись));
            сохранитьПодпись(поле);
        });

        document.addEventListener('click', async ev => {
            const смотреть = ev.target.closest('[data-смотреть]');
            if (смотреть) {
                return Media.открыть(снимки.map(с => ({
                    адрес: ссылки[с.storage_path], подпись: с.caption || '',
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
                if (!confirm('Убрать снимок? Файл тоже удалится.')) return;
                const { data, error } = await Layout.db.rpc('worship_image_delete',
                    { p_image: убрать.dataset.убрать });
                if (error) return Layout.handleError(error, 'Удаление снимка');
                if (data?.путь) {
                    Layout.db.storage.from('worship').remove([data.путь])
                        .then(({ error: ош }) => { if (ош) console.debug('файл остался:', ош.message); });
                }
                return перечитать();
            }

            const b = ev.target.closest('button');
            if (!b) return;

            if (b.id === 'добавить') return $('#файлы').click();
            if (b.id === 'повторить') {
                const снова = неудачи;
                неудачи = [];
                return загрузитьПачку(снова);
            }
            if (b.id === 'видимость') {
                const станет = !набор.is_private;
                if (станет && !confirm('Закрыть набор? Его снимки перестанут видеть все, кроме отдела.')) return;
                if (!станет && !confirm('Открыть набор всему ашраму?')) return;
                const { error } = await Layout.db.rpc('worship_album_visibility',
                    { p_album: id, p_private: станет });
                if (error) return Layout.handleError(error, 'Видимость набора');
                return перечитать();
            }
            if (b.id === 'архив') {
                const { error } = await Layout.db.rpc('worship_album_update',
                    { p_album: id, p_payload: { is_archived: !набор.is_archived } });
                if (error) return Layout.handleError(error, 'Архив набора');
                return перечитать();
            }
            if (b.id === 'правка') return править();
            if (b.id === 'сохранитьПравку') return сохранитьПравку();
        });
    }

    async function править() {
        $('#правкаНазвание').value = набор.title;
        $('#правкаДата').value = набор.event_date;
        $('#правкаОписание').value = набор.description || '';
        $('#правкаИнструкция').checked = набор.is_guide;

        // связь со статьёй: ТЗ просит её, и по ней на странице стандарта
        // видно, что к нему есть набор снимков
        const { data: статьи } = await Layout.db.from('worship_articles')
            .select('id, title').eq('kind', 'standard').eq('status', 'published').order('title');
        $('#правкаСтатья').innerHTML = '<option value="">Ни к чему не привязан</option>' +
            (статьи || []).map(а => `<option value="${а.id}" ${
                набор.article_id === а.id ? 'selected' : ''}>${e(а.title)}</option>`).join('');

        $('#правкаМодал').showModal();
    }

    async function сохранитьПравку() {
        const название = $('#правкаНазвание').value.trim();
        const дата = $('#правкаДата').value;
        if (!название) { Layout.showNotification('Без названия набор не найти', 'warning'); return; }
        if (!дата) { Layout.showNotification('Поставьте дату события', 'warning'); return; }

        // через функцию: политика пускает только завёдшего набор или старшего,
        // а обычный update вернул бы ноль строк без ошибки
        const { error } = await Layout.db.rpc('worship_album_update', {
            p_album: id,
            p_payload: {
                title: название,
                event_date: дата,
                description: $('#правкаОписание').value.trim(),
                article_id: $('#правкаСтатья').value || '',
                is_guide: $('#правкаИнструкция').checked,
            },
        });
        if (error) return Layout.handleError(error, 'Правка набора');
        $('#правкаМодал').close();
        await перечитать();
    }

    async function init() {
        слушать();
        if (!await загрузить()) {
            document.querySelector('main').innerHTML = `
                <div class="card bg-base-100 shadow max-w-xl"><div class="card-body items-start">
                    <h1 class="card-title text-xl">Набор не найден</h1>
                    <p class="text-sm opacity-70">Возможно, он закрыт для отдела или убран в архив.</p>
                    <a href="gallery.html" class="btn btn-sm mt-2"
                       style="background: var(--current-color); color:#fff;">К галерее</a>
                </div></div>`;
            return;
        }
        рисоватьШапку();
        рисоватьСнимки();
        window.applyPermissions?.();
        WorshipTags.нарисовать(document.querySelector('#теги'), { album_id: id },
                               { можноПравить: можноПисать() && !набор.is_archived });
        // ссылки на снимки живут час: обновляем, пока страница открыта
        Media.держатьСсылки(async () => { await обновитьСсылки(); рисоватьСнимки(); });
    }

    return { init };
})();
