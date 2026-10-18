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
        блоки = документ.blocks.length ? документ.blocks : WorshipDoc.пустой().blocks;
        базоваяОтметка = версия?.status === 'draft' ? версия.updated_at : null;
        Object.assign(ссылки, await WorshipDoc.ссылкиНаСнимки(Layout.db, { blocks: блоки }));
        return true;
    }

    // ---------- отрисовка формы ----------
    function рисоватьШапку() {
        $('#режим').textContent = !id ? 'Новая статья'
            : статья.status === 'published' ? 'Правка действующего стандарта'
            : 'Черновик';

        $('#раздел').innerHTML = '<option value="">Без раздела</option>' + разделы.map(р =>
            `<option value="${р.id}" ${статья?.section_id === р.id ? 'selected' : ''}>${
                e(Layout.getName(р))}${р.is_active ? '' : ' (скрыт)'}</option>`).join('');

        $('#заголовок').value = версия?.title || статья?.title || '';
        $('#примечание').value = версия?.status === 'draft' ? (версия.change_note || '') : '';

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
        ручки.className = 'ручки flex items-center gap-1 mb-1';
        ручки.innerHTML = `
            <span class="text-[11px] uppercase tracking-widest opacity-40 mr-1">${НАЗВАНИЯ[б.type]}</span>
            <button class="btn btn-ghost btn-xs" data-действие="вверх" title="Выше">↑</button>
            <button class="btn btn-ghost btn-xs" data-действие="вниз" title="Ниже">↓</button>
            <button class="btn btn-ghost btn-xs text-error" data-действие="убрать" title="Убрать">✕</button>`;
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
                const пусто = document.createElement('button');
                пусто.className = 'btn btn-outline btn-sm';
                пусто.dataset.действие = 'снимок';
                пусто.textContent = 'Выбрать фото';
                рамка.appendChild(пусто);
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
            if (б.type === 'ul' || б.type === 'ol') {
                // пустые пункты НЕ выбрасываем: пока человек пишет, пустой пункт —
                // это живая строка под курсором, и если убрать её здесь, номер
                // пункта в разметке перестанет совпадать с номером в блоке —
                // Backspace сотрёт соседу текст, а Enter вставит пункт не туда.
                // Отбрасываются они позже, в WorshipDoc.разобрать, при записи
                const items = [...узел.querySelectorAll('[data-пункт]')].map(собратьОтрезки);
                собранные.push({ type: б.type, items });
            } else if (б.type === 'img') {
                собранные.push({ type: 'img', path: б.path || '',
                                 caption: узел.querySelector('[data-подпись]')?.value || '' });
            } else {
                собранные.push({ type: б.type, spans: собратьОтрезки(узел.querySelector('[data-текст]')) });
            }
        });
        блоки = собранные;
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
        $('#конфликтТекст').textContent =
            `Сохранено ${DateUtils.formatDateTime(new Date(чужая.обновлена))}. ` +
            'Откройте чужую правку в соседней вкладке и перенесите своё, ' +
            'либо сохраните поверх — тогда чужая работа пропадёт.';
    }

    // ---------- снимки ----------
    let блокДляСнимка = null;        // сам блок, а не номер: пока открыт выбор файла,
                                     // блоки могли переставить или убрать

    /** Уменьшаем до загрузки: у алтаря телефон, а не студия. */
    function уменьшить(файл) {
        return new Promise((готово, плохо) => {
            const чтение = new FileReader();
            чтение.onerror = () => плохо(new Error('Файл не прочитался'));
            чтение.onload = () => {
                const img = new Image();
                img.onerror = () => плохо(new Error('Это не похоже на изображение'));
                img.onload = () => {
                    const предел = 1600;
                    const к = Math.min(1, предел / Math.max(img.width, img.height));
                    const холст = document.createElement('canvas');
                    холст.width = Math.round(img.width * к);
                    холст.height = Math.round(img.height * к);
                    холст.getContext('2d').drawImage(img, 0, 0, холст.width, холст.height);
                    холст.toBlob(b => b ? готово(b) : плохо(new Error('Не удалось пережать')),
                                 'image/jpeg', 0.85);
                };
                img.src = чтение.result;
            };
            чтение.readAsDataURL(файл);
        });
    }

    async function загрузитьСнимок(файл) {
        if (!блокДляСнимка) return;
        let тело;
        try { тело = await уменьшить(файл); }
        catch (ош) { Layout.showNotification(ош.message, 'error'); return; }

        const uid = window.currentUser?.id;
        const путь = `${uid}/${crypto.randomUUID()}.jpg`;
        const { error } = await Layout.db.storage.from('worship')
            .upload(путь, тело, { contentType: 'image/jpeg' });
        if (error) { Layout.handleError(error, 'Загрузка фото'); return; }

        const { data } = await Layout.db.storage.from('worship').createSignedUrl(путь, 3600);
        if (!data?.signedUrl) {
            Layout.showNotification('Фото загрузилось, но не показывается — обновите страницу', 'warning');
        }
        ссылки[путь] = data?.signedUrl || '';
        свои.push(путь);

        собрать();
        const куда = блоки.indexOf(блокДляСнимка);
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

    // ---------- работа с блоками ----------
    function новыйБлок(тип) {
        if (тип === 'ul' || тип === 'ol') return { type: тип, items: [[]] };
        if (тип === 'img') return { type: 'img', path: '', caption: '' };
        return { type: тип, spans: [] };
    }

    function добавитьБлок(тип, куда = блоки.length) {
        собрать();
        блоки.splice(куда, 0, новыйБлок(тип));
        рисоватьБлоки();
        пометить();
        const узел = document.querySelector(`.блок[data-i="${куда}"] [data-текст]`);
        узел?.focus();
    }

    function убратьБлок(i) {
        собрать();
        const б = блоки[i];
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

    function переставить(i, шаг) {
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

        тело.addEventListener('input', () => { пометить(); запомнитьПотом(); });

        // вставка приходит обычным текстом: из Word иначе приезжает чужая вёрстка
        тело.addEventListener('paste', ev => {
            if (!ev.target.closest('[data-текст]')) return;
            ev.preventDefault();
            const текст = (ev.clipboardData || window.clipboardData).getData('text/plain');
            document.execCommand('insertText', false, текст.replace(/\s*\n\s*/g, ' '));
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
                document.execCommand('bold');
                пометить();
            }
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
                    собрать();
                    блоки[i].items.push([]);
                    рисоватьБлоки();
                    document.querySelector(
                        `.блок[data-i="${i}"] [data-пункт="${блоки[i].items.length - 1}"]`)?.focus();
                    пометить();
                    break;
                case 'снимок':
                    собрать();
                    блокДляСнимка = блоки[i];
                    $('#файл').click();
                    break;
            }
        });

        $('#файл').addEventListener('change', async ev => {
            const файл = ev.target.files?.[0];
            ev.target.value = '';
            if (файл) await загрузитьСнимок(файл);
        });

        document.querySelectorAll('[data-добавить]').forEach(б =>
            б.addEventListener('click', () => добавитьБлок(б.dataset.добавить)));

        // без этого Chrome снимает жирный не тегом, а <span style>, которого
        // сериализация не понимает, и оформление «не снимается»
        try { document.execCommand('styleWithCSS', false, false); } catch { /* старый браузер */ }
        $('#жирный').addEventListener('click', () => { document.execCommand('bold'); пометить(); });
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
            знаюСостояние = false;              // сознательная перезапись
            $('#конфликт').hidden = true;
            await сохранить({});
        });
        $('#открытьЧужое').addEventListener('click', () => window.open(`article.html?id=${id}`, '_blank'));

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
        if (грязно && !confirm('Несохранённое пропадёт. Выйти?')) return;
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
        $('#сохранение').textContent = '';
        // после проверки — не чистим: если несохранённое вернули, человек
        // должен видеть «не сохранено», иначе решит, что всё уже в базе
        проверитьНесохранённое();
    }

    return { init };
})();
