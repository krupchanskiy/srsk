/**
 * Документ статьи: формат, отрисовка, оглавление.
 *
 * Текст хранится не как HTML, а структурой:
 *
 *   { "blocks": [
 *       { "type": "p",    "spans": [{"t": "Начинается в "}, {"t": "4:30", "b": true}] },
 *       { "type": "h2",   "text": "Что приготовить" },
 *       { "type": "ul",   "items": [[{"t": "Гхи в лампаде"}], [{"t": "Свежая вода"}]] },
 *       { "type": "ol",   "items": ["Дхупа", "Дипа"] },
 *       { "type": "note", "text": "Если лампада гаснет — выйти и зажечь в стороне." },
 *       { "type": "img",  "path": "<путь в хранилище>", "caption": "Алтарь утром" }
 *   ] }
 *
 * Кусок текста — это либо строка, либо набор отрезков: {t: текст, b: жирный,
 * href: ссылка}. Строка и набор равноправны, чтобы простые блоки оставались
 * простыми.
 *
 * Почему не HTML: сохранённый HTML пришлось бы чистить, а чистка в браузере
 * ничего не защищает — публичный ключ позволяет записать что угодно напрямую.
 * Здесь же отрисовка собирает узлы вручную и кладёт текст через textContent,
 * поэтому выполнить чужой скрипт невозможно по построению, а не по бдительности.
 * Единственное место, где браузер всё же разбирает строку, — адрес ссылки,
 * и он пропускается через белый список схем.
 */
const WorshipDoc = (() => {

    const ТИПЫ = ['p', 'h2', 'h3', 'ul', 'ol', 'note', 'img'];
    const СТРОЧНЫЕ = ['p', 'h2', 'h3', 'note'];     // блоки с текстом
    const СПИСКИ = ['ul', 'ol'];

    /** Пустой документ — чтобы не писать проверки на null в каждом месте. */
    const пустой = () => ({ blocks: [{ type: 'p', text: '' }] });

    /**
     * Адрес ссылки. Всё, кроме явно разрешённого, отбрасывается: «javascript:»
     * и «data:» в href — это выполнение кода у читателя.
     */
    function адрес(href) {
        const s = String(href || '').trim();
        if (!s) return null;
        if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
        // внутренняя ссылка на статью модуля
        if (/^[\w./?=&-]+$/.test(s) && !s.includes(':')) return s;
        return null;
    }

    /** Отрезки текста: строка превращается в один отрезок без оформления. */
    function отрезки(значение) {
        if (typeof значение === 'string') return значение ? [{ t: значение }] : [];
        if (!Array.isArray(значение)) return [];
        return значение
            .filter(о => о && typeof о.t === 'string' && о.t !== '')
            .map(о => {
                const чистый = { t: о.t };
                if (о.b === true) чистый.b = true;
                const ссылка = о.href ? адрес(о.href) : null;
                if (ссылка) чистый.href = ссылка;
                return чистый;
            });
    }

    /** Текст куска — без оформления. */
    const плоско = значение => отрезки(значение).map(о => о.t).join('');

    /** Содержимое строчного блока: spans, если есть, иначе text. */
    const кусок = б => (б.spans !== undefined ? б.spans : б.text);

    /** Приводит что угодно к документу: битые блоки молча отбрасываются. */
    function разобрать(данные) {
        if (!данные || typeof данные !== 'object' || !Array.isArray(данные.blocks)) {
            return { blocks: [] };
        }
        const blocks = [];
        данные.blocks.forEach(б => {
            if (!б || !ТИПЫ.includes(б.type)) return;

            if (СТРОЧНЫЕ.includes(б.type)) {
                blocks.push({ type: б.type, spans: отрезки(кусок(б)) });

            } else if (СПИСКИ.includes(б.type)) {
                const items = (Array.isArray(б.items) ? б.items : [])
                    .map(отрезки).filter(о => о.length);
                blocks.push({ type: б.type, items });

            } else if (б.type === 'img' && typeof б.path === 'string' && б.path) {
                blocks.push({ type: 'img', path: б.path, caption: String(б.caption || '') });
            }
        });
        return { blocks };
    }

    /** Текст без разметки: для поиска, сравнения версий и краткого описания. */
    function текст(документ) {
        return разобрать(документ).blocks.map(б => {
            if (б.items) return б.items.map(плоско).join('\n');
            if (б.type === 'img') return б.caption || '';
            return плоско(б.spans);
        }).filter(Boolean).join('\n');
    }

    /** Пути к снимкам: по ним страница заранее берёт ссылки ограниченного срока. */
    function пути(документ) {
        return разобрать(документ).blocks.filter(б => б.type === 'img').map(б => б.path);
    }

    /** Заголовки для оглавления: только они получают якоря. */
    function заголовки(документ) {
        return разобрать(документ).blocks
            .map((б, i) => ({ ...б, якорь: `z${i}` }))
            .filter(б => б.type === 'h2' || б.type === 'h3')
            .map(б => ({ якорь: б.якорь, текст: плоско(б.spans), уровень: б.type === 'h2' ? 2 : 3 }));
    }

    /** Собирает отрезки в узлы: жирный и ссылка, больше ничего. */
    function вставитьОтрезки(узел, значение) {
        отрезки(значение).forEach(о => {
            let часть = document.createTextNode(о.t);
            if (о.b) {
                const strong = document.createElement('strong');
                strong.appendChild(часть);
                часть = strong;
            }
            if (о.href) {
                const a = document.createElement('a');
                a.href = о.href;
                a.className = 'link';
                if (/^https?:/i.test(о.href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
                a.appendChild(часть);
                часть = a;
            }
            узел.appendChild(часть);
        });
    }

    /**
     * Собирает документ в узлы DOM. Возвращает фрагмент — вызывающий сам решает,
     * куда его вставить. `ссылки` — карта «путь → адрес снимка»; без неё
     * картинка остаётся местом под картинку с подписью.
     */
    function нарисовать(документ, ссылки = {}) {
        const фрагмент = document.createDocumentFragment();

        разобрать(документ).blocks.forEach((б, i) => {
            let узел;

            if (б.type === 'h2' || б.type === 'h3') {
                узел = document.createElement(б.type);
                узел.id = `z${i}`;
                узел.className = б.type === 'h2'
                    ? 'text-xl font-bold mt-7 mb-3 scroll-mt-32'
                    : 'text-lg font-semibold mt-5 mb-2 scroll-mt-32';
                вставитьОтрезки(узел, б.spans);

            } else if (б.type === 'ul' || б.type === 'ol') {
                узел = document.createElement(б.type);
                узел.className = 'mb-4 pl-6 space-y-1 ' +
                    (б.type === 'ul' ? 'list-disc' : 'list-decimal');
                б.items.forEach(строка => {
                    const li = document.createElement('li');
                    вставитьОтрезки(li, строка);
                    узел.appendChild(li);
                });

            } else if (б.type === 'note') {
                узел = document.createElement('div');
                узел.className = 'my-5 rounded-lg px-4 py-3 bg-base-200 text-[15px] leading-relaxed';
                вставитьОтрезки(узел, б.spans);

            } else if (б.type === 'img') {
                узел = document.createElement('figure');
                узел.className = 'my-5';
                const адресСнимка = ссылки[б.path];
                if (адресСнимка) {
                    const img = document.createElement('img');
                    img.src = адресСнимка;
                    img.alt = б.caption || '';
                    img.loading = 'lazy';
                    img.className = 'rounded-lg max-w-full';
                    узел.appendChild(img);
                } else {
                    const заглушка = document.createElement('div');
                    заглушка.className = 'rounded-lg bg-base-200 px-4 py-6 text-sm opacity-60';
                    заглушка.textContent = 'Снимок не загрузился';
                    узел.appendChild(заглушка);
                }
                if (б.caption) {
                    const подпись = document.createElement('figcaption');
                    подпись.className = 'text-sm opacity-60 mt-2';
                    подпись.textContent = б.caption;
                    узел.appendChild(подпись);
                }

            } else {
                узел = document.createElement('p');
                узел.className = 'mb-4 leading-relaxed';
                вставитьОтрезки(узел, б.spans);
            }

            фрагмент.appendChild(узел);
        });

        return фрагмент;
    }

    /**
     * Ссылки ограниченного срока на снимки документа. Бакет приватный,
     * поэтому без этого шага картинки не покажутся.
     */
    async function ссылкиНаСнимки(db, документ, секунд = 3600) {
        const список = пути(документ);
        if (!список.length) return {};
        const { data, error } = await db.storage.from('worship').createSignedUrls(список, секунд);
        if (error) return {};
        const карта = {};
        (data || []).forEach(з => { if (з.signedUrl) карта[з.path] = з.signedUrl; });
        return карта;
    }

    return { пустой, разобрать, текст, пути, заголовки, нарисовать, ссылкиНаСнимки, адрес, плоско };
})();
