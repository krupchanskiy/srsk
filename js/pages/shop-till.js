/**
 * Касса магазина.
 *
 * Два решения, из-за которых файл выглядит именно так:
 *  1. Связь в ашраме пропадает, а торговля останавливаться не должна. Справочник
 *     кэшируется, пробитые чеки складываются в очередь в localStorage и уходят на
 *     сервер, когда связь вернётся. Повтор безопасен: сервер отличает чеки по client_uid.
 *  2. Суммы считает сервер. Здесь они пересчитываются только для показа продавцу —
 *     ни цена, ни итог с клиента не принимаются.
 */
const ShopTill = (() => {
    const t = key => Layout.t(key);
    const e = str => Layout.escapeHtml(str ?? '');

    const КЛЮЧ_ОЧЕРЕДИ = 'srsk_shop_queue';
    const КЛЮЧ_КЭША = 'srsk_shop_catalog';
    const ШАГ = { INR: 10, RUB: 10, USD: 1, EUR: 1 };
    // причины скидок берём из словаря: продавец может работать на английском или хинди
    const ПРИЧИНЫ = () => ['shop_reason_devotee', 'shop_reason_retreat',
                           'shop_reason_markdown', 'shop_reason_wholesale'].map(k => t(k));
    const ЗНАК = { INR: '₹', RUB: '₽', USD: '$', EUR: '€' };
    const НОМИНАЛЫ = { INR: [100, 500, 2000], RUB: [500, 1000, 5000], USD: [20, 50, 100], EUR: [20, 50, 100] };

    const РИСУНКИ = {
        'Книги': `<path d="M8 9h13a5 5 0 0 1 5 5v26a4 4 0 0 0-4-4H8z"/><path d="M40 9H27a5 5 0 0 0-5 5v26a4 4 0 0 1 4-4h14z"/>`,
        'Мурти': `<circle cx="24" cy="12" r="5"/><path d="M24 17c-5 0-8 4-8 9v8h16v-8c0-5-3-9-8-9z"/><path d="M11 34h26l3 6H8z"/>`,
        'Поклонение': `<circle cx="24" cy="26" r="13" stroke-dasharray="1.5 4.2" stroke-width="3.4"/><circle cx="24" cy="10" r="3.4"/>`,
        'Ткани': `<path d="M9 14c5-4 9 4 15 0s10 4 15 0v20c-5 4-9-4-15 0s-10-4-15 0z"/>`,
        'Аюрведа': `<path d="M15 18h18v20a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3z"/><path d="M17 12h14v6H17z"/>`,
    };

    let товары = [], категории = [], цели = [], курсы = {}, сменаId = null;
    let состояние = {
        кат: null, поиск: '', корзина: [], валюта: 'INR', получено: '',
        скидка: 0, причина: null, дар: 0, цель: null, раскрыт: false,
        панельСкидки: false, видСкидки: '%', вводСкидки: '10', панельДара: false, вводДара: '',
    };
    let очередь = [], последняя = null, таймерТоста = null, идётОтправка = false;

    // База всегда отвечает с кодом ошибки, сетевой сбой приходит без него. Путать
    // нельзя: отказ сервера, принятый за обрыв связи, уедет в офлайн-очередь и там
    // будет выброшен — товар отдан, продажи нет. В неясном случае считаем отказом
    // и показываем продавцу: потерять чек хуже, чем лишний раз его переспросить.
    const этоСеть = err => {
        if (err?.code) return false;
        return !navigator.onLine ||
            /fetch|network|timeout|abort|offline|соедин/i.test(String(err?.message || ''));
    };

    const $ = s => document.querySelector(s);
    const товар = id => товары.find(x => x.id === id);
    // Layout.pluralize в проекте падает, поэтому склоняем сами — и только для русского
    const склонение = n => {
        if (Layout.currentLang !== 'ru') return n === 1 ? t('shop_item_word') : t('shop_items_word');
        const д = n % 10, дд = n % 100;
        if (д === 1 && дд !== 11) return 'позиция';
        if (д >= 2 && д <= 4 && (дд < 12 || дд > 14)) return 'позиции';
        return 'позиций';
    };
    const деньги = (n, вал = 'INR') =>
        new Intl.NumberFormat('ru-RU', { maximumFractionDigits: вал === 'USD' || вал === 'EUR' ? 2 : 0 })
            .format(n || 0) + ' ' + (ЗНАК[вал] || вал);

    // ---------- локальное хранилище ----------
    const читать = (ключ, поумолчанию) => {
        try { return JSON.parse(localStorage.getItem(ключ)) ?? поумолчанию; }
        catch { return поумолчанию; }
    };
    const писать = (ключ, значение) => {
        try { localStorage.setItem(ключ, JSON.stringify(значение)); } catch { /* приватный режим */ }
    };

    // «12,5» на русской раскладке Android: parseFloat дал бы 12
    const число = v => parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));

    // ---------- загрузка ----------
    async function загрузить() {
        const [{ data: ит, error: ош }, { data: ост }, { data: кат }, { data: ц }, { data: кур }] = await Promise.all([
            Layout.db.from('shop_items').select('id, name_ru, name_en, name_hi, translit, price, source, photo_url, category_id, unit')
                .eq('is_active', true).order('name_ru'),
            Layout.db.from('shop_v_stock').select('item_id, qty'),
            Layout.db.from('shop_categories').select('id, name_ru, name_en, name_hi, sort_order').eq('is_active', true).order('sort_order'),
            Layout.db.from('shop_goals').select('id, name_ru, name_en, name_hi').eq('is_active', true).order('sort_order'),
            // курс один на всю систему — тот, что ведёт казначей; продавцу финмодуль
            // закрыт, поэтому действующие курсы отдаёт функция магазина
            Layout.db.rpc('shop_rates_today'),
        ]);

        if (ош) throw ош;

        категории = кат || [];
        цели = ц || [];
        состояние.цель = состояние.цель || цели[0]?.id || null;

        const остатки = Object.fromEntries((ост || []).map(s => [s.item_id, Number(s.qty)]));
        const имяКат = Object.fromEntries(категории.map(k => [k.id, Layout.getName(k)]));
        товары = (ит || []).map(i => ({ ...i, имя: Layout.getName(i), остаток: остатки[i.id] ?? 0,
            кат: имяКат[i.category_id] || '—' }));

        курсы = { INR: 1 };
        (кур || []).forEach(r => { курсы[r.currency_code] = Number(r.rate); });

        писать(КЛЮЧ_КЭША, { товары, категории, цели, курсы, сохранено: Date.now() });

        // товар сняли с продажи, пока он лежал в чеке: убираем его из чека,
        // иначе отрисовка чека падала, и касса вставала до перезагрузки
        const былоВЧеке = состояние.корзина.length;
        состояние.корзина = состояние.корзина.filter(p => товар(p.id));
        if (состояние.корзина.length < былоВЧеке) {
            Layout.showNotification('Товар сняли с продажи — он убран из чека', 'warning');
        }
    }

    function изКэша() {
        const c = читать(КЛЮЧ_КЭША, null);
        if (!c) return false;
        ({ товары, категории, цели, курсы } = c);
        состояние.цель = состояние.цель || цели[0]?.id || null;
        return true;
    }

    // ---------- очередь ----------
    const вОчереди = () => очередь.length;

    function показатьОчередь() {
        const chip = $('#offlineChip');
        if (!вОчереди()) { chip.hidden = true; return; }
        chip.hidden = false;
        chip.textContent = `${t('shop_offline_queue')}: ${вОчереди()}`;
    }

    async function отправить(payload) {
        const { data, error } = await Layout.db.rpc('shop_post_sale', { payload });
        if (error) throw error;
        return data;
    }

    // Чеки, которые сервер отказался принять при досылке (например, смену
    // уже закрыли). Раньше они выпадали из очереди с тостом на 5 секунд —
    // часто, когда у экрана никого не было: товар отдан, деньги взяты,
    // а продажи в учёте нет. Теперь они лежат отдельно и висят баннером,
    // пока заведующий их не разберёт.
    const КЛЮЧ_ОТКАЗОВ = 'srsk_shop_rejected';

    function показатьОтказы() {
        const отказы = читать(КЛЮЧ_ОТКАЗОВ, []);
        let блок = document.getElementById('отказыКассы');
        if (!отказы.length) { блок?.remove(); return; }
        if (!блок) {
            блок = document.createElement('div');
            блок.id = 'отказыКассы';
            блок.className = 'alert alert-error mb-3 block';
            document.querySelector('main')?.prepend(блок);
        }
        блок.innerHTML = `
            <div class="font-semibold">Не провелись ${отказы.length} чек(а) из офлайн-очереди</div>
            <div class="text-sm">Товар отдан, деньги взяты, а продажи в учёте нет. Покажите заведующему.</div>
            <ul class="text-sm mt-1 list-disc pl-5">${отказы.map(о => `<li>${
                e(о.когда ? new Date(о.когда).toLocaleString('ru-RU') : '')} · ${
                e(String((о.чек.items || []).reduce((s, п) => s + Number(п.qty || 0), 0)))} шт. · ${
                e(о.чек.currency || '')} — ${e(о.причина || '')}</li>`).join('')}</ul>
            <button class="btn btn-sm mt-2" data-отказыРазобраны>Разобрано — убрать</button>`;
    }

    // разбор один за раз: online, таймер и старт страницы запускали его
    // одновременно — один и тот же чек уходил дважды, и второй ответ
    // «duplicate key» выглядел как отказ, а перезапись массива целиком
    // теряла продажу, сделанную, пока шёл разбор
    let разбор = null;
    function разобратьОчередь() {
        if (разбор) return разбор;
        разбор = (async () => {
            if (!вОчереди() || !navigator.onLine) return;
            for (const чек of [...очередь]) {
                try { await отправить(чек); убратьИзОчереди(чек.client_uid); }
                catch (err) {
                    // сеть — пробуем позже
                    if (этоСеть(err)) continue;
                    // этот чек уже проведён прошлой попыткой — это не отказ
                    if (err.code === '23505') { убратьИзОчереди(чек.client_uid); continue; }
                    const отказы = читать(КЛЮЧ_ОТКАЗОВ, []);
                    отказы.push({ чек, причина: err.message, когда: чек._продано || null });
                    писать(КЛЮЧ_ОТКАЗОВ, отказы);
                    убратьИзОчереди(чек.client_uid);
                    показатьОтказы();
                }
            }
            показатьОчередь();
            if (!вОчереди()) { await загрузить().catch(() => {}); рисоватьСетку(); рисоватьЧек(); }
        })().finally(() => { разбор = null; });
        return разбор;
    }

    function убратьИзОчереди(uid) {
        очередь = очередь.filter(ч => ч.client_uid !== uid);
        писать(КЛЮЧ_ОЧЕРЕДИ, очередь);
    }

    // ---------- сетка ----------
    const ВСЕ = () => t('shop_popular');
    const первая = () => [ВСЕ(), ...категории.map(k => Layout.getName(k))];

    function ходовые() {
        const порядок = читать('srsk_shop_top', []);
        const частые = порядок.map(id => товар(id)).filter(Boolean);
        return частые.length >= 4 ? частые.slice(0, 8)
            : [...частые, ...товары.filter(i => !порядок.includes(i.id))].slice(0, 8);
    }

    function видимые() {
        const q = состояние.поиск.trim().toLowerCase();
        if (q) {
            return товары.filter(i =>
                (i.name_ru || '').toLowerCase().includes(q) ||
                (i.name_en || '').toLowerCase().includes(q) ||
                (i.name_hi || '').toLowerCase().includes(q) ||
                (i.translit || '').toLowerCase().includes(q));
        }
        if (!состояние.кат || состояние.кат === ВСЕ()) return ходовые();
        return товары.filter(i => i.кат === состояние.кат);
    }

    function рисоватьЧипы() {
        $('#chips').innerHTML = первая().map(к => `
            <button type="button" class="btn btn-sm ${(к === состояние.кат || (!состояние.кат && к === ВСЕ())) && !состояние.поиск ? '' : 'btn-outline'} shrink-0"
                    data-cat="${e(к)}"
                    ${(к === состояние.кат || (!состояние.кат && к === ВСЕ())) && !состояние.поиск ? 'style="background: var(--current-color); color:#fff; border-color: var(--current-color);"' : ''}>
                ${e(к)}</button>`).join('');
    }

    function рисоватьСетку() {
        const вКорзине = id => (состояние.корзина.find(p => p.id === id) || {}).кол || 0;
        $('#goods').innerHTML = видимые().map(i => {
            const n = вКорзине(i.id);
            const мало = i.остаток > 0 && i.остаток <= 5;
            const нет = i.остаток <= 0;
            return `
            <button type="button" class="tile card bg-base-100 border border-base-300 ${n ? 'picked' : ''}" data-add="${i.id}">
                <span class="shot bg-base-200">${i.photo_url
                    ? `<img src="${e(i.photo_url)}" alt="" loading="lazy">`
                    : `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2"
                            stroke-linejoin="round" stroke-linecap="round">${РИСУНКИ[i.кат] || РИСУНКИ['Книги']}</svg>`}</span>
                ${i.source === 'own' ? `<span class="own-mark bg-base-100 opacity-80 border border-base-300">${t('shop_ours')}</span>` : ''}
                ${n ? `<span class="badge-n nums">${n}</span>` : ''}
                <span class="nm">${e(i.имя)}</span>
                <span class="left nums ${мало || нет ? 'text-warning font-semibold' : 'opacity-60'}">
                    ${нет ? t('shop_not_in_stock') : t('shop_on_shelf') + ' ' + i.остаток}</span>
                <span class="pr nums">${деньги(i.price)}</span>
            </button>`;
        }).join('') || `<div class="col-span-full text-center opacity-60 py-10">${t('shop_nothing_found')}</div>`;
        $('#clearQ').hidden = !состояние.поиск;
    }

    // ---------- счёт ----------
    const базаЧека = () => состояние.корзина.reduce((s, p) => s + (товар(p.id)?.price || 0) * p.кол, 0);
    function считатьСкидку() {
        const v = число(состояние.вводСкидки) || 0;
        const сумма = состояние.видСкидки === '%' ? Math.round(базаЧека() * v / 100 / 10) * 10 : v;
        return Math.min(Math.max(сумма, 0), базаЧека());
    }
    const итогРупии = () => Math.max(0, базаЧека() - состояние.скидка);
    function заТовары() {
        const курс = курсы[состояние.валюта] || 1;
        const шаг = ШАГ[состояние.валюта] || 1;
        // toFixed(6): 1359 / 90.6 / 1 = 15.000000000000002, и ceil давал 16 —
        // с покупателя брали на шаг больше, чем записывал сервер
        return Math.ceil(+(итогРупии() / курс / шаг).toFixed(6)) * шаг;
    }
    const кОплате = () => заТовары() + состояние.дар;

    function рисоватьЧек() {
        const к = состояние.корзина, вал = состояние.валюта;
        const штук = к.reduce((s, p) => s + p.кол, 0);
        const всего = кОплате();
        $('#ticket').classList.toggle('open', состояние.раскрыт || innerWidth > 900);
        $('#backRow').hidden = innerWidth > 900;

        $('#cartPin').textContent = штук;
        $('#cartPin').style.visibility = штук ? 'visible' : 'hidden';
        $('#cartTitle').textContent = штук ? деньги(итогРупии()) : t('shop_cart_empty');
        $('#cartCap').textContent = штук ? `${штук} ${склонение(штук)} · ${t('shop_show_cart')}` : t('shop_tap_items');
        $('#toPay').hidden = !штук;
        $('#giftOnly').hidden = !!штук;
        $('#backSum').textContent = штук ? деньги(итогРупии()) : '';

        $('#lines').innerHTML = к.length ? к.map(p => {
            const i = товар(p.id);
            if (!i) return '';
            const сверх = p.кол > Math.max(i.остаток, 0);
            return `
            <div class="py-2 border-b border-base-200 last:border-0 flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <div class="font-semibold text-sm">${e(i.имя)}</div>
                    ${сверх ? '<div class="text-xs text-warning font-semibold">в учёте не числится</div>' : ''}
                    <div class="qty-box">
                        <button class="btn btn-sm btn-outline" data-dec="${i.id}" aria-label="минус">−</button>
                        <input class="input input-sm input-bordered nums" inputmode="numeric"
                               data-qtyin="${i.id}" value="${p.кол}" aria-label="количество">
                        <button class="btn btn-sm btn-outline" data-inc="${i.id}" aria-label="плюс">+</button>
                        <button class="btn btn-sm btn-ghost" data-del="${i.id}" aria-label="убрать">✕</button>
                    </div>
                </div>
                <div class="font-bold nums whitespace-nowrap">${деньги(i.price * p.кол)}</div>
            </div>`;
        }).join('') : `<div class="text-center opacity-60 py-6 text-sm">${состояние.дар
            ? t('shop_donation_only') : t('shop_tap_to_add')}</div>`;

        const получено = число(состояние.получено || '0');
        const сдача = получено ? получено - всего : null;
        const целиКнопки = цели.map(ц => `
            <button type="button" class="btn btn-xs ${ц.id === состояние.цель ? '' : 'btn-outline'}" data-goal="${ц.id}"
                ${ц.id === состояние.цель ? 'style="background: var(--current-color); color:#fff; border-color: var(--current-color);"' : ''}>
                ${e(ц.name_ru)}</button>`).join('');

        const валюты = Object.keys(ЗНАК).filter(v => v === 'INR' || курсы[v]).map(v => `
            <button type="button" class="btn btn-sm flex-1 ${v === вал ? '' : 'btn-outline'}" data-cur="${v}"
                ${v === вал ? 'style="background: var(--current-color); color:#fff; border-color: var(--current-color);"' : ''}>
                ${ЗНАК[v]}</button>`).join('');

        // на десктопе нижней панели нет, поэтому кнопка «Пожертвование» должна быть
        // и в пустом чеке — иначе принять дар без покупки можно только с телефона
        if (!к.length && !состояние.дар && !состояние.панельДара) {
            $('#tfoot').innerHTML = `<button class="btn btn-sm btn-outline" id="giftBtn">${
                t('shop_donation')}</button>`;
            return;
        }

        $('#tfoot').innerHTML = `
            ${к.length ? `<div class="flex items-center justify-between">
                <span class="text-sm opacity-60">${состояние.скидка ? t('shop_goods_discounted') : t('shop_goods_line')}</span>
                <span class="text-2xl font-bold nums">${деньги(итогРупии())}</span></div>` : ''}
            ${состояние.скидка ? `<div class="flex items-center justify-between text-sm opacity-60">
                <span>Скидка · ${e(состояние.причина)}</span><span class="nums">−${деньги(состояние.скидка)}</span></div>` : ''}
            ${состояние.дар ? `<div class="flex items-center justify-between text-sm font-semibold text-secondary">
                <span>${t('shop_donation')}</span><span class="nums">+${деньги(состояние.дар, вал)}</span></div>` : ''}

            <div class="flex gap-2 flex-wrap">
                ${к.length ? `<button class="btn btn-sm btn-outline flex-1" id="discBtn">${состояние.скидка
                    ? t('shop_discount') + ' ' + деньги(состояние.скидка) : t('shop_discount')}</button>` : ''}
                <button class="btn btn-sm btn-outline flex-1" id="giftBtn">${состояние.дар
                    ? t('shop_donation') + ' ' + деньги(состояние.дар, вал) : t('shop_donation')}</button>
            </div>

            ${состояние.панельСкидки ? `
            <div class="bg-base-200 rounded-lg p-3 flex flex-col gap-2">
                <div class="join w-full">
                    <button class="btn btn-sm join-item flex-1 ${состояние.видСкидки === '%' ? 'btn-active' : ''}" data-dtype="%">${t('shop_percent')}</button>
                    <button class="btn btn-sm join-item flex-1 ${состояние.видСкидки === '₹' ? 'btn-active' : ''}" data-dtype="₹">${t('shop_amount_inr')}</button>
                </div>
                <input id="discVal" class="input input-sm input-bordered w-full nums" inputmode="decimal"
                       value="${e(состояние.вводСкидки)}" placeholder="${состояние.видСкидки === '%' ? t('shop_percent') : t('shop_amount_inr')}">
                <div class="flex flex-wrap gap-1">${ПРИЧИНЫ().map(пр => `
                    <button type="button" class="btn btn-xs ${пр === состояние.причина ? 'btn-active' : 'btn-outline'}"
                            data-reason="${e(пр)}">${e(пр)}</button>`).join('')}</div>
                <div class="flex items-center justify-between text-sm">
                    <span class="opacity-60">${t('shop_discount_will_be')}</span>
                    <span class="font-bold nums">−${деньги(считатьСкидку())}</span></div>
                <div class="flex gap-2">
                    <button class="btn btn-sm flex-1" id="discApply" ${состояние.причина ? '' : 'disabled'}
                            style="background: var(--current-color); color:#fff;">${t('shop_apply')}</button>
                    ${состояние.скидка ? `<button class="btn btn-sm btn-ghost" id="discClear">${t('shop_remove')}</button>` : ''}
                </div>
                ${состояние.причина ? '' : `<span class="text-xs opacity-60">${t('shop_pick_reason')}</span>`}
            </div>` : ''}

            ${состояние.панельДара ? `
            <div class="bg-base-200 rounded-lg p-3 flex flex-col gap-2">
                <input id="giftVal" class="input input-sm input-bordered w-full nums" inputmode="decimal"
                       value="${e(состояние.вводДара)}" placeholder="${t('shop_donation_amount')}, ${ЗНАК[вал]}">
                <div class="flex flex-wrap gap-1">${целиКнопки}</div>
                <div class="flex gap-2">
                    <button class="btn btn-sm flex-1" id="giftApply"
                            style="background: var(--current-color); color:#fff;">${t('shop_add')}</button>
                    ${состояние.дар ? `<button class="btn btn-sm btn-ghost" id="giftClear">${t('shop_remove')}</button>` : ''}
                </div>
            </div>` : ''}

            <div class="flex gap-1">${валюты}</div>
            ${вал !== 'INR' && к.length ? `<div class="flex items-center justify-between text-sm">
                <span class="opacity-60">${t('shop_goods_line')} ${ЗНАК[вал]} · ${t('shop_rate')} ${курсы[вал]}</span>
                <span class="font-bold nums">${деньги(заТовары(), вал)}</span></div>` : ''}

            <div class="flex items-center justify-between">
                <span class="text-sm opacity-60">${t('shop_total_due')}</span>
                <span class="text-2xl font-bold nums">${деньги(всего, вал)}</span></div>
            <div class="flex gap-2">
                <input id="got" class="input input-bordered flex-1 nums font-bold" inputmode="decimal"
                       placeholder="${t('shop_received')}, ${ЗНАК[вал]}" value="${e(состояние.получено)}">
                <button class="btn btn-outline" id="exact">${t('shop_no_change')}</button>
            </div>
            <div class="flex gap-1">${(НОМИНАЛЫ[вал] || []).map(н =>
                `<button class="btn btn-sm btn-outline flex-1" data-note="${н}">${н}</button>`).join('')}</div>
            ${сдача !== null ? `<div class="flex items-center justify-between">
                <span class="text-sm opacity-60">${t('shop_change')}</span>
                <span class="font-bold nums ${сдача < 0 ? 'text-error' : ''}">${сдача < 0
                    ? t('shop_not_enough') + ' ' + деньги(-сдача, вал) : деньги(сдача, вал)}</span></div>` : ''}
            ${сдача > 0 ? `<button class="btn btn-sm btn-outline btn-secondary w-full" id="tipRest">
                ${t('shop_change')} ${деньги(сдача, вал)} — ${t('shop_change_to_donation')}</button>` : ''}

            <button class="btn btn-block" id="sell" ${сдача !== null && сдача < 0 ? 'disabled' : ''}
                    style="background: var(--current-color); color: #fff;">
                ${!к.length ? t('shop_accept_donation') + ' · ' : t('shop_sell_btn') + ' · '}${деньги(всего, вал)}</button>`;
    }

    // ---------- корзина ----------
    function добавить(id) {
        const i = товар(id);
        const p = состояние.корзина.find(x => x.id === id);
        if (p) p.кол++; else состояние.корзина.push({ id, кол: 1 });
        const взято = состояние.корзина.find(x => x.id === id).кол;
        if (взято > Math.max(i.остаток, 0)) {
            тост(`«${i.имя}» ${t('shop_not_in_records_warn')}`);
        }
        рисоватьСетку(); рисоватьЧек();
    }
    function задать(id, кол) {
        кол = Math.max(0, Math.floor(+кол || 0));
        if (!кол) состояние.корзина = состояние.корзина.filter(x => x.id !== id);
        else { const p = состояние.корзина.find(x => x.id === id); if (p) p.кол = кол; }
        if (!состояние.корзина.length && !состояние.дар) состояние.раскрыт = false;
        рисоватьСетку(); рисоватьЧек();
    }

    function запомнитьЧастые() {
        const было = читать('srsk_shop_top', []);
        const новые = [...состояние.корзина.map(p => p.id), ...было];
        писать('srsk_shop_top', [...new Set(новые)].slice(0, 12));
    }

    async function провести() {
        const естьТовары = состояние.корзина.length > 0;
        if (!естьТовары && !состояние.дар) return;
        if (идётОтправка) return;       // второй клик по «Продать» — это второй чек
        идётОтправка = true;
        $('#sell')?.setAttribute('disabled', 'disabled');

        const payload = {
            shift_id: сменаId,
            client_uid: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
            currency: состояние.валюта,
            items: состояние.корзина.map(p => ({ item_id: p.id, qty: p.кол })),
        };
        if (состояние.скидка) payload.discount = { amount: состояние.скидка, reason: состояние.причина };
        if (состояние.дар) payload.donation = { amount: состояние.дар, goal_id: состояние.цель };

        const всего = кОплате(), вал = состояние.валюта;
        const сдача = (число(состояние.получено) || 0) - всего;

        запомнитьЧастые();
        // снимок нужен, чтобы вернуть чек на экран, если сервер его не принял
        const снимок = JSON.parse(JSON.stringify({
            корзина: состояние.корзина, скидка: состояние.скидка, причина: состояние.причина,
            дар: состояние.дар, цель: состояние.цель, получено: состояние.получено,
            валюта: состояние.валюта,
        }));
        // остаток уменьшаем сразу: продавец должен видеть полку, а не ждать сервер
        состояние.корзина.forEach(p => { const i = товар(p.id); if (i) i.остаток -= p.кол; });
        очистить();
        рисоватьСетку(); рисоватьЧек();

        try {
            const id = await отправить(payload);
            последняя = { id, payload };
            тост(сдача > 0 ? `${t('shop_sold')}. ${t('shop_change')} ${деньги(сдача, вал)}`
                : естьТовары ? `${t('shop_sold')} · ${деньги(всего, вал)}`
                : `${t('shop_donation_accepted')} · ${деньги(всего, вал)}`, true);
        } catch (err) {
            последняя = null;
            if (этоСеть(err)) {
                // когда продали — чтобы при отказе было понятно, о каком чеке речь
                очередь.push({ ...payload, _продано: new Date().toISOString() });
                писать(КЛЮЧ_ОЧЕРЕДИ, очередь);
                показатьОчередь();
                тост(t('shop_saved_offline'));
            } else {
                // сервер отказал — чек возвращаем на экран вместе с остатками,
                // иначе продавец уверен, что продал, а продажи нет
                снимок.корзина.forEach(p => { const i = товар(p.id); if (i) i.остаток += p.кол; });
                Object.assign(состояние, снимок, { раскрыт: true });
                рисоватьСетку(); рисоватьЧек();
                Layout.showNotification(t('shop_sale_rejected') + ' ' + err.message, 'error');
            }
        } finally {
            идётОтправка = false;
        }
    }

    function очистить() {
        Object.assign(состояние, {
            корзина: [], скидка: 0, причина: null, получено: '', раскрыт: false,
            панельСкидки: false, вводСкидки: '10', дар: 0, вводДара: '', панельДара: false,
        });
    }

    function тост(текст, сОтменой = false) {
        clearTimeout(таймерТоста);
        const старый = document.getElementById('shopToast');
        if (старый) старый.remove();

        const el = document.createElement('div');
        el.id = 'shopToast';
        el.className = 'fixed left-1/2 z-50 max-w-[92vw]';
        el.style.transform = 'translateX(-50%)';
        el.style.bottom = 'calc(86px + env(safe-area-inset-bottom, 0px))';
        el.innerHTML = `<div class="bg-neutral text-neutral-content shadow-xl rounded-xl
                                    flex items-center gap-3 py-2 pl-4 pr-2">
            <span class="text-sm">${e(текст)}</span>
            ${сОтменой && последняя
                ? `<button class="btn btn-sm btn-ghost shrink-0" id="undoBtn">${t('shop_undo')}</button>` : ''}
        </div>`;
        document.body.appendChild(el);
        таймерТоста = setTimeout(() => { el.remove(); последняя = null; }, 6000);
    }

    async function отменитьПоследнюю() {
        if (!последняя) return;
        const { error } = await Layout.db.rpc('shop_cancel_sale', {
            p_sale_id: последняя.id, p_reason: 'Ошибка продавца, отменено сразу',
        });
        if (error) { Layout.handleError(error, 'Отмена чека'); return; }
        последняя = null;
        document.getElementById('shopToast')?.remove();
        await загрузить();
        рисоватьСетку(); рисоватьЧек();
        Layout.showNotification(t('shop_sale_cancelled'), 'success');
    }

    // ---------- события ----------
    function слушать() {
        document.addEventListener('click', async ev => {
            const b = ev.target.closest('button');
            if (!b) return;

            if (b.dataset.cat) { состояние.кат = b.dataset.cat; состояние.поиск = ''; $('#q').value = '';
                                 рисоватьЧипы(); рисоватьСетку(); return; }
            if (b.id === 'clearQ') { состояние.поиск = ''; $('#q').value = ''; $('#q').focus();
                                     рисоватьЧипы(); рисоватьСетку(); return; }
            if (b.dataset.add) return добавить(b.dataset.add);
            if (b.dataset.inc) { const p = состояние.корзина.find(x => x.id === b.dataset.inc);
                                 return задать(b.dataset.inc, (p?.кол || 0) + 1); }
            if (b.dataset.dec) { const p = состояние.корзина.find(x => x.id === b.dataset.dec);
                                 return задать(b.dataset.dec, (p?.кол || 0) - 1); }
            if (b.dataset.del) return задать(b.dataset.del, 0);
            if (b.id === 'openCart' || b.id === 'toPay') { состояние.раскрыт = true; return рисоватьЧек(); }
            if (b.id === 'backToGrid') { состояние.раскрыт = false; рисоватьЧек(); scrollTo({ top: 0, behavior: 'smooth' }); return; }
            if (b.id === 'giftOnly') { состояние.раскрыт = true; состояние.панельДара = true; return рисоватьЧек(); }
            if (b.dataset.cur) { состояние.валюта = b.dataset.cur; состояние.получено = '';
                                 состояние.дар = 0; состояние.вводДара = ''; return рисоватьЧек(); }
            if (b.dataset.note) { состояние.получено = String((число(состояние.получено) || 0) + (+b.dataset.note));
                                  return рисоватьЧек(); }
            if (b.dataset.dtype) { состояние.видСкидки = b.dataset.dtype;
                                   состояние.вводСкидки = b.dataset.dtype === '%' ? '10' : ''; return рисоватьЧек(); }
            if (b.dataset.reason) { состояние.причина = b.dataset.reason; return рисоватьЧек(); }
            if (b.dataset.goal) { состояние.цель = b.dataset.goal; return рисоватьЧек(); }
            if (b.id === 'discBtn') { состояние.панельСкидки = !состояние.панельСкидки;
                                      состояние.панельДара = false; return рисоватьЧек(); }
            if (b.id === 'discApply') { состояние.скидка = считатьСкидку(); состояние.панельСкидки = false; return рисоватьЧек(); }
            if (b.id === 'discClear') { состояние.скидка = 0; состояние.причина = null;
                                        состояние.панельСкидки = false; return рисоватьЧек(); }
            if (b.id === 'giftBtn') { состояние.панельДара = !состояние.панельДара;
                                      состояние.панельСкидки = false; return рисоватьЧек(); }
            if (b.id === 'giftApply') { состояние.дар = Math.round(Math.max(0, число(состояние.вводДара) || 0) * 100) / 100;
                                        состояние.панельДара = false; return рисоватьЧек(); }
            if (b.id === 'giftClear') { состояние.дар = 0; состояние.вводДара = '';
                                        состояние.панельДара = false; return рисоватьЧек(); }
            if (b.id === 'tipRest') {
                const сдача = (число(состояние.получено) || 0) - кОплате();
                if (сдача > 0) состояние.дар = Math.round((состояние.дар + сдача) * 100) / 100;
                return рисоватьЧек();
            }
            if (b.id === 'exact') { состояние.получено = String(кОплате()); return рисоватьЧек(); }
            if (b.id === 'sell') return провести();
            if (b.id === 'undoBtn') return отменитьПоследнюю();
        });

        document.addEventListener('input', ev => {
            const el = ev.target;
            const вернуть = (сел, поз) => { const н = document.querySelector(сел);
                if (н) { н.focus(); try { н.setSelectionRange(поз, поз); } catch { /* search */ } } };

            if (el.id === 'q') { состояние.поиск = el.value; рисоватьЧипы(); рисоватьСетку(); return; }
            if (el.id === 'got') { состояние.получено = el.value; const п = el.selectionStart;
                                   рисоватьЧек(); вернуть('#got', п); return; }
            if (el.id === 'discVal') { состояние.вводСкидки = el.value; const п = el.selectionStart;
                                       рисоватьЧек(); вернуть('#discVal', п); return; }
            if (el.id === 'giftVal') { состояние.вводДара = el.value; const п = el.selectionStart;
                                       рисоватьЧек(); вернуть('#giftVal', п); return; }
            if (el.dataset.qtyin) {
                if (el.value === '') return;
                const id = el.dataset.qtyin;
                const п = el.selectionStart;
                задать(id, el.value);
                // курсор ставим туда, где он был: выделение всего поля не давало
                // набрать второй разряд — «12» превращалось в «2»
                вернуть(`[data-qtyin="${id}"]`, п);
            }
        });

        addEventListener('online', разобратьОчередь);
        // перерисовка чека пересоздаёт поле «Получено»: на каждом resize
        // (в части браузеров его даёт сама клавиатура) поле теряло фокус.
        // Перерисовываем, только когда раскладка правда меняется
        let ширина = innerWidth;
        addEventListener('resize', () => {
            if ((innerWidth > 900) !== (ширина > 900)) рисоватьЧек();
            ширина = innerWidth;
        });
        document.addEventListener('click', ev => {
            if (!ev.target.closest('[data-отказыРазобраны]')) return;
            писать(КЛЮЧ_ОТКАЗОВ, []);
            показатьОтказы();
        });
        setInterval(разобратьОчередь, 60000);
    }

    async function init() {
        очередь = читать(КЛЮЧ_ОЧЕРЕДИ, []);
        показатьОчередь();
        показатьОтказы();

        try {
            await загрузить();
        } catch (err) {
            if (!изКэша()) { Layout.handleError(err, 'Загрузка товаров'); return; }
            Layout.showNotification(t('shop_offline_catalog'), 'warning');
        }

        if (window.hasPermission?.('shop_sell')) {
            const { data, error } = await Layout.db.rpc('shop_open_shift', { p_float: 0 });
            if (!error) { сменаId = data; писать('srsk_shop_shift', data); }
            else сменаId = читать('srsk_shop_shift', null);
        }

        слушать();
        рисоватьЧипы(); рисоватьСетку(); рисоватьЧек();
        разобратьОчередь();
    }

    return { init };
})();
