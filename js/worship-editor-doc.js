/**
 * Перевод между документом статьи и обычным редактируемым текстом.
 *
 * Хранится статья по-прежнему структурой (см. worship-doc.js): абзацы,
 * заголовки, списки, заметки, фото. А правится она как обычный текст —
 * одним полем, где выделяешь кусок и делаешь его заголовком или списком.
 * Никаких «блоков с ручками»: это было лишним усложнением, из-за которого
 * ещё и не работала отмена.
 *
 * Отсюда два перевода:
 *   вДом(документ)  — разметка для contenteditable;
 *   изДома(узел)    — обратно в блоки, ровно те же типы, что и раньше.
 *
 * Правило безопасности прежнее: текст кладётся узлами, а не строкой, и
 * из разметки признаётся только то, что умеет формат. Всё прочее — чужая
 * вёрстка из Word — отбрасывается при обратном переводе, а не чистится.
 */
const WorshipEditorDoc = (() => {

    /** Отрезки (жирный, ссылка) → узлы внутри строки. */
    function отрезкиВУзел(куда, значение) {
        const части = Array.isArray(значение)
            ? значение
            : (значение ? [{ t: String(значение) }] : []);

        части.forEach(о => {
            if (!о || typeof о.t !== 'string' || о.t === '') return;
            let узел = document.createTextNode(о.t);
            if (о.b) {
                const strong = document.createElement('strong');
                strong.appendChild(узел);
                узел = strong;
            }
            const ссылка = о.href ? WorshipDoc.адрес(о.href) : null;
            if (ссылка) {
                const a = document.createElement('a');
                a.href = ссылка;
                a.className = 'link';
                a.appendChild(узел);
                узел = a;
            }
            куда.appendChild(узел);
        });
        if (!куда.firstChild) куда.appendChild(document.createElement('br'));
    }

    /** Фото: картинка не редактируется, подпись — редактируется. */
    function фото(б, ссылки) {
        const рамка = document.createElement('figure');
        рамка.className = 'worship-фото my-3';
        рамка.dataset.path = б.path;

        const img = document.createElement('img');
        img.src = ссылки?.[б.path] || '';
        img.alt = б.caption || '';
        img.className = 'rounded-lg max-w-full max-h-96';
        img.contentEditable = 'false';
        рамка.appendChild(img);

        const подпись = document.createElement('figcaption');
        подпись.className = 'text-sm opacity-70 mt-1';
        подпись.dataset.подпись = '1';
        подпись.textContent = б.caption || '';
        рамка.appendChild(подпись);
        return рамка;
    }

    /** Документ → разметка редактируемого поля. */
    function вДом(документ, ссылки) {
        const обломок = document.createDocumentFragment();
        const блоки = WorshipDoc.разобрать(документ).blocks;

        (блоки.length ? блоки : [{ type: 'p', spans: [] }]).forEach(б => {
            if (б.type === 'img') { обломок.appendChild(фото(б, ссылки)); return; }

            if (б.type === 'ul' || б.type === 'ol') {
                const список = document.createElement(б.type);
                (б.items.length ? б.items : [[]]).forEach(пункт => {
                    const li = document.createElement('li');
                    отрезкиВУзел(li, пункт);
                    список.appendChild(li);
                });
                обломок.appendChild(список);
                return;
            }

            // заметка — это blockquote: в редакторе она и выглядит как врезка
            const тег = б.type === 'note' ? 'blockquote' : б.type;
            const узел = document.createElement(тег);
            if (б.type === 'note') узел.className = 'worship-заметка';
            отрезкиВУзел(узел, б.spans);
            обломок.appendChild(узел);
        });
        return обломок;
    }

    /** Узлы строки → отрезки. Непонятное становится обычным текстом. */
    function отрезкиИзУзла(узел) {
        const найденные = [];
        const обойти = (у, жирный, адрес) => {
            у.childNodes.forEach(ч => {
                if (ч.nodeType === Node.TEXT_NODE) {
                    if (ч.nodeValue) найденные.push({ t: ч.nodeValue, b: жирный, href: адрес });
                    return;
                }
                if (ч.nodeType !== Node.ELEMENT_NODE) return;
                const имя = ч.tagName.toLowerCase();
                if (имя === 'br') { найденные.push({ t: ' ' }); return; }
                обойти(ч,
                    жирный || имя === 'strong' || имя === 'b' || имя === 'em',
                    адрес || (имя === 'a' ? WorshipDoc.адрес(ч.getAttribute('href')) : null));
            });
        };
        обойти(узел, false, null);

        const готовые = [];
        найденные.forEach(о => {
            const чистый = { t: о.t };
            if (о.b) чистый.b = true;
            if (о.href) чистый.href = о.href;
            const пред = готовые[готовые.length - 1];
            if (пред && !!пред.b === !!чистый.b && пред.href === чистый.href) пред.t += чистый.t;
            else готовые.push(чистый);
        });
        return готовые.filter(о => о.t.trim() !== '' || готовые.length === 1);
    }

    /** Разметка поля → документ. Браузер вставляет своё — переводим по смыслу. */
    function изДома(поле) {
        const blocks = [];

        const добавитьСтрочный = (тип, узел) => {
            const spans = отрезкиИзУзла(узел);
            // пустые абзацы не копим, но один оставляем, чтобы было куда писать
            if (!spans.length || !spans.some(о => о.t.trim())) {
                if (тип === 'p') return;
                return;
            }
            blocks.push({ type: тип, spans });
        };

        const обработать = узел => {
            if (узел.nodeType === Node.TEXT_NODE) {
                if (узел.nodeValue.trim()) blocks.push({ type: 'p', spans: [{ t: узел.nodeValue.trim() }] });
                return;
            }
            if (узел.nodeType !== Node.ELEMENT_NODE) return;
            const имя = узел.tagName.toLowerCase();

            if (имя === 'figure' && узел.dataset.path) {
                blocks.push({
                    type: 'img',
                    path: узел.dataset.path,
                    caption: узел.querySelector('figcaption')?.textContent.trim() || '',
                });
                return;
            }
            if (имя === 'ul' || имя === 'ol') {
                const items = [...узел.querySelectorAll(':scope > li')]
                    .map(отрезкиИзУзла).filter(п => п.some(о => о.t.trim()));
                if (items.length) blocks.push({ type: имя, items });
                return;
            }
            if (имя === 'blockquote') return добавитьСтрочный('note', узел);
            if (имя === 'h1' || имя === 'h2') return добавитьСтрочный('h2', узел);
            if (имя === 'h3' || имя === 'h4' || имя === 'h5' || имя === 'h6') {
                return добавитьСтрочный('h3', узел);
            }
            if (имя === 'div' || имя === 'p') {
                // Chrome заворачивает строки в div; вложенные списки и фото
                // внутри такого div разбираем отдельно, а не теряем
                const внутри = [...узел.children].some(ч =>
                    ['ul', 'ol', 'figure', 'blockquote', 'h1', 'h2', 'h3'].includes(ч.tagName.toLowerCase()));
                if (внутри) { [...узел.childNodes].forEach(обработать); return; }
                return добавитьСтрочный('p', узел);
            }
            // всё остальное (span, b, a и прочее на верхнем уровне) — обычный абзац
            добавитьСтрочный('p', узел);
        };

        [...поле.childNodes].forEach(обработать);
        return { blocks: blocks.length ? blocks : [{ type: 'p', spans: [] }] };
    }

    return { вДом, изДома, отрезкиИзУзла };
})();
