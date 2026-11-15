/**
 * Редактор фото: повернуть, выровнять наклон, обрезать, поправить свет.
 *
 *   const снимок = await PhotoEditor.open(файлИлиАдрес, { соотношение: 3 / 2 });
 *   // Blob (JPEG до 1600 px) — или null, если человек нажал «Отмена»
 *
 * Обрезку и жесты пальцами берёт Cropper.js (подгружается при первом
 * открытии). Свет на экране показывается CSS-фильтром, а в файл
 * переносится попиксельно по тем же формулам — что видно, то и сохранится.
 * Подписи свои, на трёх языках: редактор не зависит от таблицы переводов.
 */
const PhotoEditor = (() => {
    const CDN = 'https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/';
    const МАКС_СТОРОНА = 1600;
    const КАЧЕСТВО = 0.88;

    const т = варианты => (window.поЯзыку ? поЯзыку(варианты) : варианты.ru);
    const С = {
        заголовок: { ru: 'Фото товара', en: 'Item photo', hi: 'वस्तु का चित्र' },
        отмена: { ru: 'Отмена', en: 'Cancel', hi: 'रद्द करें' },
        готово: { ru: 'Готово', en: 'Done', hi: 'हो गया' },
        кадр: { ru: 'Кадр', en: 'Crop', hi: 'काट' },
        свет: { ru: 'Свет', en: 'Light', hi: 'रोशनी' },
        какНаКассе: { ru: '3:2 · как на кассе', en: '3:2 · as at the till', hi: '3:2 · काउंटर जैसा' },
        квадрат: { ru: '1:1', en: '1:1', hi: '1:1' },
        свободно: { ru: 'Свободно', en: 'Free', hi: 'मुक्त' },
        влево: { ru: 'Повернуть влево', en: 'Rotate left', hi: 'बाएँ घुमाएँ' },
        вправо: { ru: 'Повернуть вправо', en: 'Rotate right', hi: 'दाएँ घुमाएँ' },
        наклон: { ru: 'Наклон', en: 'Straighten', hi: 'सीधा करें' },
        яркость: { ru: 'Яркость', en: 'Brightness', hi: 'चमक' },
        контраст: { ru: 'Контраст', en: 'Contrast', hi: 'कंट्रास्ट' },
        насыщенность: { ru: 'Насыщенность', en: 'Saturation', hi: 'रंग गहराई' },
        авто: { ru: 'Авто', en: 'Auto', hi: 'स्वतः' },
        сбросить: { ru: 'Сбросить', en: 'Reset', hi: 'रीसेट' },
        подсказка: { ru: 'Фото двигается, рамка тянется за углы, масштаб — щипком или колёсиком',
                     en: 'Drag the photo, pull the frame by its corners, zoom with a pinch or the wheel',
                     hi: 'चित्र खिसकाएँ, कोनों से फ़्रेम खींचें, पिंच या व्हील से ज़ूम' },
        неОткрылось: { ru: 'Это фото не открывается для правки — оно загрузится как есть',
                       en: 'This photo cannot be edited here; it will upload as is',
                       hi: 'यह चित्र यहाँ संपादित नहीं होता; जैसा है वैसा अपलोड होगा' },
        неСохранилось: { ru: 'Не получилось сохранить правку фото', en: 'Could not save the photo edit',
                         hi: 'चित्र का संपादन सहेजा नहीं जा सका' },
    };

    const ИКОНКА = {
        влево: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        вправо: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
        авто: '<path d="m12 3-1.9 5.8L4 10l6.1 1.2L12 17l1.9-5.8L20 10l-6.1-1.2Z"/>',
    };
    const svg = путь => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${путь}</svg>`;

    // ---------- подгрузка Cropper.js ----------
    let подгрузка = null;
    function подключить() {
        if (window.Cropper) return Promise.resolve();
        if (подгрузка) return подгрузка;
        подгрузка = new Promise((готово, ошибка) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = CDN + 'cropper.min.css';
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = CDN + 'cropper.min.js';
            js.onload = () => готово();
            js.onerror = () => { подгрузка = null; ошибка(new Error('Cropper.js не загрузился')); };
            document.head.appendChild(js);
        });
        return подгрузка;
    }

    // ---------- окно ----------
    const СТИЛЬ = `
        .фр { margin: 0; padding: 0; border: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none;
              background: #111315; color: #eef0f2; }
        .фр[open] { display: flex; flex-direction: column; }
        .фр::backdrop { background: #111315; }
        .фр [hidden] { display: none !important; }   /* иначе display у панелей перебивает hidden */
        .фр-верх { display: flex; align-items: center; gap: 8px; padding: calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px; }
        .фр-верх .фр-заголовок { flex: 1; text-align: center; font-weight: 600; font-size: 15px; }
        .фр-кнопка { background: none; border: 0; color: inherit; font: inherit; font-size: 15px; padding: 10px 12px;
                     border-radius: 10px; cursor: pointer; min-height: 44px; }
        .фр-кнопка:hover { background: #ffffff14; }
        .фр-кнопка:focus-visible, .фр-чип:focus-visible, .фр-значок:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px; }
        .фр-готово { background: var(--current-color, #0284c7); color: #fff; font-weight: 600; padding: 10px 18px; }
        .фр-готово:hover { background: var(--current-color, #0284c7); filter: brightness(1.08); }
        .фр-готово:disabled { opacity: .6; cursor: progress; }
        .фр-холст { flex: 1; min-height: 0; position: relative; overflow: hidden; }
        .фр-холст > img { display: block; max-width: 100%; }
        .фр-холст .cropper-canvas img, .фр-холст .cropper-view-box img { filter: var(--фр-фильтр, none); }
        .фр-холст .cropper-modal { background: #000; opacity: .55; }
        .фр-загрузка { position: absolute; inset: 0; display: grid; place-items: center; }
        .фр-низ { padding: 10px 14px calc(env(safe-area-inset-bottom, 0px) + 12px); display: flex; flex-direction: column;
                  gap: 12px; max-width: 640px; width: 100%; margin: 0 auto; }
        .фр-подсказка { font-size: 12px; color: #a9b0b8; text-align: center; }
        .фр-вкладки { display: flex; gap: 4px; background: #ffffff10; border-radius: 12px; padding: 4px; }
        .фр-вкладки button { flex: 1; background: none; border: 0; color: #c9ced4; font: inherit; font-size: 14px;
                             font-weight: 600; padding: 9px; border-radius: 9px; cursor: pointer; }
        .фр-вкладки button[aria-selected="true"] { background: #ffffff1f; color: #fff; }
        /* обе панели лежат в одной клетке: высота низа не скачет при смене вкладки,
           и окно с фото под ней не меняет размер */
        .фр-панели { display: grid; }
        .фр-панель { grid-area: 1 / 1; display: flex; flex-direction: column; gap: 12px; }
        .фр .фр-панель[hidden] { display: flex !important; visibility: hidden; }
        .фр-ряд { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .фр-чип { background: #ffffff10; border: 1px solid #ffffff26; color: #e6e9ec; font: inherit; font-size: 13px;
                  padding: 8px 12px; border-radius: 999px; cursor: pointer; min-height: 38px; }
        .фр-чип[aria-pressed="true"] { background: #fff; color: #111315; border-color: #fff; font-weight: 600; }
        .фр-значок { background: #ffffff10; border: 1px solid #ffffff26; color: #e6e9ec; width: 44px; height: 44px;
                     border-radius: 12px; display: grid; place-items: center; cursor: pointer; }
        .фр-значок:hover, .фр-чип:hover { background: #ffffff1f; }
        .фр-чип[aria-pressed="true"]:hover { background: #fff; }
        .фр-ползунок { display: grid; grid-template-columns: 110px 1fr 44px; align-items: center; gap: 10px; font-size: 13px; }
        .фр-ползунок output { text-align: right; font-variant-numeric: tabular-nums; color: #c9ced4; }
        .фр-ползунок input { width: 100%; accent-color: var(--current-color, #0284c7); height: 28px; }
        .фр-наклон { flex-wrap: nowrap; }
        .фр-наклон .фр-ползунок { flex: 1; min-width: 0; grid-template-columns: auto 1fr 44px; padding-left: 6px; }
        @media (max-width: 420px) { .фр-ползунок { grid-template-columns: 92px 1fr 40px; } }
    `;

    let окно = null;
    function построить() {
        if (окно) return окно;
        const стиль = document.createElement('style');
        стиль.textContent = СТИЛЬ;
        document.head.appendChild(стиль);

        окно = document.createElement('dialog');
        окно.className = 'фр';
        окно.setAttribute('aria-label', т(С.заголовок));
        const ползунок = (имя, мин, макс, шаг) => `
            <label class="фр-ползунок"><span>${т(С[имя])}</span>
                <input type="range" min="${мин}" max="${макс}" step="${шаг}" value="0" data-фр-ползунок="${имя}">
                <output data-фр-значение="${имя}">0</output></label>`;
        окно.innerHTML = `
            <div class="фр-верх">
                <button type="button" class="фр-кнопка" data-фр="отмена">${т(С.отмена)}</button>
                <span class="фр-заголовок">${т(С.заголовок)}</span>
                <button type="button" class="фр-кнопка фр-готово" data-фр="готово">${т(С.готово)}</button>
            </div>
            <div class="фр-холст"><img alt=""><div class="фр-загрузка"><span class="loading loading-spinner loading-md"></span></div></div>
            <div class="фр-низ">
                <div class="фр-вкладки" role="tablist">
                    <button type="button" role="tab" data-фр-вкладка="кадр" aria-selected="true">${т(С.кадр)}</button>
                    <button type="button" role="tab" data-фр-вкладка="свет" aria-selected="false">${т(С.свет)}</button>
                </div>
                <div class="фр-панели">
                <div class="фр-панель" data-фр-панель="кадр">
                    <div class="фр-ряд">
                        <button type="button" class="фр-чип" data-фр-рамка="1.5">${т(С.какНаКассе)}</button>
                        <button type="button" class="фр-чип" data-фр-рамка="1">${т(С.квадрат)}</button>
                        <button type="button" class="фр-чип" data-фр-рамка="0">${т(С.свободно)}</button>
                    </div>
                    <div class="фр-ряд фр-наклон">
                        <button type="button" class="фр-значок" data-фр="влево" title="${т(С.влево)}" aria-label="${т(С.влево)}">${svg(ИКОНКА.влево)}</button>
                        <button type="button" class="фр-значок" data-фр="вправо" title="${т(С.вправо)}" aria-label="${т(С.вправо)}">${svg(ИКОНКА.вправо)}</button>
                        ${ползунок('наклон', -15, 15, 0.5)}
                    </div>
                    <div class="фр-подсказка">${т(С.подсказка)}</div>
                </div>
                <div class="фр-панель" data-фр-панель="свет" hidden>
                    ${ползунок('яркость', -50, 50, 1)}
                    ${ползунок('контраст', -50, 50, 1)}
                    ${ползунок('насыщенность', -100, 100, 1)}
                    <div class="фр-ряд">
                        <button type="button" class="фр-чип" data-фр="авто">${svg(ИКОНКА.авто).replace('width="20" height="20"', 'width="16" height="16" style="display:inline;vertical-align:-3px;margin-right:4px"')}${т(С.авто)}</button>
                        <button type="button" class="фр-чип" data-фр="сброситьСвет">${т(С.сбросить)}</button>
                    </div>
                </div>
                </div>
            </div>`;
        document.body.appendChild(окно);
        return окно;
    }

    // ---------- состояние одного сеанса правки ----------
    let кроппер = null, база = 0, наклон = 0, рамка = 1.5;
    let свет = { яркость: 0, контраст: 0, насыщенность: 0 };
    let исход = null;            // resolve обещания open()
    let адресКартинки = null;    // object URL, если открывали файл

    const $ = с => окно.querySelector(с);

    /** Множители CSS-фильтра из положения ползунков. */
    const множители = () => ({
        b: 1 + свет.яркость / 100,
        c: 1 + свет.контраст / 100,
        s: 1 + свет.насыщенность / 100,
    });

    function показатьСвет() {
        const { b, c, s } = множители();
        окно.style.setProperty('--фр-фильтр', `brightness(${b}) contrast(${c}) saturate(${s})`);
        for (const имя of Object.keys(свет)) {
            $(`[data-фр-ползунок="${имя}"]`).value = свет[имя];
            $(`[data-фр-значение="${имя}"]`).textContent = (свет[имя] > 0 ? '+' : '') + свет[имя];
        }
    }

    function показатьКадр() {
        окно.querySelectorAll('[data-фр-рамка]').forEach(б =>
            б.setAttribute('aria-pressed', String(Number(б.getAttribute('data-фр-рамка')) === рамка)));
        $('[data-фр-ползунок="наклон"]').value = наклон;
        $('[data-фр-значение="наклон"]').textContent = (наклон > 0 ? '+' : '') + наклон + '°';
    }

    /**
     * Самая большая рамка нужной формы, целиком лежащая на повёрнутом фото:
     * при наклоне по углам иначе остались бы белые клинья.
     */
    function вписатьРамку() {
        if (!кроппер) return;
        const холст = кроппер.getCanvasData();
        const фото = кроппер.getImageData();
        // размер фото на экране после поворота на 90°, ещё без наклона
        const поперёк = база % 180 !== 0;
        const nw = поперёк ? фото.naturalHeight : фото.naturalWidth;
        const nh = поперёк ? фото.naturalWidth : фото.naturalHeight;
        const у = Math.abs(наклон) * Math.PI / 180;
        const масштаб = холст.width / (nw * Math.cos(у) + nh * Math.sin(у));
        const w = nw * масштаб, h = nh * масштаб;
        const cos = Math.cos(у), sin = Math.sin(у);
        const r = рамка || w / h;
        const высота = Math.min(w / (r * cos + sin), h / (r * sin + cos));
        const ширина = высота * r;
        кроппер.setCropBoxData({
            left: холст.left + (холст.width - ширина) / 2,
            top: холст.top + (холст.height - высота) / 2,
            width: ширина,
            height: высота,
        });
    }

    /** Повёрнутое фото целиком в окне, по центру: иначе после 90° оно вылезает за край. */
    function вместить() {
        const окноФото = кроппер.getContainerData();
        const холст = кроппер.getCanvasData();
        const м = Math.min(окноФото.width / холст.width, окноФото.height / холст.height);
        const w = холст.width * м, h = холст.height * м;
        кроппер.setCanvasData({ left: (окноФото.width - w) / 2, top: (окноФото.height - h) / 2, width: w, height: h });
    }

    function повернуть() {
        кроппер.rotateTo(база + наклон);
        вместить();
        вписатьРамку();
    }

    /** «Авто»: растянуть тона по гистограмме уменьшенной копии и чуть добавить цвета. */
    function авто() {
        const картинка = $('.фр-холст > img');
        const к = document.createElement('canvas');
        const м = 96 / Math.max(картинка.naturalWidth, картинка.naturalHeight);
        к.width = Math.max(1, Math.round(картинка.naturalWidth * м));
        к.height = Math.max(1, Math.round(картинка.naturalHeight * м));
        const ctx = к.getContext('2d', { willReadFrequently: true });
        let данные;
        try {
            ctx.drawImage(картинка, 0, 0, к.width, к.height);
            данные = ctx.getImageData(0, 0, к.width, к.height).data;
        } catch { return; }
        const яркости = [];
        for (let i = 0; i < данные.length; i += 4) {
            яркости.push((0.2126 * данные[i] + 0.7152 * данные[i + 1] + 0.0722 * данные[i + 2]) / 255);
        }
        яркости.sort((a, b) => a - b);
        const дол = q => яркости[Math.min(яркости.length - 1, Math.floor(q * яркости.length))];
        const низ = дол(0.02), верх = дол(0.98), середина = дол(0.5);
        const округл = (x, a, b) => Math.round(Math.min(b, Math.max(a, x)));
        свет.контраст = округл((0.92 / Math.max(0.2, верх - низ) - 1) * 100, 0, 35);
        свет.яркость = округл((0.5 / Math.max(0.15, середина) - 1) * 100 * 0.6, -25, 35);
        свет.насыщенность = 12;
        показатьСвет();
    }

    // ---------- сохранение ----------
    /** Те же формулы, что у CSS brightness → contrast → saturate (в sRGB). */
    function наложитьСвет(холст) {
        const { b, c, s } = множители();
        if (b === 1 && c === 1 && s === 1) return;
        const ctx = холст.getContext('2d');
        const кадр = ctx.getImageData(0, 0, холст.width, холст.height);
        const д = кадр.data;
        const сдвигК = 0.5 - 0.5 * c;
        const m = [
            0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
            0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
            0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
        ];
        const к01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
        for (let i = 0; i < д.length; i += 4) {
            let r = к01(к01(д[i] / 255 * b) * c + сдвигК);
            let g = к01(к01(д[i + 1] / 255 * b) * c + сдвигК);
            let bl = к01(к01(д[i + 2] / 255 * b) * c + сдвигК);
            д[i] = к01(m[0] * r + m[1] * g + m[2] * bl) * 255;
            д[i + 1] = к01(m[3] * r + m[4] * g + m[5] * bl) * 255;
            д[i + 2] = к01(m[6] * r + m[7] * g + m[8] * bl) * 255;
        }
        ctx.putImageData(кадр, 0, 0);
    }

    async function готово() {
        const кнопка = $('[data-фр="готово"]');
        if (!кроппер || кнопка.disabled) return;
        кнопка.disabled = true;
        try {
            const холст = кроппер.getCroppedCanvas({
                maxWidth: МАКС_СТОРОНА, maxHeight: МАКС_СТОРОНА,
                fillColor: '#fff', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
            });
            наложитьСвет(холст);
            const блоб = await new Promise(r => холст.toBlob(r, 'image/jpeg', КАЧЕСТВО));
            if (!блоб) throw new Error('toBlob вернул пусто');
            закрыть(блоб);
        } catch (ош) {
            console.error(ош);
            window.Layout?.showNotification?.(т(С.неСохранилось), 'error');
        } finally {
            кнопка.disabled = false;
        }
    }

    function закрыть(результат) {
        кроппер?.destroy();
        кроппер = null;
        if (адресКартинки) { URL.revokeObjectURL(адресКартинки); адресКартинки = null; }
        if (окно.open) окно.close();
        const r = исход;
        исход = null;
        r?.(результат);
    }

    // ---------- события ----------
    let слушаем = false;
    function слушать() {
        if (слушаем) return;
        слушаем = true;
        окно.addEventListener('click', ev => {
            const б = ev.target.closest('button');
            if (!б) return;
            const что = б.dataset.фр;
            if (что === 'отмена') return закрыть(null);
            if (что === 'готово') return готово();
            if (!кроппер) return;
            if (что === 'влево' || что === 'вправо') {
                база = (база + (что === 'влево' ? 270 : 90)) % 360;
                return повернуть();
            }
            if (что === 'авто') return авто();
            if (что === 'сброситьСвет') {
                свет = { яркость: 0, контраст: 0, насыщенность: 0 };
                return показатьСвет();
            }
            // dataset тут не годится: дефис перед кириллицей не превращается в camelCase
            const рамкаКнопки = б.getAttribute('data-фр-рамка');
            if (рамкаКнопки !== null) {
                рамка = Number(рамкаКнопки);
                кроппер.setAspectRatio(рамка || NaN);
                вписатьРамку();
                return показатьКадр();
            }
            const вкладка = б.getAttribute('data-фр-вкладка');
            if (вкладка) {
                окно.querySelectorAll('[data-фр-вкладка]').forEach(в =>
                    в.setAttribute('aria-selected', String(в === б)));
                окно.querySelectorAll('[data-фр-панель]').forEach(п => {
                    п.hidden = п.getAttribute('data-фр-панель') !== вкладка;
                });
            }
        });
        окно.addEventListener('input', ev => {
            const имя = ev.target.getAttribute?.('data-фр-ползунок');
            if (!имя) return;
            const значение = Number(ev.target.value);
            if (имя === 'наклон') {
                наклон = значение;
                показатьКадр();
                if (кроппер) повернуть();
                return;
            }
            свет[имя] = значение;
            показатьСвет();
        });
        // двойной тап по ползунку возвращает его в ноль
        окно.addEventListener('dblclick', ev => {
            const имя = ev.target.getAttribute?.('data-фр-ползунок');
            if (!имя) return;
            if (имя === 'наклон') { наклон = 0; показатьКадр(); if (кроппер) повернуть(); return; }
            свет[имя] = 0;
            показатьСвет();
        });
        // Esc — как «Отмена»
        окно.addEventListener('cancel', ev => { ev.preventDefault(); закрыть(null); });
    }

    // ---------- вход ----------
    /**
     * @param {File|Blob|string} источник — файл с телефона или адрес уже загруженного фото
     * @param {{соотношение?: number}} [настройки] — стартовая рамка: 1.5 (3:2), 1 или 0 (свободно)
     * @returns {Promise<Blob|null>}
     */
    async function open(источник, настройки = {}) {
        if (исход) закрыть(null);
        построить();
        слушать();

        база = 0; наклон = 0;
        рамка = настройки.соотношение ?? 1.5;
        свет = { яркость: 0, контраст: 0, насыщенность: 0 };
        показатьСвет();
        показатьКадр();
        окно.querySelector('[data-фр-вкладка="кадр"]').click();
        $('.фр-загрузка').hidden = false;

        const ждём = new Promise(r => { исход = r; });
        окно.showModal();

        const картинка = $('.фр-холст > img');
        const новая = document.createElement('img');   // чистый <img>: прежний Cropper оставлял на старом свои метки
        новая.alt = '';
        картинка.replaceWith(новая);
        if (typeof источник === 'string') {
            новая.crossOrigin = 'anonymous';
            новая.src = источник;
        } else {
            адресКартинки = URL.createObjectURL(источник);
            новая.src = адресКартинки;
        }

        try {
            await Promise.all([
                подключить(),
                новая.decode ? новая.decode() : new Promise((ok, no) => { новая.onload = ok; новая.onerror = no; }),
            ]);
        } catch (ош) {
            console.warn('Фото не открылось для правки', ош);
            window.Layout?.showNotification?.(т(С.неОткрылось), 'warning');
            // файл всё равно отдаём: лучше фото без правки, чем никакого
            закрыть(typeof источник === 'string' ? null : источник);
            return ждём;
        }
        if (!исход) return ждём;      // закрыли, пока грузилось

        кроппер = new Cropper(новая, {
            viewMode: 1,
            dragMode: 'move',
            aspectRatio: рамка || NaN,
            autoCropArea: 1,
            background: false,
            checkOrientation: false,     // ориентацию по EXIF браузер уже применил сам
            checkCrossOrigin: false,
            toggleDragModeOnDblclick: false,
            restore: false,
            ready() {
                $('.фр-загрузка').hidden = true;
                вписатьРамку();
            },
        });
        return ждём;
    }

    return { open };
})();

window.PhotoEditor = PhotoEditor;
