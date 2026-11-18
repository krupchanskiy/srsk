/**
 * Возврат покупателю.
 *
 * Отдельный экран, потому что после закрытия смены чек отменить уже нельзя —
 * деньги за неё пересчитаны и сданы. Возврат же отдаёт деньги из той кассы,
 * что открыта сейчас, и товар возвращается в ту партию, из которой ушёл.
 *
 * Чек ищется по номеру: продавец спрашивает его у покупателя или находит
 * чек дня в списке последних. Возвращать можно частями — по одной книге
 * из трёх, и сколько возвращено раньше, экран показывает сразу.
 */
const ShopReturns = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const t = key => Layout.t(key);
    const { деньги, штук, ЗНАК } = ShopUtils;
    const $ = s => document.querySelector(s);

    let последние = [], чек = null, позиции = [], занято = false, запрос = '', таймерПоиска = null;
    let смены = [], выбранаСмена = '', выбранДень = '';
    // новый перевод мог ещё не попасть в закэшированный словарь — тогда русский текст, а не ключ
    const тр = (ключ, ru) => { const v = t(ключ); return v === ключ ? ru : v; };
    const ПОЛЯ_ЧЕКА = 'id, number, sold_at, currency_code, paid_amount, donation_amount, status, '
        + 'shop_sale_items(qty, shop_items(name_ru, name_en, name_hi))';
    const можно = () => !!window.hasPermission?.('shop_manage');

    // Смена или день (жалоба продавца 18.11: последние 50 — это только вчерашняя
    // смена, проверить чеки предыдущей было нельзя). Поиск работает внутри выбора.
    const выбрано = () => !!(выбранаСмена || выбранДень);
    function сВыбором(запросЧеков) {
        if (выбранаСмена) return запросЧеков.eq('shift_id', выбранаСмена);
        if (выбранДень) {
            // sold_at — настоящая метка времени: границы суток по часам устройства
            const с = DateUtils.parseDate(выбранДень);
            const по = new Date(с); по.setDate(по.getDate() + 1);
            return запросЧеков.gte('sold_at', с.toISOString()).lt('sold_at', по.toISOString());
        }
        return запросЧеков;
    }

    const подписьСмены = с => {
        const от = new Date(с.opened_at), до = с.closed_at ? new Date(с.closed_at) : null;
        const конец = !до ? тр('shop_shift_now_open', 'открыта сейчас')
            : DateUtils.toISO(до) === DateUtils.toISO(от) ? DateUtils.formatTime(до)
            : `${DateUtils.formatShort(до)} ${DateUtils.formatTime(до)}`;
        return `${DateUtils.formatShort(от)} ${DateUtils.formatTime(от)} – ${конец} · ${с.чеков} ${тр('shop_receipts_short', 'чек.')}`;
    };

    // смены с чеками — пустые в списке только мешают
    async function загрузитьСмены() {
        const { data, error } = await Layout.db.from('shop_shifts')
            .select('id, opened_at, closed_at').order('opened_at', { ascending: false }).limit(60);
        if (ShopUtils.ошибка({ error }, t('shop_err_recent'))) return;
        const ids = (data || []).map(с => с.id);
        const счёт = {};
        if (ids.length) {
            const { data: чеки } = await Layout.db.from('shop_sales').select('shift_id')
                .in('shift_id', ids).eq('status', 'posted').limit(10000);
            (чеки || []).forEach(ч => { счёт[ч.shift_id] = (счёт[ч.shift_id] || 0) + 1; });
        }
        смены = (data || []).filter(с => счёт[с.id]).map(с => ({ ...с, чеков: счёт[с.id] }));
        $('#pickShift').insertAdjacentHTML('beforeend',
            смены.map(с => `<option value="${с.id}">${e(подписьСмены(с))}</option>`).join(''));
    }

    // Журнал продаж (ВГ 15.11): без запроса — последние 50 чеков; запрос — номер чека
    // или часть названия товара, ищем по всем чекам, а не только по видимым
    async function загрузить() {
        const q = запрос.trim();
        let ответ;
        if (!q) {
            ответ = await сВыбором(Layout.db.from('shop_sales').select(ПОЛЯ_ЧЕКА).eq('status', 'posted'))
                .order('sold_at', { ascending: false }).limit(выбрано() ? 1000 : 50);
        } else {
            const ищем = q.replace(/[%_,()]/g, ' ').trim();
            const { data: позицииСТоваром, error } = await Layout.db.from('shop_sale_items')
                .select('sale_id, shop_items!inner(name_ru)')
                .or(`name_ru.ilike.%${ищем}%,name_en.ilike.%${ищем}%,name_hi.ilike.%${ищем}%`, { referencedTable: 'shop_items' })
                .limit(1000);
            if (ShopUtils.ошибка({ error }, t('shop_err_recent'))) return false;
            const ids = [...new Set((позицииСТоваром || []).map(п => п.sale_id))].slice(0, 300);
            let запросЧеков = сВыбором(Layout.db.from('shop_sales').select(ПОЛЯ_ЧЕКА).eq('status', 'posted'));
            const номер = /^\d+$/.test(q) ? Number(q) : null;
            if (номер && ids.length) запросЧеков = запросЧеков.or(`number.eq.${номер},id.in.(${ids.join(',')})`);
            else if (номер) запросЧеков = запросЧеков.eq('number', номер);
            else if (ids.length) запросЧеков = запросЧеков.in('id', ids);
            else { последние = []; return true; }
            ответ = await запросЧеков.order('sold_at', { ascending: false }).limit(100);
        }
        if (ShopUtils.ошибка(ответ, t('shop_err_recent'))) return false;
        последние = ответ.data || [];
        return true;
    }

    const товарыЧека = ч => (ч.shop_sale_items || []).reduce((итог, п) => {
        const имя = Layout.getName(п.shop_items || {}) || t('shop_item');
        итог[имя] = (итог[имя] || 0) + Number(п.qty);
        return итог;
    }, {});

    function рисоватьПоследние() {
        $('#lastTbl').tBodies[0].innerHTML = последние.map(ч => `
            <tr>
                <td data-label="${t('shop_receipt')}" class="nums">№${ч.number}</td>
                <td data-label="${t('shop_when_col')}" class="nums opacity-70">
                    ${DateUtils.formatShort(new Date(ч.sold_at))} ${DateUtils.formatTime(new Date(ч.sold_at))}</td>
                <td data-label="${тр('shop_goods_col', 'Товары')}" class="text-sm">${Object.entries(товарыЧека(ч))
                    .map(([имя, к]) => e(имя) + (к > 1 ? ` <span class="opacity-60">×${к}</span>` : '')).join(', ')
                    || `<span class="opacity-60">${t('shop_donation')}</span>`}</td>
                <td data-label="${t('shop_amount_word')}" class="text-right nums">${деньги(ч.paid_amount, ч.currency_code)}</td>
                <td data-label="" class="text-right">
                    <button class="btn btn-ghost btn-xs" data-open="${ч.id}">${t('shop_open_btn')}</button></td>
            </tr>`).join('')
            || `<tr><td colspan="5" class="text-center opacity-60 py-6">${запрос.trim()
                ? тр('shop_nothing_found', 'Ничего не нашлось') : t('shop_no_posted_receipts')}</td></tr>`;
        $('#lastCount').textContent = запрос.trim()
            ? `${тр('shop_found_word', 'найдено')}: ${последние.length}`
            : выбрано() ? `${тр('shop_receipts_count', 'чеков')}: ${последние.length}`
            : тр('shop_last_fifty', 'последние пятьдесят');
    }

    async function открыть(saleId) {
        const ответ = await Layout.db.from('shop_sales')
            .select(`id, number, sold_at, currency_code, paid_amount, donation_amount, discount_amount, status,
                     shop_sale_items(id, qty, price, item_id, shop_items(name_ru, name_en, name_hi))`)
            .eq('id', saleId).maybeSingle();
        if (ShopUtils.ошибка(ответ, t('shop_err_receipt'))) return;
        чек = ответ.data;
        if (!чек) return Layout.showNotification(t('shop_receipt_not_found'), 'warning');

        // что уже возвращали по этому чеку: без этого легко вернуть дважды
        const возвраты = await Layout.db.from('shop_returns')
            .select('sale_item_id, qty, refund_amount, returned_on').eq('sale_id', чек.id);
        if (ShopUtils.ошибка(возвраты, t('shop_err_past_returns'))) return;
        const ужеПо = {};
        (возвраты.data || []).forEach(в => {
            ужеПо[в.sale_item_id] = (ужеПо[в.sale_item_id] || 0) + Number(в.qty);
        });

        позиции = (чек.shop_sale_items || []).map(п => ({
            id: п.id,
            имя: Layout.getName(п.shop_items || {}),
            продано: Number(п.qty),
            цена: Number(п.price),
            уже: ужеПо[п.id] || 0,
        }));

        рисоватьЧек();
    }

    function рисоватьЧек() {
        if (!чек) { $('#saleCard').hidden = true; return; }
        $('#saleCard').hidden = false;

        const когда = new Date(чек.sold_at);
        $('#saleTitle').textContent = `${t('shop_receipt')} №${чек.number}`;
        $('#saleMeta').textContent = `${DateUtils.formatShort(когда)} ${DateUtils.formatTime(когда)} · ` +
            `${t('shop_paid_word')} ${деньги(чек.paid_amount, чек.currency_code)}` +
            (Number(чек.donation_amount)
                ? ', ' + t('shop_of_which_donation').replace('%s',
                    деньги(чек.donation_amount, чек.currency_code)) : '');

        $('#saleTbl').tBodies[0].innerHTML = позиции.map(п => {
            const можноВернуть = п.продано - п.уже;
            return `
            <tr class="${можноВернуть <= 0 ? 'opacity-50' : ''}">
                <td class="head" data-label="">${e(п.имя)}</td>
                <td data-label="${t('shop_sold')}" class="text-right nums">${штук(п.продано)}</td>
                <td data-label="${t('shop_already_returned')}" class="text-right nums opacity-70">${п.уже ? штук(п.уже) : '—'}</td>
                <td data-label="${t('price')}" class="text-right nums opacity-70">${деньги(п.цена)}</td>
                <td data-label="${t('shop_returning')}" class="text-right">
                    ${можноВернуть > 0 ? `
                    <input type="number" class="input input-bordered input-sm w-24 text-right nums"
                           data-ret="${п.id}" min="0" max="${можноВернуть}" step="0.001"
                           placeholder="0" ${можно() ? '' : 'disabled'}>` : `<span class="opacity-40">${t('shop_all_returned')}</span>`}
                </td>
            </tr>`;
        }).join('');

        обновитьИтог();
    }

    // деньги считает сервер по доле позиции в уплаченном — здесь прикидка для продавца
    function обновитьИтог() {
        const товарная = Number(чек.paid_amount) - Number(чек.donation_amount);
        const база = позиции.reduce((s, п) => s + п.продано * п.цена, 0);
        let сумма = 0, штукВсего = 0;
        позиции.forEach(п => {
            const кол = Number(document.querySelector(`[data-ret="${п.id}"]`)?.value) || 0;
            штукВсего += кол;
            if (база > 0) сумма += товарная * (кол * п.цена) / база;
        });
        $('#retSum').textContent = штукВсего
            ? t('shop_refund_of').replace('%s', деньги(сумма, чек.currency_code))
                                 .replace('%s', штук(штукВсего))
            : t('shop_say_what_returns');
        $('#retGo').disabled = !штукВсего || !можно();
    }

    async function вернуть() {
        const items = позиции
            .map(п => ({ sale_item_id: п.id, qty: Number(document.querySelector(`[data-ret="${п.id}"]`)?.value) || 0 }))
            .filter(п => п.qty > 0);
        if (!items.length) return Layout.showNotification(t('shop_nothing_returning'), 'warning');

        const причина = $('#retReason').value.trim();
        if (!причина) return Layout.showNotification(t('shop_write_refund_reason'), 'warning');
        if (!confirm(t('shop_confirm_refund'))) return;

        if (занято) return;
        занято = true;
        $('#retGo').setAttribute('disabled', 'disabled');
        try {
            const { error } = await Layout.db.rpc('shop_return_sale', {
                payload: { sale_id: чек.id, items, reason: причина },
            });
            if (error) return Layout.handleError(error, t('shop_err_refund'));
            Layout.showNotification(t('shop_refund_done'), 'success');
            $('#retReason').value = '';
            await открыть(чек.id);
            if (await загрузить()) рисоватьПоследние();
        } finally {
            занято = false;
            $('#retGo').removeAttribute('disabled');
        }
    }

    async function найтиПоНомеру() {
        // текст — это поиск по товару: список уже отфильтрован, открывать нечего
        if (!/^\d+$/.test($('#findNum').value.trim())) return искать();
        const номер = Number($('#findNum').value);
        if (!номер) return Layout.showNotification(t('shop_enter_receipt_number'), 'warning');
        const ответ = await Layout.db.from('shop_sales')
            .select('id, status').eq('number', номер).order('sold_at', { ascending: false }).limit(1);
        if (ShopUtils.ошибка(ответ, t('shop_err_find_receipt'))) return;
        const найден = ответ.data?.[0];
        if (!найден) return Layout.showNotification(t('shop_receipt_no_such').replace('%s', номер), 'warning');
        if (найден.status !== 'posted') {
            return Layout.showNotification(t('shop_receipt_cancelled').replace('%s', номер), 'warning');
        }
        await открыть(найден.id);
    }

    async function искать() {
        запрос = $('#findNum').value;
        if (await загрузить()) рисоватьПоследние();
    }

    function слушать() {
        document.addEventListener('click', ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.dataset.open) return открыть(b.dataset.open);
            if (b.id === 'findGo') return найтиПоНомеру();
            if (b.id === 'retGo') return вернуть();
        });
        document.addEventListener('input', ev => {
            if (ev.target.dataset.ret !== undefined) обновитьИтог();
        });
        $('#findNum').addEventListener('input', () => {
            clearTimeout(таймерПоиска);
            таймерПоиска = setTimeout(искать, 350);
        });
        // смена и день взаимоисключают друг друга: выбрал одно — другое сбрасывается
        $('#pickShift').addEventListener('change', () => {
            выбранаСмена = $('#pickShift').value;
            if (выбранаСмена) { выбранДень = ''; $('#pickDay').value = ''; }
            искать();
        });
        $('#pickDay').addEventListener('change', () => {
            выбранДень = $('#pickDay').value;
            if (выбранДень) { выбранаСмена = ''; $('#pickShift').value = ''; }
            искать();
        });
        $('#findNum').addEventListener('keydown', ev => {
            if (ev.key === 'Enter') найтиПоНомеру();
        });
    }

    async function init() {
        слушать();
        загрузитьСмены();
        if (!await загрузить()) return;
        рисоватьПоследние();
        ShopUtils.права();
    }

    return { init };
})();
