/**
 * Правка стандарта.
 *
 * Текст правится как обычный текст: одно поле, в котором выделяешь кусок
 * и делаешь его заголовком, списком или жирным. Никаких «блоков с ручками» —
 * отдел пишет документы, а не собирает конструктор. Отсюда и отмена работает
 * сама: поле не перерисовывается на каждое действие, поэтому Ctrl+Z обычный,
 * браузерный, тот же, что в любом текстовом поле.
 *
 * Хранится статья по-прежнему структурой (worship-doc.js), а не разметкой:
 * по ней читают статью, сравнивают версии и ищут. Перевод туда и обратно —
 * в worship-editor-doc.js.
 *
 * Автосохранение пишет в память браузера, а не в базу: иначе автосейв каждые
 * полминуты начнёт воевать с проверкой параллельной правки, и конфликт станет
 * нормой. В базу — только по кнопке.
 */
const WorshipEdit = (() => {
    const можноУтверждать = () => !!window.hasPermission?.('worship_approve');
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');

    const id = new URLSearchParams(location.search).get('id');
    let статья = null, версия = null, разделы = [];
    let базоваяОтметка = null;      // updated_at черновика на момент открытия
    let знаюСостояние = true;       // false — сознательная перезапись чужой правки
    let свои = [];                  // снимки, загруженные в эту правку
    let грязно = false, сохраняется = false;
    const ссылки = {};              // путь → адрес снимка ограниченного срока

    const поле = () => $('#текст');

    // ---------- загрузка ----------
    async function загрузить() {
        const запросы = [
            Layout.db.from('worship_sections')
                .select('id, name_ru, name_en, name_hi, is_active')
                .eq('kind', 'standard').order('sort_order'),
        ];
        if (id) {
            запросы.push(Layout.db.from('worship_articles').select('*').eq('id', id).maybeSingle());
            запросы.push(Layout.db.from('worship_versions')
                .select('*').eq('article_id', id).in('status', ['draft', 'submitted']).maybeSingle());
        }
        const ответы = await Promise.all(запросы);
        const плохой = ответы.find(о => о.error);
        if (плохой) { Layout.handleError(плохой.error, 'Загрузка'); return false; }

        разделы = ответы[0].data || [];

        if (id) {
            статья = ответы[1].data;
            if (!статья) { Layout.showNotification('Статья не найдена', 'warning'); return false; }

            версия = ответы[2].data;
            // Правку, которая ждёт решения, открывает тот, кто это решение
            // принимает: иначе ради одной запятой её пришлось бы возвращать
            // автору. Автору без права утверждения вход закрыт — двое в одной
            // редакции затирали бы друг друга, пока она на утверждении.
            if (версия?.status === 'submitted' && !можноУтверждать()) {
                Layout.showNotification('Правка отправлена старшему — сначала отзовите её', 'warning');
                setTimeout(() => location.href = `article.html?id=${id}`, 1500);
                return false;
            }

            if (!версия) {
                // правим действующий текст: он станет основой нового черновика
                const { data } = await Layout.db.from('worship_versions')
                    .select('*').eq('article_id', id).eq('status', 'published').maybeSingle();
                версия = data || null;
            }
        }

        // Пустая отметка значит «черновика не было, я правлю действующий
        // текст»: база в этом случае считает любой найденный черновик чужим.
        // Старший, открывший правку на утверждении, правит именно её —
        // иначе собственное «Утвердить» возвращало ему «черновик завёл
        // кто-то другой» и показывало его же текст.
        базоваяОтметка = версия && (версия.status === 'draft' || версия.status === 'submitted')
            ? версия.updated_at : null;
        Object.assign(ссылки, await WorshipDoc.ссылкиНаСнимки(Layout.db, версия?.doc || { blocks: [] }));
        return true;
    }

    // ---------- отрисовка формы ----------
    function рисоватьШапку() {
        $('#режим').textContent = !id ? 'Новая статья'
            : версия?.status === 'submitted' ? 'Правка, которая ждёт вашего решения'
            : статья.status === 'published' ? 'Правка действующего стандарта'
            : 'Черновик';

        // раздел может прийти в адресе — из кнопки «+ статья» в заголовке раздела
        const изАдреса = new URLSearchParams(location.search).get('section');
        const выбран = статья?.section_id || изАдреса || '';
        $('#раздел').innerHTML = '<option value="">Без раздела</option>' + разделы.map(р =>
            `<option value="${р.id}" ${выбран === р.id ? 'selected' : ''}>${
                e(Layout.getName(р))}${р.is_active ? '' : ' (скрыт)'}</option>`).join('');

        $('#заголовок').value = версия?.title || статья?.title || '';
        $('#примечание').value = версия?.status === 'draft' ? (версия.change_note || '') : '';

        // замечание старшего — перед глазами, а не на соседней странице
        const причина = версия?.status === 'draft' ? версия.return_reason : null;
        $('#возврат').hidden = !причина;
        if (причина) $('#возвратПричина').textContent = причина;

        // у первой версии не спрашиваем «что изменилось»: первое наполнение
        // не должно превращаться в полсотни согласований
        const перваяВерсия = !id || статья.status !== 'published';
        $('#картаИзменений').hidden = перваяВерсия;

        $('#удалить').hidden = !(id && статья.status === 'draft');
    }

    function наполнитьПоле(документ) {
        const т = поле();
        т.replaceChildren();
        т.appendChild(WorshipEditorDoc.вДом(документ || версия?.doc || { blocks: [] }, ссылки));
    }

    /** Документ из поля — то, что уйдёт в базу. */
    const документИзПоля = () => WorshipDoc.разобрать(WorshipEditorDoc.изДома(поле()));

    // ---------- память браузера ----------
    const ключЧерновика = () => `srsk_worship_draft_${id || 'new'}`;

    function запомнить() {
        try {
            sessionStorage.setItem(ключЧерновика(), JSON.stringify({
                когда: Date.now(),
                title: $('#заголовок').value,
                section_id: $('#раздел').value,
                change_note: $('#примечание').value,
                doc: документИзПоля(),
            }));
        } catch { /* приватный режим */ }
    }

    const запомнитьПотом = Layout.debounce(запомнить, 800);

    function забыть() {
        try { sessionStorage.removeItem(ключЧерновика()); } catch { /* приватный режим */ }
    }

    /** Несохранённое с прошлого раза: предлагаем вернуть, а не подсовываем молча. */
    async function проверитьНесохранённое() {
        let запись = null;
        try { запись = JSON.parse(sessionStorage.getItem(ключЧерновика()) || 'null'); } catch { /* */ }
        if (!запись?.doc) return;

        // сверяем документ целиком: по плоскому тексту правка оформления,
        // ссылки или подписи к фото выглядела бы как «ничего не изменилось»
        const вБазе = JSON.stringify(WorshipDoc.разобрать(версия?.doc));
        const вПамяти = JSON.stringify(WorshipDoc.разобрать(запись.doc));
        if (вБазе === вПамяти && (запись.title || '') === ($('#заголовок').value || '')) {
            забыть();
            return;
        }
        if (!await спросить('Вернуть несохранённую правку?',
            'В этом браузере осталась работа с прошлого раза.')) {
            забыть();
            return;
        }
        наполнитьПоле(запись.doc);
        $('#заголовок').value = запись.title || '';
        $('#раздел').value = запись.section_id || '';     // «без раздела» тоже выбор
        $('#примечание').value = запись.change_note || '';
        пометить();
    }

    // ---------- сохранение ----------
    /** Отметка о состоянии есть и сверху, и у нижней кнопки: длинную статью
        дописывают внизу страницы и сохраняют оттуда же. */
    function отметка(текст, класс) {
        ['#сохранение', '#сохранениеНизу'].forEach(s2 => {
            const у = $(s2);
            if (у) { у.textContent = текст; у.className = класс; }
        });
    }

    function пометить() {
        грязно = true;
        отметка('не сохранено', 'text-sm text-warning');
    }

    async function сохранить({ затем } = {}) {
        if (сохраняется) return null;
        const документ = документИзПоля();
        const заголовок = $('#заголовок').value.trim();
        if (!заголовок) {
            Layout.showNotification('Без названия статью не найти — впишите его', 'warning');
            $('#заголовок').focus();
            return null;
        }
        // пустой текст сервер и так не примет, но спросить лучше до сохранения:
        // иначе в списке остаётся заведённая впустую статья
        if (затем === 'отправить' && !WorshipDoc.текст(документ).trim()) {
            Layout.showNotification('Сначала напишите текст стандарта', 'warning');
            поле().focus();
            return null;
        }

        const нужноПримечание = id && статья.status === 'published';
        const примечание = $('#примечание').value.trim();
        if (нужноПримечание && затем === 'отправить' && !примечание) {
            Layout.showNotification('Напишите одной строкой, что изменилось', 'warning');
            $('#примечание').focus();
            return null;
        }

        сохраняется = true;
        кнопкиЗаняты(true);
        отметка('сохраняю…', 'text-sm opacity-70');

        const полезное = {
            article_id: id || null,
            section_id: $('#раздел').value || null,
            title: заголовок,
            doc: документ,
            plain_text: WorshipDoc.текст(документ),
            change_note: примечание || (нужноПримечание ? null : 'первая редакция'),
            base_updated_at: базоваяОтметка,
            base_known: знаюСостояние,
        };

        const { data, error } = await Layout.db.rpc('worship_save_draft', { payload: полезное });
        сохраняется = false;
        кнопкиЗаняты(false);
        // осознанная перезапись действует ровно на одно сохранение: иначе после
        // неудачной попытки защита от чужой правки осталась бы выключенной
        const былаПерезапись = !знаюСостояние;
        знаюСостояние = true;

        if (error) {
            отметка('не сохранено', 'text-sm text-error');
            Layout.handleError(error, 'Сохранение');
            return null;
        }
        if (data?.конфликт) {
            отметка('не сохранено', 'text-sm text-error');
            показатьКонфликт(data['чужая_версия'], data['сообщение']);
            return null;
        }
        if (былаПерезапись) $('#конфликт').hidden = true;

        базоваяОтметка = data.updated_at;
        грязно = false;
        свои = [];
        забыть();
        отметка('сохранено', 'text-sm text-success');
        return data;
    }

    function кнопкиЗаняты(занято) {
        ['#сохранить', '#отправить', '#перезаписать',
         '#сохранитьНизу', '#отправитьНизу'].forEach(s => {
            const б = $(s);
            if (б) б.disabled = занято;
        });
    }

    function показатьКонфликт(чужая, сообщение) {
        $('#конфликт').hidden = false;
        document.querySelector('#конфликт .font-bold').textContent =
            сообщение || 'Пока вы писали, черновик изменил кто-то другой';
        // имя стоит в самом заголовке, здесь остаётся время и начало чужого
        // текста: иначе непонятно, что написано вместо твоего
        const кусок = (чужая.текст || '').trim().slice(0, 300);
        $('#конфликтТекст').innerHTML = `
            Сохранено ${DateUtils.formatDateTime(new Date(чужая.обновлена))}.
            ${кусок ? `<span class="block mt-2 p-2 rounded bg-base-100 text-sm">${
                e(кусок)}${(чужая.текст || '').length > 300 ? '…' : ''}</span>` : ''}
            <span class="block mt-2">Откройте чужую правку в соседней вкладке и перенесите своё,
            либо сохраните поверх — тогда чужая работа пропадёт.</span>`;
    }

    // ---------- оформление выделенного ----------
    /**
     * Всё оформление идёт через execCommand. Он давно объявлен устаревшим,
     * но это единственный способ менять текст так, чтобы правка попала
     * в историю браузера — то есть чтобы работал Ctrl+Z. Своя история
     * означала бы свою перерисовку, а это ровно то, от чего мы ушли.
     */

    /**
     * Где стоял курсор в тексте. Любое окно — ссылка, выбор снимка, вопрос —
     * забирает фокус, и выделение гаснет: дальше execCommand применялся
     * к началу поля, и вставка уходила в первый абзац вместо выбранного места.
     */
    let последнийДиапазон = null;

    function вПоле(узел) {
        const эл = узел?.nodeType === 1 ? узел : узел?.parentElement;
        return !!эл && !!поле() && поле().contains(эл);
    }

    function следитьЗаКурсором() {
        document.addEventListener('selectionchange', () => {
            const в = getSelection();
            if (!в || !в.rangeCount) return;
            const д = в.getRangeAt(0);
            if (вПоле(д.commonAncestorContainer)) последнийДиапазон = д.cloneRange();
        });
    }

    /** Вернуть курсор туда, где он был до окна. */
    function вернутьсяВПоле() {
        const п = поле();
        if (!п) return;
        п.focus();
        const в = getSelection();
        if (в.rangeCount && вПоле(в.getRangeAt(0).commonAncestorContainer)) return;
        if (!последнийДиапазон) return;
        в.removeAllRanges();
        в.addRange(последнийДиапазон);
    }

    function команда(имя, значение = null) {
        вернутьсяВПоле();
        document.execCommand(имя, false, значение);
        пометить();
        запомнитьПотом();
    }

    /** Блок под курсором — чтобы кнопка показывала, что уже применено. */
    function текущийТег() {
        let узел = getSelection()?.anchorNode;
        while (узел && узел !== поле()) {
            if (узел.nodeType === Node.ELEMENT_NODE) {
                const имя = узел.tagName.toLowerCase();
                if (['h1', 'h2', 'h3', 'h4', 'blockquote', 'li', 'p', 'figure'].includes(имя)) return имя;
            }
            узел = узел.parentNode;
        }
        return 'p';
    }

    function обновитьПанель() {
        const внутри = поле().contains(getSelection()?.anchorNode);
        const тег = текущийТег();
        const нажата = (кнопка, условие) => кнопка?.classList.toggle('btn-active', !!(внутри && условие));

        document.querySelectorAll('[data-стиль]').forEach(б => {
            const свой = б.dataset.стиль;
            нажата(б,
                (свой === 'h2' && (тег === 'h2' || тег === 'h1')) ||
                (свой === 'h3' && (тег === 'h3' || тег === 'h4')) ||
                (свой === 'note' && тег === 'blockquote'));
        });
        try {
            нажата($('#жирный'), document.queryCommandState('bold'));
            нажата($('#список'), document.queryCommandState('insertUnorderedList'));
            нажата($('#поШагам'), document.queryCommandState('insertOrderedList'));
        } catch { /* старый браузер */ }
    }

    /** Заголовок, подзаголовок, заметка, обычный абзац — один и тот же приём. */
    function стиль(какой) {
        const теги = { p: 'P', h2: 'H2', h3: 'H3', note: 'BLOCKQUOTE' };
        const сейчас = текущийТег();
        // повторное нажатие снимает оформление: иначе из заголовка не выбраться,
        // не догадавшись, что надо нажать «Абзац»
        const снять = (какой === 'h2' && (сейчас === 'h2' || сейчас === 'h1'))
            || (какой === 'h3' && (сейчас === 'h3' || сейчас === 'h4'))
            || (какой === 'note' && сейчас === 'blockquote');
        команда('formatBlock', `<${снять ? 'P' : теги[какой]}>`);

        // заметке нужен свой вид: класс execCommand не ставит
        if (!снять && какой === 'note') {
            const узел = getSelection()?.anchorNode;
            const цитата = (узел?.nodeType === 1 ? узел : узел?.parentElement)?.closest('blockquote');
            цитата?.classList.add('worship-заметка');
        }
        обновитьПанель();
    }

    /**
     * Окно ввода забирает фокус, и выделение в тексте пропадает: дальше
     * execCommand применялся к пустому курсору в начале поля, и ссылка
     * вставлялась не на выделенное слово, а в первый абзац. Поэтому
     * выделение запоминаем до окна и возвращаем перед командой.
     */
    async function поставитьСсылку() {
        const выделение = getSelection();
        if (!выделение.rangeCount || выделение.isCollapsed) {
            Layout.showNotification('Выделите слова, которые станут ссылкой', 'info');
            return;
        }
        const диапазон = выделение.getRangeAt(0).cloneRange();

        const куда = await спроситьСтроку({
            заголовок: 'Ссылка',
            подсказка: 'https://… или имя страницы модуля, например article.html?id=…' });
        if (!куда) return;
        const чистый = WorshipDoc.адрес(куда);
        if (!чистый) { Layout.showNotification('Такой адрес не годится', 'warning'); return; }

        последнийДиапазон = диапазон;
        команда('createLink', чистый);
    }

    // ---------- вставка готового текста ----------
    /**
     * Делит вставленный текст на абзацы, заголовки и пункты списка.
     * Это не разметка на все случаи, а то, что встречается в документах отдела:
     * короткая строка без точки на конце — заголовок, «1.» или «—» — пункт.
     */
    function разобратьВставку(текст) {
        const строки = String(текст || '').replace(/\r/g, '').split('\n')
            .map(с => с.replace(/\s+/g, ' ').trim());
        const куски = [];

        строки.forEach(строка => {
            if (!строка) { куски.push(null); return; }      // пустая строка — граница

            const нумерованный = /^(\d{1,2})[.)]\s+(.+)$/.exec(строка);
            const маркер = /^[-–—•*]\s+(.+)$/.exec(строка);
            const прошлый = куски[куски.length - 1];

            if (нумерованный || маркер) {
                const тип = нумерованный ? 'ol' : 'ul';
                const текстПункта = (нумерованный ? нумерованный[2] : маркер[1]).trim();
                if (прошлый && прошлый.type === тип) прошлый.items.push(текстПункта);
                else куски.push({ type: тип, items: [текстПункта] });
                return;
            }

            // короткая строка без завершающей точки — обычно заголовок
            if (строка.length <= 60 && !/[.!?:;,]$/.test(строка)) {
                куски.push({ type: 'h2', text: строка });
                return;
            }

            if (прошлый && прошлый.type === 'p') прошлый.text += ' ' + строка;
            else куски.push({ type: 'p', text: строка });
        });

        return куски.filter(Boolean);
    }

    /** Вставка приходит текстом: чужая вёрстка из Word в документ не едет. */
    function вставить(текст) {
        const куски = разобратьВставку(текст);
        if (!куски.length) return;

        if (куски.length === 1 && куски[0].type === 'p') {
            команда('insertText', куски[0].text);
            return;
        }

        const разметка = куски.map(к => {
            if (к.items) {
                return `<${к.type}>${к.items.map(т => `<li>${e(т)}</li>`).join('')}</${к.type}>`;
            }
            const тег = к.type === 'h2' ? 'h2' : 'p';
            return `<${тег}>${e(к.text)}</${тег}>`;
        }).join('');
        команда('insertHTML', разметка);
    }

    // ---------- снимки ----------
    async function загрузитьСнимок(файл) {
        // подготовка общая на весь проект: поворот из файла, уменьшение, время съёмки
        let готовый;
        try { готовый = await Media.подготовить(файл); }
        catch (ош) { Layout.showNotification(ош.message, 'error'); return; }

        const uid = window.currentUser?.id;
        const путь = `${uid}/${crypto.randomUUID()}.jpg`;
        const { error } = await Layout.db.storage.from('worship')
            .upload(путь, готовый.тело, { contentType: 'image/jpeg' });
        if (error) { Layout.handleError(error, 'Загрузка фото'); return; }

        const { data } = await Layout.db.storage.from('worship').createSignedUrl(путь, 3600);
        if (!data?.signedUrl) {
            Layout.showNotification('Фото загрузилось, но не показывается — обновите страницу', 'warning');
        }
        ссылки[путь] = data?.signedUrl || '';
        свои.push(путь);
        вставитьФото(путь);
    }

    /** Фото встаёт туда, где стоит курсор, и попадает в историю отмены. */
    function вставитьФото(путь) {
        const адрес = ссылки[путь] || '';
        команда('insertHTML',
            `<figure class="worship-фото my-3" data-path="${e(путь)}">` +
            `<img src="${e(адрес)}" class="rounded-lg max-w-full max-h-96" contenteditable="false">` +
            '<figcaption class="text-sm opacity-70 mt-1" data-подпись="1">Подпись к фото</figcaption>' +
            '</figure><p><br></p>');
    }

    async function открытьГалерею() {
        const { data: наборы, error } = await Layout.db.from('worship_albums')
            .select('id, title, is_private, is_archived')
            .eq('is_archived', false).order('title');
        if (error) return Layout.handleError(error, 'Галерея');
        if (!наборы?.length) return Layout.showNotification('Папок со снимками пока нет', 'info');

        $('#выборНабора').innerHTML = наборы.map(н =>
            `<option value="${н.id}">${e(н.title)}${
                н.is_private ? ' — закрытая' : ''}</option>`).join('');

        const показать = async () => {
            const н = наборы.find(x => x.id === $('#выборНабора').value);
            const окно = $('#снимкиНабора');
            if (!н) return;

            const { data: снимки } = await Layout.db.from('worship_images')
                .select('id, storage_path, caption').eq('album_id', н.id)
                .order('sort_order').order('shot_at');
            if (!снимки?.length) {
                окно.innerHTML = '<div class="col-span-full text-sm opacity-60 py-4">В наборе пока нет снимков</div>';
                return;
            }

            const { data: адреса } = await Layout.db.storage.from('worship')
                .createSignedUrls(снимки.map(с => с.storage_path), 1800);
            const карта = Object.fromEntries((адреса || [])
                .filter(а => а.signedUrl).map(а => [а.path, а.signedUrl]));

            окно.innerHTML = снимки.map(с => `
                <button class="relative aspect-square rounded-lg overflow-hidden bg-base-200
                               ${н.is_private ? 'opacity-60 cursor-not-allowed' : 'hover:ring-2'}"
                        data-взятьСнимок="${с.storage_path}" ${н.is_private ? 'disabled' : ''}
                        title="${e(с.caption || '')}">
                    ${карта[с.storage_path]
                        ? `<img src="${карта[с.storage_path]}" alt="${e(с.caption || '')}"
                                class="w-full h-full object-cover">` : ''}
                </button>`).join('') + (н.is_private ? `
                <div class="col-span-full text-sm text-warning mt-2">
                    Набор закрыт для отдела. Чтобы вставить снимок в стандарт, откройте набор
                    на его странице — или положите этот кадр в открытый набор.
                </div>` : '');
        };

        $('#выборНабора').onchange = показать;
        await показать();
        $('#галереяМодал').showModal();
    }

    async function взятьИзГалереи(путь) {
        // проверяем ещё раз на сервере: набор могли закрыть, пока окно открыто
        const { data: можно, error } = await Layout.db.rpc('worship_image_is_open', { p_path: путь });
        if (error) return Layout.handleError(error, 'Снимок');
        if (!можно) {
            return Layout.showNotification(
                'Этот набор закрыт: снимок нельзя вставить в стандарт, который читают все', 'warning');
        }

        const { data } = await Layout.db.storage.from('worship').createSignedUrl(путь, 3600);
        ссылки[путь] = data?.signedUrl || '';
        $('#галереяМодал').close();
        вставитьФото(путь);
    }

    // ---------- события ----------
    function слушать() {
        const т = поле();

        т.addEventListener('input', () => { пометить(); запомнитьПотом(); });
        т.addEventListener('keyup', обновитьПанель);
        т.addEventListener('mouseup', обновитьПанель);
        document.addEventListener('selectionchange', () => {
            if (поле().contains(getSelection()?.anchorNode)) обновитьПанель();
        });

        т.addEventListener('paste', ev => {
            ev.preventDefault();
            const текст = (ev.clipboardData || window.clipboardData).getData('text/plain');
            вставить(текст);
        });

        // Enter в конце заголовка или заметки возвращает к обычному абзацу:
        // иначе вся статья оказывается заголовком, и непонятно почему
        т.addEventListener('keydown', ev => {
            if (ev.key !== 'Enter' || ev.shiftKey) return;
            const тег = текущийТег();
            if (!['h1', 'h2', 'h3', 'h4', 'blockquote'].includes(тег)) return;

            const выделение = getSelection();
            const узел = выделение?.anchorNode;
            const блок = (узел?.nodeType === 1 ? узел : узел?.parentElement)
                ?.closest('h1,h2,h3,h4,blockquote');
            // только в конце строки: посреди заголовка Enter должен делить его,
            // как в любом редакторе
            if (!блок || !выделение.isCollapsed) return;
            const всего = (блок.textContent || '').length;
            if (выделение.anchorOffset < всего) return;

            ev.preventDefault();
            команда('insertHTML', '<p><br></p>');
        });

        document.querySelectorAll('[data-стиль]').forEach(б =>
            б.addEventListener('click', () => стиль(б.dataset.стиль)));

        $('#жирный').addEventListener('click', () => { команда('bold'); обновитьПанель(); });
        $('#список').addEventListener('click', () => { команда('insertUnorderedList'); обновитьПанель(); });
        $('#поШагам').addEventListener('click', () => { команда('insertOrderedList'); обновитьПанель(); });
        $('#ссылка').addEventListener('click', поставитьСсылку);
        $('#убратьОформление').addEventListener('click', () => { команда('removeFormat'); обновитьПанель(); });
        $('#откатить').addEventListener('click', () => команда('undo'));
        $('#повторить').addEventListener('click', () => команда('redo'));

        $('#фотоФайл').addEventListener('click', () => $('#файл').click());
        $('#фотоГалерея').addEventListener('click', открытьГалерею);

        $('#снимкиНабора').addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-взятьСнимок]');
            if (кнопка) взятьИзГалереи(кнопка.getAttribute('data-взятьСнимок'));
        });

        $('#файл').addEventListener('change', async ev => {
            const файл = ev.target.files?.[0];
            ev.target.value = '';
            if (файл) await загрузитьСнимок(файл);
        });

        // без этого Chrome снимает жирный не тегом, а <span style>, которого
        // перевод в документ не понимает, и оформление «не снимается»
        try { document.execCommand('styleWithCSS', false, false); } catch { /* старый браузер */ }
        // абзацы обычными <p>, а не <div>: так разметка ближе к документу
        try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* */ }

        ['#заголовок', '#раздел', '#примечание'].forEach(s =>
            $(s).addEventListener('input', () => { пометить(); запомнитьПотом(); }));

        const сохранитьИПерейти = async () => {
            const ответ = await сохранить({});
            if (ответ && !id) location.replace(`edit.html?id=${ответ.article_id}`);
        };
        $('#сохранить').addEventListener('click', сохранитьИПерейти);
        $('#сохранитьНизу').addEventListener('click', сохранитьИПерейти);

        $('#отправить').addEventListener('click', отправитьИлиУтвердить);
        $('#отправитьНизу').addEventListener('click', отправитьИлиУтвердить);
        $('#отмена').addEventListener('click', отменить);
        $('#удалить').addEventListener('click', удалить);

        $('#перезаписать').addEventListener('click', async () => {
            if (!await спросить('Сохранить своё поверх?',
                'Чужая правка пропадёт без возможности вернуть.')) return;
            знаюСостояние = false;              // сознательная перезапись
            $('#конфликт').hidden = true;
            await сохранить({});
        });
        // чужой черновик живёт в редакторе: на странице статьи его не показывают
        $('#открытьЧужое').addEventListener('click', () => window.open(`edit.html?id=${id}`, '_blank'));

        addEventListener('beforeunload', ev => {
            if (!грязно) return;
            ev.preventDefault();
            ev.returnValue = '';
        });
    }

    /** Старший правит присланную редакцию и утверждает её сам, не гоняя автора. */
    const правимОтправленную = () => версия?.status === 'submitted' && можноУтверждать();

    function подписатьГлавнуюКнопку() {
        if (!правимОтправленную()) return;
        ['#отправить', '#отправитьНизу'].forEach(s2 => {
            const б = $(s2);
            if (б) б.textContent = 'Утвердить';
        });
    }

    async function отправитьИлиУтвердить() {
        if (!правимОтправленную()) return отправить();

        if (!await спросить('Утвердить правку?',
            'С этого момента по этому тексту служат в храме. Ваши изменения сохранятся в неё.')) return;
        const ответ = await сохранить({});
        if (!ответ) return;
        const { data, error } = await Layout.db.rpc('worship_approve', { p_article: ответ.article_id });
        if (error) return Layout.handleError(error, 'Утверждение');
        грязно = false;
        Layout.showNotification(data?.повтор ? 'Уже утверждено' : `Утверждено, версия ${data?.номер}`, 'success');
        location.href = `article.html?id=${ответ.article_id}`;
    }

    async function отправить() {
        const ответ = await сохранить({ затем: 'отправить' });
        if (!ответ) return;
        const статьяId = ответ.article_id;
        const { error } = await Layout.db.rpc('worship_submit', { p_article: статьяId });
        if (error) return Layout.handleError(error, 'Отправка');
        грязно = false;
        Layout.showNotification('Отправлено старшему', 'success');
        location.href = `article.html?id=${статьяId}`;
    }

    async function отменить() {
        if (грязно && !await спросить('Выйти без сохранения?',
            'Написанное после последнего сохранения пропадёт.')) return;
        грязно = false;
        забыть();
        location.href = id ? `article.html?id=${id}` : 'standards.html';
    }

    async function удалить() {
        if (!await спросить('Удалить черновик?',
            'Эта статья никогда не действовала, восстановить будет нечем.')) return;
        const { error } = await Layout.db.rpc('worship_delete_draft', { p_article: id });
        if (error) return Layout.handleError(error, 'Удаление черновика');
        грязно = false;
        забыть();
        Layout.showNotification('Черновик удалён', 'success');
        location.href = 'standards.html';
    }

    async function init() {
        if (!window.hasPermission?.('worship_write')) {
            Layout.showNotification('Править стандарты может пуджари', 'warning');
            setTimeout(() => location.href = 'standards.html', 1200);
            return;
        }
        // ссылка может вести в никуда: не оставляем человека наедине с пустой формой
        if (!await загрузить()) {
            setTimeout(() => location.href = 'standards.html', 1500);
            return;
        }
        рисоватьШапку();
        наполнитьПоле();
        слушать();
        следитьЗаКурсором();
        обновитьПанель();
        // теги ставятся прямо при написании: у новой статьи — после первого
        // сохранения, когда страница перезагрузится уже с номером
        if (id) {
            $('#тегиБлок').hidden = false;
            WorshipTags.нарисовать($('#теги'), { article_id: id }, { можноПравить: true });
        }
        отметка('', 'text-sm');
        подписатьГлавнуюКнопку();
        // после проверки — не чистим: если несохранённое вернули, человек
        // должен видеть «не сохранено», иначе решит, что всё уже в базе
        проверитьНесохранённое();
    }

    return { init };
})();
