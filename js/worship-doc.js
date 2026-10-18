/**
 * Документ статьи: формат, отрисовка, оглавление.
 *
 * Текст хранится не как HTML, а структурой:
 *
 *   { "blocks": [
 *       { "type": "p",    "text": "Начинается в 4:30." },
 *       { "type": "h2",   "text": "Что приготовить" },
 *       { "type": "ul",   "items": ["Гхи в лампаде", "Свежая вода"] },
 *       { "type": "ol",   "items": ["Дхупа", "Дипа"] },
 *       { "type": "note", "text": "Если лампада гаснет — выйти и зажечь в стороне." },
 *       { "type": "img",  "src": "<путь в хранилище>", "caption": "Алтарь утром" }
 *   ] }
 *
 * Почему не HTML: сохранённый HTML пришлось бы чистить, а чистка в браузере
 * ничего не защищает — публичный ключ позволяет записать что угодно напрямую.
 * Здесь же отрисовка собирает узлы вручную и кладёт текст через textContent,
 * поэтому выполнить чужой скрипт невозможно по построению, а не по бдительности.
 */
const WorshipDoc = (() => {

    const ТИПЫ = ['p', 'h2', 'h3', 'ul', 'ol', 'note', 'img'];

    /** Пустой документ — чтобы не писать проверки на null в каждом месте. */
    const пустой = () => ({ blocks: [] });

    /** Приводит что угодно к документу: битые блоки молча отбрасываются. */
    function разобрать(данные) {
        if (!данные || typeof данные !== 'object' || !Array.isArray(данные.blocks)) return пустой();
        const blocks = данные.blocks.filter(б => б && ТИПЫ.includes(б.type));
        return { blocks };
    }

    /** Текст без разметки: для поиска, сравнения версий и краткого описания. */
    function текст(документ) {
        return разобрать(документ).blocks.map(б => {
            if (Array.isArray(б.items)) return б.items.join('\n');
            if (б.type === 'img') return б.caption || '';
            return б.text || '';
        }).filter(Boolean).join('\n');
    }

    /** Заголовки для оглавления: только они получают якоря. */
    function заголовки(документ) {
        return разобрать(документ).blocks
            .map((б, i) => ({ ...б, якорь: `z${i}` }))
            .filter(б => б.type === 'h2' || б.type === 'h3')
            .map(б => ({ якорь: б.якорь, текст: б.text || '', уровень: б.type === 'h2' ? 2 : 3 }));
    }

    /**
     * Собирает документ в узлы DOM. Возвращает фрагмент — вызывающий сам решает,
     * куда его вставить.
     */
    function нарисовать(документ) {
        const фрагмент = document.createDocumentFragment();

        разобрать(документ).blocks.forEach((б, i) => {
            let узел;

            if (б.type === 'h2' || б.type === 'h3') {
                узел = document.createElement(б.type);
                узел.id = `z${i}`;
                узел.className = б.type === 'h2'
                    ? 'text-xl font-bold mt-7 mb-3 scroll-mt-32'
                    : 'text-lg font-semibold mt-5 mb-2 scroll-mt-32';
                узел.textContent = б.text || '';

            } else if (б.type === 'ul' || б.type === 'ol') {
                узел = document.createElement(б.type);
                узел.className = 'mb-4 pl-6 space-y-1 ' +
                    (б.type === 'ul' ? 'list-disc' : 'list-decimal');
                (б.items || []).forEach(строка => {
                    const li = document.createElement('li');
                    li.textContent = строка;
                    узел.appendChild(li);
                });

            } else if (б.type === 'note') {
                узел = document.createElement('div');
                узел.className = 'my-5 rounded-lg px-4 py-3 bg-base-200 text-[15px] leading-relaxed';
                узел.textContent = б.text || '';

            } else if (б.type === 'img') {
                узел = document.createElement('figure');
                узел.className = 'my-5';
                const img = document.createElement('img');
                img.src = б.src || '';
                img.alt = б.caption || '';
                img.loading = 'lazy';
                img.className = 'rounded-lg max-w-full';
                узел.appendChild(img);
                if (б.caption) {
                    const подпись = document.createElement('figcaption');
                    подпись.className = 'text-sm opacity-60 mt-2';
                    подпись.textContent = б.caption;
                    узел.appendChild(подпись);
                }

            } else {
                узел = document.createElement('p');
                узел.className = 'mb-4 leading-relaxed';
                узел.textContent = б.text || '';
            }

            фрагмент.appendChild(узел);
        });

        return фрагмент;
    }

    return { пустой, разобрать, текст, заголовки, нарисовать };
})();
