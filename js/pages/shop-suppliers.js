/**
 * Поставщики магазина: у кого ШРСК закупает товар (ВГ 19.11).
 *
 * Карточку закупщик показывает с телефона: где лавка, как связаться и что
 * у него брали — с фото и ценой, чтобы другой закупщик привёз то же самое.
 * У товара два фото: образец, как купили (до доработки), и готовый товар.
 * Без доработки образца нет — показываем фото товара.
 */
const ShopSuppliers = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const по = (ru, en, hi) => поЯзыку({ ru, en, hi });
    const { деньги, штук } = ShopUtils;
    const $ = s => document.querySelector(s);

    let поставщики = [], закупки = {}, поиск = '';

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('shop_suppliers').select('*').order('name'),
            Layout.db.from('shop_receipts')
                .select('id, received_on, supplier_id, shop_receipt_items(qty, cost_price, list_price, discount_pct, item_id, shop_items(name_ru, photo_url, sample_photo_url))')
                .not('supplier_id', 'is', null)
                .order('received_on', { ascending: false }),
        ]);
        if (ShopUtils.ошибка(ответы, по('Не удалось загрузить поставщиков', 'Could not load suppliers', 'आपूर्तिकर्ता लोड नहीं हुए'))) return false;
        const [{ data: пост }, { data: прих }] = ответы;
        поставщики = пост || [];

        // по каждому поставщику — товары: последняя закупка сверху, всего штук
        закупки = {};
        (прих || []).forEach(п => (п.shop_receipt_items || []).forEach(с => {
            const поТоварам = закупки[п.supplier_id] ||= {};
            const т = поТоварам[с.item_id];
            if (!т) {
                поТоварам[с.item_id] = { товар: с.shop_items || {}, дата: п.received_on, прайс: с.list_price,
                                         скидка: с.discount_pct, цена: с.cost_price, всего: Number(с.qty), раз: 1 };
            } else { т.всего += Number(с.qty); т.раз += 1; }
        }));
        return true;
    }

    const иконкаТел = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z"/></svg>';
    const иконкаКарта = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"/></svg>';

    function снимок(адрес, подпись) {
        if (!адрес) return '';
        return `<a class="sup-shot bg-base-200" href="${e(адрес)}" target="_blank" rel="noopener" title="${e(подпись)}">
                    <img src="${e(адрес)}" alt="${e(подпись)}" loading="lazy"></a>`;
    }

    function строкаТовара(т) {
        const образец = т.товар.sample_photo_url, готовый = т.товар.photo_url;
        const фото = образец && готовый && образец !== готовый
            ? `<div class="flex flex-col gap-1">${снимок(образец, по('как купили', 'as bought', 'जैसा खरीदा'))}
                   <span class="text-[10px] opacity-60 text-center">${по('как купили', 'as bought', 'जैसा खरीदा')}</span></div>
               <div class="flex flex-col gap-1">${снимок(готовый, по('готовый', 'finished', 'तैयार'))}
                   <span class="text-[10px] opacity-60 text-center">${по('готовый', 'finished', 'तैयार')}</span></div>`
            : снимок(образец || готовый, т.товар.name_ru)
              || `<span class="sup-shot bg-base-200"></span>`;
        const цена = т.прайс && Number(т.скидка) > 0
            ? `${деньги(т.прайс)} − ${Number(т.скидка)}% = <b>${деньги(т.цена)}</b>`
            : `<b>${деньги(т.цена ?? т.прайс ?? 0)}</b>`;
        return `
            <div class="flex items-start gap-3 py-2 border-t border-base-200">
                <div class="flex gap-2">${фото}</div>
                <div class="min-w-0 text-sm">
                    <div class="font-medium">${e(т.товар.name_ru || '—')}</div>
                    <div class="nums">${цена} ${по('за шт.', 'per pc', 'प्रति नग')}</div>
                    <div class="text-xs opacity-60 nums">${DateUtils.formatShort(DateUtils.parseDate(т.дата))}
                        · ${по('всего', 'total', 'कुल')} ${штук(т.всего)}${т.раз > 1 ? ` · ${т.раз} ${по('раз', 'times', 'बार')}` : ''}</div>
                </div>
            </div>`;
    }

    function рисовать() {
        const q = поиск.trim().toLowerCase();
        const видно = поставщики.filter(п => {
            if (!q) return true;
            const товары = Object.values(закупки[п.id] || {}).map(т => т.товар.name_ru || '').join(' ');
            return [п.name, п.phone, п.contacts, п.goods_note, п.address, п.note, товары]
                .some(x => (x || '').toLowerCase().includes(q));
        });

        $('#list').innerHTML = видно.map(п => {
            const товары = Object.values(закупки[п.id] || {});
            const карта = SupplierCard.безопаснаяСсылка(п.map_url);
            const тел = SupplierCard.телефонДляЗвонка(п.phone);
            return `
            <div class="card bg-base-100 shadow ${п.is_active ? '' : 'opacity-60'}">
                <div class="card-body p-4 gap-2">
                    <div class="flex items-start gap-2">
                        <div class="flex-1 min-w-0">
                            <div class="font-bold">${e(п.name)}${п.is_active ? ''
                                : ` <span class="badge badge-sm badge-ghost">${по('не закупаем', 'inactive', 'निष्क्रिय')}</span>`}</div>
                            ${п.goods_note ? `<div class="text-sm opacity-70">${e(п.goods_note)}</div>` : ''}
                        </div>
                        ${window.hasPermission?.('shop_receive')
                            ? `<button class="btn btn-ghost btn-xs" data-edit="${п.id}">${по('Изменить', 'Edit', 'बदलें')}</button>` : ''}
                    </div>
                    ${тел || карта ? `<div class="flex flex-wrap gap-2">
                        ${тел ? `<a class="btn btn-sm btn-outline gap-1 nums" href="tel:${e(тел)}">${иконкаТел}${e(п.phone)}</a>` : ''}
                        ${карта ? `<a class="btn btn-sm btn-outline gap-1" href="${e(карта)}" target="_blank" rel="noopener">${иконкаКарта}${по('На карте', 'On map', 'नक्शे पर')}</a>` : ''}
                    </div>` : ''}
                    ${п.address ? `<div class="text-sm">${e(п.address)}</div>` : ''}
                    ${п.contacts ? `<div class="text-sm opacity-70">${e(п.contacts)}</div>` : ''}
                    ${п.note ? `<div class="text-sm opacity-70">${e(п.note)}</div>` : ''}
                    ${товары.length ? `
                    <details>
                        <summary class="cursor-pointer text-sm font-semibold py-1">${по('Что брали', 'What we bought', 'क्या खरीदा')} · ${товары.length}</summary>
                        ${товары.map(строкаТовара).join('')}
                    </details>` : `<div class="text-xs opacity-60">${по('Закупок ещё не было', 'No purchases yet', 'अभी कोई खरीद नहीं')}</div>`}
                </div>
            </div>`;
        }).join('') || `<div class="text-center opacity-60 py-10">${q
            ? по('Никого не нашли', 'Nothing found', 'कुछ नहीं मिला')
            : по('Поставщиков пока нет — заведите первого или прямо при «Закупке ШРСК»',
                 'No suppliers yet — add one here or right in «SRSK purchase»',
                 'अभी कोई आपूर्तिकर्ता नहीं — यहाँ या «SRSK खरीद» में जोड़ें')}</div>`;
    }

    async function открыть(поставщик) {
        const сохранён = await SupplierCard.open(поставщик);
        if (сохранён && await загрузить()) рисовать();
    }

    async function init() {
        SupplierCard.перевести();
        document.addEventListener('click', ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'newSupplier') return открыть(null);
            if (b.dataset.edit) return открыть(поставщики.find(п => п.id === b.dataset.edit));
        });
        $('#q').addEventListener('input', ev => { поиск = ev.target.value; рисовать(); });
        if (await загрузить()) рисовать();
    }

    return { init };
})();
