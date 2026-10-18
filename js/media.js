/**
 * Снимки: подготовка к загрузке, очередь и просмотр.
 *
 * Общий модуль, а не копия в каждом разделе: в проекте уже три разных
 * просмотрщика и своя подготовка файла в каждом месте, и расходятся они
 * ровно в мелочах, которые видно только на боевых фотографиях — повороте,
 * размере и порядке по времени съёмки.
 *
 * Что здесь решено раз и навсегда:
 *   * поворот берётся из самого файла, иначе половина снимков с телефона
 *     ложится набок: камера пишет кадр как есть и помечает, куда верх;
 *   * время съёмки оттуда же — по нему выстраивается первоначальный порядок
 *     набора, а не по порядку, в котором человек выбрал файлы;
 *   * исходники не храним: к загрузке готовится уменьшенная копия.
 */
const Media = (() => {

    const ПРЕДЕЛ_СТОРОНЫ = 1500;        // обычный набор
    const ПРЕДЕЛ_ИНСТРУКЦИИ = 2400;     // набор-инструкция к стандарту
    const КАЧЕСТВО = 0.85;

    // ---------- чтение метки в файле ----------
    /**
     * Достаёт из JPEG поворот и время съёмки. Читаем сами, без библиотеки:
     * нужны ровно два поля, а тянуть ради них стороннюю зависимость незачем.
     * Файл без разметки (PNG, снимок из мессенджера) просто даёт пустоту.
     */
    async function метка(файл) {
        const пусто = { поворот: 1, снято: null };
        try {
            const буфер = await файл.slice(0, 256 * 1024).arrayBuffer();
            const вид = new DataView(буфер);
            if (вид.byteLength < 4 || вид.getUint16(0) !== 0xFFD8) return пусто;   // не JPEG

            let i = 2;
            while (i + 4 < вид.byteLength) {
                if (вид.getUint16(i) !== 0xFFE1) {            // не APP1 — пропускаем кусок
                    if (вид.getUint16(i) < 0xFF00) break;
                    i += 2 + вид.getUint16(i + 2);
                    continue;
                }
                const длина = вид.getUint16(i + 2);
                if (вид.getUint32(i + 4) !== 0x45786966) break;   // не «Exif»

                const tiff = i + 10;
                const порядок = вид.getUint16(tiff);
                const мало = порядок === 0x4949;                  // младший байт первым
                const u16 = о => вид.getUint16(о, мало);
                const u32 = о => вид.getUint32(о, мало);

                const читатьIFD = начало => {
                    const поля = {};
                    const сколько = u16(начало);
                    for (let n = 0; n < сколько; n++) {
                        const поле = начало + 2 + n * 12;
                        if (поле + 12 > вид.byteLength) break;
                        поля[u16(поле)] = { тип: u16(поле + 2), число: u32(поле + 4), место: поле + 8 };
                    }
                    return поля;
                };

                const ifd0 = читатьIFD(tiff + u32(tiff + 4));
                const поворот = ifd0[0x0112] ? u16(ifd0[0x0112].место) : 1;

                let снято = null;
                const ссылка = ifd0[0x8769];
                if (ссылка) {
                    const exif = читатьIFD(tiff + u32(ссылка.место));
                    const поле = exif[0x9003] || exif[0x9004];     // снято / оцифровано
                    if (поле) {
                        const смещение = поле.число > 4 ? tiff + u32(поле.место) : поле.место;
                        let строка = '';
                        for (let n = 0; n < Math.min(поле.число, 19); n++) {
                            строка += String.fromCharCode(вид.getUint8(смещение + n));
                        }
                        // «2026:03:14 04:35:12» — двоеточия в дате заменяем на дефисы
                        const м = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(строка);
                        if (м) снято = `${м[1]}-${м[2]}-${м[3]}T${м[4]}:${м[5]}:${м[6]}`;
                    }
                }
                return { поворот: поворот || 1, снято };
            }
            return пусто;
        } catch {
            return пусто;                 // битая разметка не повод ронять загрузку
        }
    }

    /** Как повернуть холст, чтобы верх кадра оказался сверху. */
    function разворот(ctx, поворот, ш, в) {
        switch (поворот) {
            case 2: ctx.transform(-1, 0, 0, 1, ш, 0); break;
            case 3: ctx.transform(-1, 0, 0, -1, ш, в); break;
            case 4: ctx.transform(1, 0, 0, -1, 0, в); break;
            case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
            case 6: ctx.transform(0, 1, -1, 0, в, 0); break;
            case 7: ctx.transform(0, -1, -1, 0, в, ш); break;
            case 8: ctx.transform(0, -1, 1, 0, 0, ш); break;
            default: break;
        }
    }

    // ---------- подготовка к загрузке ----------
    /**
     * Уменьшает снимок и ставит его «на ноги». Возвращает готовый к загрузке
     * кусок, его размеры и время съёмки.
     */
    async function подготовить(файл, { предел = ПРЕДЕЛ_СТОРОНЫ, качество = КАЧЕСТВО } = {}) {
        if (!/^image\//.test(файл.type)) throw new Error('Это не изображение');
        // HEIC браузер не разбирает, а сообщение «это не похоже на изображение»
        // человеку ничего не объясняет: снимок-то настоящий, с его же телефона
        if (/heic|heif/i.test(файл.type) || /\.hei[cf]$/i.test(файл.name || '')) {
            throw new Error('Айфон снимает в HEIC, браузер его не открывает. ' +
                'В настройках камеры выберите «Наиболее совместимый» или выгрузите как JPEG');
        }

        const { поворот, снято } = await метка(файл);
        const картинка = await new Promise((готово, плохо) => {
            const чтение = new FileReader();
            чтение.onerror = () => плохо(new Error('Файл не прочитался'));
            чтение.onload = () => {
                const img = new Image();
                img.onerror = () => плохо(new Error('Это не похоже на изображение'));
                img.onload = () => готово(img);
                img.src = чтение.result;
            };
            чтение.readAsDataURL(файл);
        });

        const боком = поворот >= 5 && поворот <= 8;
        const ш = боком ? картинка.height : картинка.width;
        const в = боком ? картинка.width : картинка.height;
        const к = Math.min(1, предел / Math.max(ш, в));

        const холст = document.createElement('canvas');
        холст.width = Math.max(1, Math.round(ш * к));
        холст.height = Math.max(1, Math.round(в * к));

        const ctx = холст.getContext('2d');
        ctx.save();
        разворот(ctx, поворот, холст.width, холст.height);
        // после разворота оси могут поменяться местами
        ctx.drawImage(картинка, 0, 0, боком ? холст.height : холст.width,
                                      боком ? холст.width : холст.height);
        ctx.restore();

        const тело = await new Promise((готово, плохо) =>
            холст.toBlob(b => b ? готово(b) : плохо(new Error('Не удалось пережать')),
                         'image/jpeg', качество));

        return { тело, ширина: холст.width, высота: холст.height, снято, имя: файл.name };
    }

    // ---------- очередь ----------
    /**
     * Грузит пачку по одному, сообщая о каждом шаге. Уже загруженные не теряются,
     * неудавшиеся остаются в списке и грузятся повторно кнопкой.
     *
     * Обещания «дозагрузим после закрытия вкладки» здесь нет сознательно:
     * после перезагрузки страницы браузер теряет доступ к выбранным файлам.
     */
    async function очередь(файлы, загрузчик, { наШаг } = {}) {
        const итог = { удалось: [], неудачи: [] };
        for (let i = 0; i < файлы.length; i++) {
            const файл = файлы[i];
            наШаг?.({ номер: i + 1, всего: файлы.length, файл, состояние: 'идёт' });
            try {
                const ответ = await загрузчик(файл, i);
                итог.удалось.push({ файл, ответ });
                наШаг?.({ номер: i + 1, всего: файлы.length, файл, состояние: 'готово' });
            } catch (ош) {
                итог.неудачи.push({ файл, ошибка: ош?.message || String(ош) });
                наШаг?.({ номер: i + 1, всего: файлы.length, файл,
                          состояние: 'ошибка', ошибка: ош?.message });
            }
        }
        return итог;
    }

    // ---------- просмотр ----------
    let просмотр = null;

    /**
     * Полноэкранный просмотр: стрелки, свайп, Escape. Снимки — массив
     * { адрес, подпись }.
     */
    function открыть(снимки, начало = 0) {
        if (!снимки?.length) return;
        закрыть();

        const корень = document.createElement('div');
        корень.className = 'fixed inset-0 z-[200] bg-black/95 flex flex-col';
        корень.innerHTML = `
            <div class="flex items-center gap-3 p-3 text-white/80">
                <span class="text-sm" data-счёт></span>
                <span class="flex-1"></span>
                <button class="btn btn-sm btn-ghost text-white" data-закрыть aria-label="Закрыть">✕</button>
            </div>
            <div class="flex-1 flex items-center justify-center overflow-hidden px-2">
                <button class="btn btn-ghost text-white text-2xl shrink-0" data-шаг="-1" aria-label="Предыдущий">‹</button>
                <img class="max-h-full max-w-full object-contain" data-снимок alt="">
                <button class="btn btn-ghost text-white text-2xl shrink-0" data-шаг="1" aria-label="Следующий">›</button>
            </div>
            <div class="p-4 text-center text-white/80 text-sm" data-подпись></div>`;
        document.body.appendChild(корень);
        document.body.style.overflow = 'hidden';

        let i = Math.min(Math.max(0, начало), снимки.length - 1);
        const рисовать = () => {
            const с = снимки[i];
            корень.querySelector('[data-снимок]').src = с.адрес || '';
            корень.querySelector('[data-снимок]').alt = с.подпись || '';
            корень.querySelector('[data-подпись]').textContent = с.подпись || '';
            корень.querySelector('[data-счёт]').textContent = `${i + 1} из ${снимки.length}`;
            корень.querySelectorAll('[data-шаг]').forEach(б => { б.hidden = снимки.length < 2; });
        };
        const шаг = куда => { i = (i + куда + снимки.length) % снимки.length; рисовать(); };

        корень.addEventListener('click', ev => {
            const кнопка = ev.target.closest('[data-шаг]');
            if (кнопка) return шаг(Number(кнопка.dataset.шаг));
            if (ev.target.closest('[data-закрыть]') || ev.target === корень) закрыть();
        });

        const клавиши = ev => {
            if (ev.key === 'Escape') закрыть();
            else if (ev.key === 'ArrowLeft') шаг(-1);
            else if (ev.key === 'ArrowRight') шаг(1);
        };
        document.addEventListener('keydown', клавиши);

        let откуда = null;
        корень.addEventListener('touchstart', ev => { откуда = ev.touches[0].clientX; }, { passive: true });
        корень.addEventListener('touchend', ev => {
            if (откуда === null) return;
            const путь = ev.changedTouches[0].clientX - откуда;
            откуда = null;
            if (Math.abs(путь) > 50) шаг(путь < 0 ? 1 : -1);
        }, { passive: true });

        просмотр = { корень, клавиши };
        рисовать();
    }

    function закрыть() {
        if (!просмотр) return;
        document.removeEventListener('keydown', просмотр.клавиши);
        просмотр.корень.remove();
        document.body.style.overflow = '';
        просмотр = null;
    }

    /**
     * Ссылки на снимки живут час. Страница, открытая с утра, к обеду показывала
     * бы битые картинки, поэтому обновляем их заранее — раз в сорок минут.
     */
    function держатьСсылки(обновить, минут = 40) {
        const таймер = setInterval(() => {
            if (document.visibilityState === 'visible') обновить();
        }, минут * 60 * 1000);
        addEventListener('pagehide', () => clearInterval(таймер));
        return () => clearInterval(таймер);
    }

    return { метка, подготовить, очередь, открыть, закрыть, держатьСсылки,
             ПРЕДЕЛ_СТОРОНЫ, ПРЕДЕЛ_ИНСТРУКЦИИ };
})();
