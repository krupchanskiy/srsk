/**
 * Правка статьи.
 *
 * Редактор блочный, а не «одно большое поле»: текст хранится структурой
 * (см. worship-doc.js), и собирать её из общего contenteditable пришлось бы
 * разбором HTML — ровно того, чего формат и избегает. Здесь каждый блок
 * редактируется отдельно и сериализуется в свой тип напрямую.
 *
 * Автосохранение пишет в память браузера, а не в базу: иначе автосейв каждые
 * полминуты начнёт воевать с проверкой параллельной правки, и конфликт станет
 * нормой. В базу — только по кнопке.
 */
const WorshipEdit = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');

    const id = new URLSearchParams(location.search).get('id');
    let статья = null, версия = null, разделы = [];
    let блоки = [];                 // рабочая копия документа
    let базоваяОтметка = null;      // updated_at черновика на момент открытия
    let знаюСостояние = true;       // false — сознательная перезапись чужой правки
    let свои = [];                  // снимки, загруженные в эту правку
    let грязно = false, сохраняется = false;
    const ссылки = {};              // путь → адрес снимка ограниченного срока

    const ПОДСКАЗКИ = {
        p: 'Текст абзаца',
        h2: 'Заголовок',
        h3: 'Подзаголовок',
        note: 'Короткая заметка: что делать, если пошло не так',
    };
    const НАЗВАНИЯ = {
        p: 'Абзац', h2: 'Заголовок', h3: 'Подзаголовок',
        ul: 'Список', ol: 'По шагам', note: 'Заметка', img: 'Фото',
    };

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
            if (версия?.status === 'submitted') {
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

        const документ = WorshipDoc.разобрать(версия?.doc);
        блоки = (документ.blocks.length ? документ.blocks : WorshipDoc.пустой().blocks)
            .map(б => ({ ...б, метка: ++счётчикМеток }));
        базоваяОтметка = версия?.status === 'draft' ? версия.updated_at : null;
        Object.assign(ссылки, await WorshipDoc.ссылкиНаСнимки(Layout.db, { blocks: блоки }));
        return true;
    }

    // ---------- отрисовка формы ----------
    function рисоватьШапку() {
        $('#режим').textContent = !id ? 'Новая статья'
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

    /** Разметка одного блока. Текст вставляется узлами, а не строкой. */
    function нарисоватьБлок(б, i) {
        const обёртка = document.createElement('div');
        обёртка.className = 'блок group border-l-2 border-transparent hover:border-base-300 pl-3 -ml-3 py-1';
        обёртка.dataset.i = i;

        const ручки = document.createElement('div');
        ручки.className = 'ручки flex flex-wrap items-center gap-1 mb-1 transition-opacity ' +
            'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';
        // тип блока меняется на месте: иначе перенос готового документа
        // превращается в перепечатывание каждого заголовка и пункта
        const выбор = б.type === 'img' ? '' : `
            <select class="select select-xs select-bordered" data-тип>
                ${Object.entries(НАЗВАНИЯ).filter(([т]) => т !== 'img').map(([т, имя]) =>
                    `<option value="${т}" ${т === б.type ? 'selected' : ''}>${имя}</option>`).join('')}
            </select>`;
        ручки.innerHTML = `
            ${выбор || `<span class="text-[11px] uppercase tracking-widest opacity-40 mr-1">${
                НАЗВАНИЯ[б.type]}</span>`}
            <button class="btn btn-ghost btn-sm px-2" data-действие="вверх" title="Выше">↑</button>
            <button class="btn btn-ghost btn-sm px-2" data-действие="вниз" title="Ниже">↓</button>
            <button class="btn btn-ghost btn-sm px-2 text-error" data-действие="убрать" title="Убрать">✕</button>`;
        обёртка.appendChild(ручки);

        if (б.type === 'ul' || б.type === 'ol') {
            const список = document.createElement(б.type);
            список.className = 'mb-2 pl-6 space-y-1 ' + (б.type === 'ul' ? 'list-disc' : 'list-decimal');
            (б.items.length ? б.items : [[]]).forEach((пункт, j) => {
                const li = document.createElement('li');
                const поле = полеТекста(пункт, 'кусок кусок-p', 'Пункт списка');
                поле.dataset.пункт = j;
                li.appendChild(поле);
                список.appendChild(li);
            });
            обёртка.appendChild(список);

            const добавить = document.createElement('button');
            добавить.className = 'btn btn-ghost btn-xs opacity-60';
            добавить.dataset.действие = 'пункт';
            добавить.textContent = '+ пункт';
            обёртка.appendChild(добавить);

        } else if (б.type === 'img') {
            const рамка = document.createElement('div');
            рамка.className = 'my-2';
            if (б.path && ссылки[б.path]) {
                const img = document.createElement('img');
                img.src = ссылки[б.path];
                img.className = 'rounded-lg max-w-full max-h-80';
                рамка.appendChild(img);
            } else {
                const выбор = document.createElement('div');
                выбор.className = 'flex flex-wrap gap-2';
                выбор.innerHTML = `
                    <button class="btn btn-outline btn-sm" data-действие="снимок">Загрузить файл</button>
                    <button class="btn btn-outline btn-sm" data-действие="галерея">Взять из галереи</button>`;
                рамка.appendChild(выбор);
            }
            const подпись = document.createElement('input');
            подпись.className = 'input input-bordered input-sm w-full mt-2';
            подпись.placeholder = 'Подпись к фото';
            подпись.value = б.caption || '';
            подпись.dataset.подпись = '1';
            рамка.appendChild(подпись);
            обёртка.appendChild(рамка);

        } else {
            обёртка.appendChild(полеТекста(б.spans, `кусок кусок-${б.type}` +
                (б.type === 'note' ? ' bg-base-200 rounded-lg px-4 py-3' : ''), ПОДСКАЗКИ[б.type]));
        }

        return обёртка;
    }

    /** Редактируемый кусок текста: отрезки превращаются в узлы, а не в HTML. */
    function полеТекста(значение, классы, подсказка) {
        const поле = document.createElement('div');
        поле.className = классы;
        поле.contentEditable = 'true';
        поле.dataset.подсказка = подсказка || '';
        поле.dataset.текст = '1';
        вставитьОтрезки(поле, значение);
        return поле;
    }

    /** Та же сборка, что и при чтении, но без классов оформления. */
    function вставитьОтрезки(узел, значение) {
        const времянка = document.createElement('div');
        времянка.appendChild(WorshipDoc.нарисовать({ blocks: [{ type: 'p', spans: значение }] }));
        const абзац = времянка.firstElementChild;
        while (абзац && абзац.firstChild) узел.appendChild(абзац.firstChild);
    }

    function рисоватьБлоки() {
        const тело = $('#блоки');
        тело.innerHTML = '';
        блоки.forEach((б, i) => тело.appendChild(нарисоватьБлок(б, i)));
    }

    // ---------- чтение формы ----------
    /** Узлы редактируемого куска → отрезки. Всё непонятное становится текстом. */
    function собратьОтрезки(поле) {
        const отрезки = [];
        const обойти = (узел, жирный, адрес) => {
            узел.childNodes.forEach(у => {
                if (у.nodeType === Node.TEXT_NODE) {
                    if (у.nodeValue) отрезки.push({ t: у.nodeValue, b: жирный, href: адрес });
                    return;
                }
                if (у.nodeType !== Node.ELEMENT_NODE) return;
                const имя = у.tagName.toLowerCase();
                if (имя === 'br') { отрезки.push({ t: ' ' }); return; }
                обойти(у,
                    жирный || имя === 'strong' || имя === 'b',
                    адрес || (имя === 'a' ? WorshipDoc.адрес(у.getAttribute('href')) : null));
            });
        };
        обойти(поле, false, null);

        // склеиваем соседние отрезки с одинаковым оформлением
        const готовые = [];
        отрезки.forEach(о => {
            const чистый = { t: о.t };
            if (о.b) чистый.b = true;
            if (о.href) чистый.href = о.href;
            const пред = готовые[готовые.length - 1];
            if (пред && !!пред.b === !!чистый.b && пред.href === чистый.href) пред.t += чистый.t;
            else готовые.push(чистый);
        });
        return готовые.filter(о => о.t !== '');
    }

    function собрать() {
        const собранные = [];
        document.querySelectorAll('#блоки .блок').forEach(узел => {
            const б = блоки[Number(узел.dataset.i)];
            if (!б) return;
            const метка = б.метка;
            if (б.type === 'ul' || б.type === 'ol') {
                // пустые пункты НЕ выбрасываем: пока человек пишет, пустой пункт —
                // это живая строка под курсором, и если убрать её здесь, номер
                // пункта в разметке перестанет совпадать с номером в блоке —
                // Backspace сотрёт соседу текст, а Enter вставит пункт не туда.
                // Отбрасываются они позже, в WorshipDoc.разобрать, при записи
                const items = [...узел.querySelectorAll('[data-пункт]')].map(собратьОтрезки);
                собранные.push({ type: б.type, items, метка });
            } else if (б.type === 'img') {
                собранные.push({ type: 'img', path: б.path || '', метка,
                                 caption: узел.querySelector('[data-подпись]')?.value || '' });
            } else {
                собранные.push({ type: б.type, метка,
                                 spans: собратьОтрезки(узел.querySelector('[data-текст]')) });
            }
        });
        блоки = собранные;
        // метки служебные: в базу уходит разобранный документ, где их нет
        return WorshipDoc.разобрать({ blocks: собранные });
    }

    // ---------- память браузера ----------
    const ключЧерновика = () => `srsk_worship_draft_${id || 'new'}`;

    function запомнить() {
        try {
            sessionStorage.setItem(ключЧерновика(), JSON.stringify({
                когда: Date.now(),
                title: $('#заголовок').value,
                section_id: $('#раздел').value,
                change_note: $('#примечание').value,
                doc: { blocks: блоки },
            }));
        } catch { /* приватный режим */ }
    }

    function забыть() {
        try { sessionStorage.removeItem(ключЧерновика()); } catch { /* приватный режим */ }
    }

    /** Несохранённое с прошлого раза: предлагаем вернуть, а не подсовываем молча. */
    function проверитьНесохранённое() {
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
        if (!confirm('В этом браузере осталась несохранённая правка. Вернуть её?')) {
            забыть();
            return;
        }
        блоки = WorshipDoc.разобрать(запись.doc).blocks;
        $('#заголовок').value = запись.title || '';
        $('#раздел').value = запись.section_id || '';     // «без раздела» тоже выбор
        $('#примечание').value = запись.change_note || '';
        рисоватьБлоки();
        пометить();
    }

    function пометить() {
        грязно = true;
        $('#сохранение').textContent = 'не сохранено';
        $('#сохранение').className = 'text-sm text-warning';
    }

    const запомнитьПотом = Layout.debounce(() => { собрать(); запомнить(); }, 800);

    // ---------- сохранение ----------
    async function сохранить({ затем } = {}) {
        if (сохраняется) return null;
        const документ = собрать();
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
            document.querySelector('#блоки [data-текст]')?.focus();
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
        $('#сохранение').textContent = 'сохраняю…';
        $('#сохранение').className = 'text-sm opacity-60';

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
            $('#сохранение').textContent = 'не сохранено';
            $('#сохранение').className = 'text-sm text-error';
            Layout.handleError(error, 'Сохранение');
            return null;
        }
        if (data?.конфликт) {
            $('#сохранение').textContent = 'не сохранено';
            $('#сохранение').className = 'text-sm text-error';
            показатьКонфликт(data['чужая_версия'], data['сообщение']);
            return null;
        }
        if (былаПерезапись) $('#конфликт').hidden = true;

        базоваяОтметка = data.updated_at;
        грязно = false;
        свои = [];
        забыть();
        $('#сохранение').textContent = 'сохранено';
        $('#сохранение').className = 'text-sm text-success';
        return data;
    }

    function кнопкиЗаняты(занято) {
        ['#сохранить', '#отправить', '#перезаписать'].forEach(s => {
            const б = $(s);
            if (б) б.disabled = занято;
        });
    }

    function показатьКонфликт(чужая, сообщение) {
        $('#конфликт').hidden = false;
        document.querySelector('#конфликт .font-bold').textContent =
            сообщение || 'Пока вы писали, черновик изменил кто-то другой';
        // имя и начало чужого текста прямо здесь: иначе непонятно, с кем
        // договариваться и что вообще написано вместо твоего
        const кусок = (чужая.текст || '').trim().slice(0, 300);
        $('#конфликтТекст').innerHTML = `
            ${e(чужая.кто || 'Кто-то из отдела')} сохранил ${
                DateUtils.formatDateTime(new Date(чужая.обновлена))}.
            ${кусок ? `<span class="block mt-2 p-2 rounded bg-base-100 text-sm">${
                e(кусок)}${(чужая.текст || '').length > 300 ? '…' : ''}</span>` : ''}
            <span class="block mt-2">Откройте чужую правку в соседней вкладке и перенесите своё,
            либо сохраните поверх — тогда чужая работа пропадёт.</span>`;
    }

    // ---------- снимки ----------
    let блокДляСнимка = null;        // метка блока, а не его номер в списке: пока
                                     // открыт выбор файла, блоки могли переставить
    let счётчикМеток = 0;

    async function загрузитьСнимок(файл) {
        if (!блокДляСнимка) return;
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

        собрать();
        const куда = блоки.findIndex(б => б.метка === блокДляСнимка);
        if (куда < 0) {                       // блок убрали, пока выбирали файл
            Layout.db.storage.from('worship').remove([путь])
                .then(({ error }) => { if (error) console.debug('не убрали снимок:', error.message); });
            return;
        }
        блоки[куда].path = путь;
        рисоватьБлоки();
        пометить();
        запомнить();
    }

    // ---------- вставка готового текста ----------
    /**
     * Делит вставленный текст на блоки по пустым строкам и по виду строки.
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

    function вставитьБлоками(поле, куски) {
        собрать();
        const узел = поле.closest('.блок');
        const i = Number(узел.dataset.i);
        // «пусто» — только про блок целиком: пустая строка внутри списка пустым
        // блоком не делает, и заменять им весь список нельзя
        const вСписке = поле.dataset.пункт !== undefined;
        const пусто = !вСписке && !поле.textContent.trim();

        const новые = куски.map(к => ({
            метка: ++счётчикМеток,
            ...(к.items
                ? { type: к.type, items: к.items.map(т => [{ t: т }]) }
                : { type: к.type, spans: [{ t: к.text }] }),
        }));

        // в пустой блок вставляем вместо него, иначе — следом
        блоки.splice(пусто ? i : i + 1, пусто ? 1 : 0, ...новые);
        рисоватьБлоки();
        пометить();
        запомнить();

        const последний = (пусто ? i : i + 1) + новые.length - 1;
        document.querySelector(`.блок[data-i="${последний}"] [data-текст]`)?.focus();
        Layout.showNotification(`Вставлено блоков: ${новые.length}`, 'info');
    }

    // ---------- снимок из галереи ----------
    /**
     * Кадр, уже лежащий в наборе, можно вставить в стандарт — но только
     * из открытого набора. Снимок из закрытого в тексте, который читает весь
     * ашрам, означал бы тихий обход закрытости, ради которой набор и закрывали.
     */
    async function открытьГалерею() {
        const { data: наборы, error } = await Layout.db.from('worship_albums')
            .select('id, title, event_date, is_private, is_archived')
            .eq('is_archived', false).order('event_date', { ascending: false });
        if (error) return Layout.handleError(error, 'Галерея');
        if (!наборы?.length) return Layout.showNotification('Наборов снимков пока нет', 'info');

        $('#выборНабора').innerHTML = наборы.map(н =>
            `<option value="${н.id}">${e(н.title)} · ${
                DateUtils.formatShort(DateUtils.parseDate(н.event_date))}${
                н.is_private ? ' — закрытый' : ''}</option>`).join('');

        const показать = async () => {
            const н = наборы.find(x => x.id === $('#выборНабора').value);
            const поле = $('#снимкиНабора');
            if (!н) return;

            const { data: снимки } = await Layout.db.from('worship_images')
                .select('id, storage_path, caption').eq('album_id', н.id)
                .order('sort_order').order('shot_at');
            if (!снимки?.length) {
                поле.innerHTML = '<div class="col-span-full text-sm opacity-60 py-4">В наборе пока нет снимков</div>';
                return;
            }

            const { data: адреса } = await Layout.db.storage.from('worship')
                .createSignedUrls(снимки.map(с => с.storage_path), 1800);
            const карта = Object.fromEntries((адреса || [])
                .filter(а => а.signedUrl).map(а => [а.path, а.signedUrl]));

            поле.innerHTML = снимки.map(с => `
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

        собрать();
        const куда = блоки.findIndex(б => б.метка === блокДляСнимка);
        if (куда < 0) return;
        блоки[куда].path = путь;
        рисоватьБлоки();
        пометить();
        запомнить();
        $('#галереяМодал').close();
    }

    // ---------- работа с блоками ----------
    /** Перекладывает содержимое блока в другой тип, ничего не теряя. */
    function сменитьТип(б, тип) {
        if (!б || б.type === тип) return б;
        const списки = ['ul', 'ol'];

        if (списки.includes(тип)) {
            const items = списки.includes(б.type)
                ? б.items
                : [(б.spans || []).slice()];
            return { type: тип, метка: б.метка,
                     items: items.filter(п => п.length).length ? items : [[]] };
        }
        const spans = списки.includes(б.type)
            ? б.items.flatMap((п, i) => i ? [{ t: ' ' }, ...п] : п)
            : (б.spans || []);
        return { type: тип, spans, метка: б.метка };
    }

    function новыйБлок(тип) {
        const метка = ++счётчикМеток;
        if (тип === 'ul' || тип === 'ol') return { type: тип, items: [[]], метка };
        if (тип === 'img') return { type: 'img', path: '', caption: '', метка };
        return { type: тип, spans: [], метка };
    }

    function добавитьБлок(тип, куда = блоки.length) {
        запомнитьШаг();
        собрать();
        блоки.splice(куда, 0, новыйБлок(тип));
        рисоватьБлоки();
        пометить();
        const узел = document.querySelector(`.блок[data-i="${куда}"] [data-текст]`);
        узел?.focus();
    }

    // ───────── история правок ─────────
    //
    // Нативная история браузера здесь бесполезна: почти каждое действие
    // перерисовывает блоки, и Ctrl+Z после этого откатывал в пустоту либо
    // не делал ничего. Поэтому история живёт своим стеком снимков документа,
    // а браузерную мы перехватываем на beforeinput — это тот самый приём,
    // которым пользуются редакторы, перерисовывающие своё поле сами.
    const ПРЕДЕЛ_ИСТОРИИ = 60;
    let история = [], шагИстории = -1, откатываем = false;

    /** Где сейчас курсор — чтобы после отката он вернулся туда же. */
    function местоКурсора() {
        const поле = document.activeElement?.closest?.('[data-текст]');
        if (!поле) return null;
        const блок = поле.closest('.блок');
        const выделение = getSelection();
        let смещение = 0;
        if (выделение?.rangeCount) {
            const кусок = выделение.getRangeAt(0).cloneRange();
            кусок.selectNodeContents(поле);
            кусок.setEnd(выделение.getRangeAt(0).endContainer, выделение.getRangeAt(0).endOffset);
            смещение = кусок.toString().length;
        }
        return { блок: Number(блок?.dataset.i ?? 0), пункт: поле.dataset.пункт, смещение };
    }

    function вернутьКурсор(место) {
        if (!место) return;
        const блок = document.querySelector(`.блок[data-i="${место.блок}"]`);
        const поле = место.пункт != null
            ? блок?.querySelector(`[data-пункт="${место.пункт}"]`)
            : блок?.querySelector('[data-текст]');
        if (!поле) return;
        поле.focus();

        // ставим курсор на то же число символов от начала куска
        const обход = document.createTreeWalker(поле, NodeFilter.SHOW_TEXT);
        let пройдено = 0, узел = обход.nextNode();
        while (узел) {
            if (пройдено + узел.nodeValue.length >= место.смещение) {
                const диапазон = document.createRange();
                диапазон.setStart(узел, Math.max(0, место.смещение - пройдено));
                диапазон.collapse(true);
                const выделение = getSelection();
                выделение.removeAllRanges();
                выделение.addRange(диапазон);
                return;
            }
            пройдено += узел.nodeValue.length;
            узел = обход.nextNode();
        }
    }

    /** Снимок состояния. Делается ДО изменения, иначе откатывать нечего. */
    function запомнитьШаг() {
        if (откатываем) return;
        собрать();
        const снимок = {
            документ: JSON.stringify(блоки),
            заголовок: $('#заголовок').value,
            место: местоКурсора(),
        };
        // подряд идущие одинаковые снимки не копим: Ctrl+Z не должен
        // нажиматься пять раз, чтобы убрать одно слово
        if (история[шагИстории]?.документ === снимок.документ
            && история[шагИстории]?.заголовок === снимок.заголовок) {
            история[шагИстории].место = снимок.место;
            return;
        }
        история = история.slice(0, шагИстории + 1);
        история.push(снимок);
        if (история.length > ПРЕДЕЛ_ИСТОРИИ) история.shift();
        шагИстории = история.length - 1;
        обновитьКнопкиИстории();
    }

    /** Набор текста запоминается не на каждую букву, а паузами. */
    const запомнитьШагПотом = Layout.debounce(запомнитьШаг, 700);

    function применитьСнимок(снимок) {
        откатываем = true;
        блоки = JSON.parse(снимок.документ);
        $('#заголовок').value = снимок.заголовок;
        рисоватьБлоки();
        вернутьКурсор(снимок.место);
        откатываем = false;
        пометить();
        запомнитьПотом();
        обновитьКнопкиИстории();
    }

    function откатить() {
        if (шагИстории <= 0) {
            // последний шаг ещё не записан: запишем текущее состояние,
            // чтобы человеку было куда вернуться вперёд
            if (шагИстории === 0) запомнитьШаг();
            if (шагИстории <= 0) return;
        }
        запомнитьШаг();                      // текущее состояние — тоже шаг
        шагИстории = Math.max(0, шагИстории - 1);
        применитьСнимок(история[шагИстории]);
    }

    function повторить() {
        if (шагИстории >= история.length - 1) return;
        шагИстории += 1;
        применитьСнимок(история[шагИстории]);
    }

    function обновитьКнопкиИстории() {
        const назад = $('#откатить'), вперёд = $('#повторить');
        if (назад) назад.disabled = шагИстории <= 0;
        if (вперёд) вперёд.disabled = шагИстории >= история.length - 1;
    }

    let убранный = null;            // последний удалённый блок, чтобы вернуть

    function убратьБлок(i) {
        запомнитьШаг();
        собрать();
        const б = блоки[i];
        убранный = { блок: б, место: i };
        $('#вернутьБлок').hidden = false;
        // снимок, загруженный в эту же правку и никуда не попавший, уносим с собой:
        // иначе хранилище копит кадры, которых нет ни в одной версии
        if (б?.type === 'img' && б.path && свои.includes(б.path)) {
            Layout.db.storage.from('worship').remove([б.path])
                .then(({ error }) => { if (error) console.debug('не убрали снимок:', error.message); });
            свои = свои.filter(п => п !== б.path);
        }
        блоки.splice(i, 1);
        if (!блоки.length) блоки = WorshipDoc.пустой().blocks;
        рисоватьБлоки();
        пометить();
    }

    /** Промах пальцем по ✕ в 4:20 не должен стоить абзаца. */
    function вернутьБлок() {
        if (!убранный) return;
        запомнитьШаг();
        собрать();
        блоки.splice(Math.min(убранный.место, блоки.length), 0, убранный.блок);
        убранный = null;
        $('#вернутьБлок').hidden = true;
        рисоватьБлоки();
        пометить();
    }

    function переставить(i, шаг) {
        запомнитьШаг();
        собрать();
        const j = i + шаг;
        if (j < 0 || j >= блоки.length) return;
        [блоки[i], блоки[j]] = [блоки[j], блоки[i]];
        рисоватьБлоки();
        пометить();
    }

    // ---------- события ----------
    function слушать() {
        const тело = $('#блоки');

        тело.addEventListener('input', () => { пометить(); запомнитьПотом(); запомнитьШагПотом(); });

        // браузер попробует откатить своё — перехватываем и откатываем своё,
        // иначе Ctrl+Z работал бы поверх перерисованных блоков и рвал текст
        тело.addEventListener('beforeinput', ev => {
            if (ev.inputType === 'historyUndo') { ev.preventDefault(); откатить(); }
            if (ev.inputType === 'historyRedo') { ev.preventDefault(); повторить(); }
        });

        // Вставка приходит обычным текстом: из Word иначе приезжает чужая вёрстка.
        // Но переносы строк сохраняем смыслом: отдел будет переносить полсотни
        // готовых документов, и схлопывать их в один абзац — значит заставить
        // перепечатывать всё руками.
        тело.addEventListener('paste', ev => {
            const поле = ev.target.closest('[data-текст]');
            if (!поле) return;
            ev.preventDefault();
            const текст = (ev.clipboardData || window.clipboardData).getData('text/plain');
            const куски = разобратьВставку(текст);

            if (куски.length <= 1) {
                document.execCommand('insertText', false, текст.replace(/\s+/g, ' ').trim());
                return;
            }
            вставитьБлоками(поле, куски);
        });

        тело.addEventListener('keydown', ev => {
            const поле = ev.target.closest('[data-текст]');
            if (!поле) return;
            const блок = поле.closest('.блок');
            const i = Number(блок.dataset.i);

            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                const б = блоки[i];
                if (б.type === 'ul' || б.type === 'ol') {
                    запомнитьШаг();
                    собрать();
                    блоки[i].items.splice(Number(поле.dataset.пункт) + 1, 0, []);
                    рисоватьБлоки();
                    document.querySelector(
                        `.блок[data-i="${i}"] [data-пункт="${Number(поле.dataset.пункт) + 1}"]`)?.focus();
                } else {
                    добавитьБлок('p', i + 1);
                }
                пометить();
                return;
            }

            if (ev.key === 'Backspace' && !поле.textContent) {
                const б = блоки[i];
                if (б.type === 'ul' || б.type === 'ol') {
                    const п = Number(поле.dataset.пункт);
                    if (блоки[i].items.length > 1) {
                        ev.preventDefault();
                        запомнитьШаг();
                        собрать();
                        блоки[i].items.splice(п, 1);
                        рисоватьБлоки();
                        пометить();
                        return;
                    }
                }
                if (блоки.length > 1) {
                    ev.preventDefault();
                    убратьБлок(i);
                    const пред = document.querySelector(`.блок[data-i="${Math.max(0, i - 1)}"] [data-текст]`);
                    пред?.focus();
                }
                return;
            }

            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'b') {
                ev.preventDefault();
                запомнитьШаг();
                document.execCommand('bold');
                пометить();
            }
        });

        // Ctrl+Z и Ctrl+Shift+Z ловим на всей странице: курсор может стоять
        // и в заголовке, и в подписи к фото
        document.addEventListener('keydown', ev => {
            if (!(ev.ctrlKey || ev.metaKey)) return;
            const кнопка = ev.key.toLowerCase();
            if (кнопка === 'z' && !ev.shiftKey) { ev.preventDefault(); откатить(); }
            else if ((кнопка === 'z' && ev.shiftKey) || кнопка === 'y') { ev.preventDefault(); повторить(); }
        });

        тело.addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-действие]');
            if (!кнопка) return;
            const блок = кнопка.closest('.блок');
            const i = Number(блок.dataset.i);
            switch (кнопка.dataset.действие) {
                case 'вверх': переставить(i, -1); break;
                case 'вниз': переставить(i, 1); break;
                case 'убрать': убратьБлок(i); break;
                case 'пункт':
                    запомнитьШаг();
                    собрать();
                    блоки[i].items.push([]);
                    рисоватьБлоки();
                    document.querySelector(
                        `.блок[data-i="${i}"] [data-пункт="${блоки[i].items.length - 1}"]`)?.focus();
                    пометить();
                    break;
                case 'снимок':
                    собрать();
                    блокДляСнимка = блоки[i]?.метка ?? null;
                    $('#файл').click();
                    break;
                case 'галерея':
                    собрать();
                    блокДляСнимка = блоки[i]?.метка ?? null;
                    открытьГалерею();
                    break;
            }
        });

        тело.addEventListener('change', ev => {
            const выбор = ev.target.closest('[data-тип]');
            if (!выбор) return;
            запомнитьШаг();
            собрать();
            const i = Number(выбор.closest('.блок').dataset.i);
            блоки[i] = сменитьТип(блоки[i], выбор.value);
            рисоватьБлоки();
            пометить();
            document.querySelector(`.блок[data-i="${i}"] [data-текст]`)?.focus();
        });

        $('#снимкиНабора').addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-взятьСнимок]');
            if (кнопка) взятьИзГалереи(кнопка.getAttribute('data-взятьСнимок'));
        });

        $('#файл').addEventListener('change', async ev => {
            const файл = ev.target.files?.[0];
            ev.target.value = '';
            if (файл) await загрузитьСнимок(файл);
        });

        document.querySelectorAll('[data-добавить]').forEach(б =>
            б.addEventListener('click', () => {
                добавитьБлок(б.dataset.добавить);
                б.closest('.dropdown')?.querySelector('[tabindex]')?.blur();
                document.activeElement?.blur?.();
                const узел = document.querySelector(`.блок[data-i="${блоки.length - 1}"] [data-текст]`);
                узел?.focus();
            }));

        // без этого Chrome снимает жирный не тегом, а <span style>, которого
        // сериализация не понимает, и оформление «не снимается»
        try { document.execCommand('styleWithCSS', false, false); } catch { /* старый браузер */ }
        $('#жирный').addEventListener('click', () => {
            запомнитьШаг();
            document.execCommand('bold');
            пометить();
        });
        $('#откатить').addEventListener('click', откатить);
        $('#повторить').addEventListener('click', повторить);
        $('#вернутьБлок').addEventListener('click', вернутьБлок);
        $('#ссылка').addEventListener('click', поставитьСсылку);

        ['#заголовок', '#раздел', '#примечание'].forEach(s =>
            $(s).addEventListener('input', () => { пометить(); запомнитьПотом(); }));

        $('#сохранить').addEventListener('click', async () => {
            const ответ = await сохранить({});
            if (ответ && !id) location.replace(`edit.html?id=${ответ.article_id}`);
        });

        $('#отправить').addEventListener('click', отправить);
        $('#отмена').addEventListener('click', отменить);
        $('#удалить').addEventListener('click', удалить);

        $('#перезаписать').addEventListener('click', async () => {
            if (!confirm('Чужая правка пропадёт без возможности вернуть. Сохранить моё поверх?')) return;
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

    function поставитьСсылку() {
        const выделение = getSelection();
        if (!выделение.rangeCount || выделение.isCollapsed) {
            Layout.showNotification('Выделите слова, которые станут ссылкой', 'info');
            return;
        }
        const куда = prompt('Адрес ссылки (https://… или имя страницы модуля)');
        if (!куда) return;
        const чистый = WorshipDoc.адрес(куда);
        if (!чистый) { Layout.showNotification('Такой адрес не годится', 'warning'); return; }
        запомнитьШаг();
        document.execCommand('createLink', false, чистый);
        пометить();
        запомнитьПотом();
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

    function отменить() {
        if (грязно && !confirm('Выйти без сохранения? Написанное после последнего сохранения пропадёт.')) return;
        грязно = false;
        забыть();
        location.href = id ? `article.html?id=${id}` : 'standards.html';
    }

    async function удалить() {
        if (!confirm('Удалить черновик? Эта статья никогда не действовала, восстановить будет нечем.')) return;
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
        рисоватьБлоки();
        слушать();
        запомнитьШаг();                 // точка, к которой можно вернуться
        // теги ставятся прямо при написании: у новой статьи — после первого
        // сохранения, когда страница перезагрузится уже с номером
        if (id) {
            $('#тегиБлок').hidden = false;
            WorshipTags.нарисовать($('#теги'), { article_id: id }, { можноПравить: true });
        }
        $('#сохранение').textContent = '';
        // после проверки — не чистим: если несохранённое вернули, человек
        // должен видеть «не сохранено», иначе решит, что всё уже в базе
        проверитьНесохранённое();
    }

    return { init };
})();
