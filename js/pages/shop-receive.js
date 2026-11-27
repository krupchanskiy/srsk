/**
 * Приём товара в магазин.
 *
 * Три вида поступления на одном экране: приём от владельца (чужой товар, долг
 * появится при продаже), выпуск Мастерской (наш, себестоимости не ведём) и
 * закупка ШРСК (наш, куплен на деньги ШРСК: цена закупки и скидка поставщика дают
 * себестоимость, выручка идёт в магазин, не в мурти). Цена продажи — в каждой строке:
 * у товара из справочника её можно поменять (доработка, переоценка).
 * У закупки — поставщик из картотеки и фото образца, как купили (до доработки):
 * по нему другой закупщик покажет продавцу, что нужно (ВГ 19.11).
 * Товара, которого ещё нет в справочнике, заводить отдельно не нужно — название
 * вводится прямо в строке, рядом спрашиваем категорию и цену продажи.
 */
const ShopReceive = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const t = key => Layout.t(key);
    const { деньги } = ShopUtils;
    // новые ключи могут ещё не попасть в кэш переводов — тогда русский текст
    const тр = (k, ru) => { const v = t(k); return v === k ? ru : v; };

    let владельцы = [], товары = [], категории = [], прошлыеЦены = {}, поставщики = [];
    const по = (ru, en, hi) => поЯзыку({ ru, en, hi });
    let занято = false;
    let вид = 'consignment';
    let строки = [пустаяСтрока()];

    const $ = s => document.querySelector(s);
    function пустаяСтрока() { return { название: '', item_id: null, qty: '', cost: '', категория: '', цена: '', закупка: '', скидка: '', снимок: null, снимокАдрес: null }; }
    /** Себестоимость закупки ШРСК: прайс поставщика минус его скидка. */
    function себестоимость(с) {
        const прайс = parseFloat(с.закупка) || 0;
        const скидка = Math.min(Math.max(parseFloat(с.скидка) || 0, 0), 99);
        return Math.round(прайс * (1 - скидка / 100) * 100) / 100;
    }

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('shop_v_owners').select('id, name, loss_policy').eq('is_active', true).order('name'),
            Layout.db.from('shop_items').select('id, name_ru, source, price, category_id, photo_url, sample_photo_url').eq('is_active', true).order('name_ru'),
            Layout.db.from('shop_categories').select('id, name_ru').eq('is_active', true).order('sort_order'),
            Layout.db.from('shop_batches').select('item_id, cost_price, received_on')
                .not('cost_price', 'is', null).order('received_on', { ascending: false }),
            Layout.db.from('shop_suppliers').select('id, name, goods_note').eq('is_active', true).order('name'),
        ]);
        if (ShopUtils.ошибка(ответы, t('shop_err_load_receive'))) return false;

        const [{ data: вл }, { data: тов }, { data: кат }, { data: партии }, { data: пост }] = ответы;
        поставщики = пост || [];
        владельцы = (вл || []).map(в => ({ ...в, имя: в.name || t('shop_unnamed') }));
        товары = тов || [];
        категории = кат || [];
        прошлыеЦены = {};
        (партии || []).forEach(п => { if (!(п.item_id in прошлыеЦены)) прошлыеЦены[п.item_id] = Number(п.cost_price); });
        return true;
    }

    function рисоватьШапку() {
        [['#kindConsign', 'consignment'], ['#kindOwn', 'own'], ['#kindPurchase', 'purchase']].forEach(([sel, к]) => {
            $(sel).classList.toggle('btn-outline', вид !== к);
            $(sel).style.cssText = вид === к ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';
        });

        const безВладельца = вид !== 'consignment';
        $('#ownerLabel').textContent = вид === 'purchase' ? по('Поставщик', 'Supplier', 'आपूर्तिकर्ता')
            : безВладельца ? t('shop_source') : t('shop_owner');
        $('#ownerSel').disabled = вид === 'own';
        $('#ownerSel').innerHTML = вид === 'own' ? `<option>${t('shop_workshop_own')}</option>`
            : вид === 'purchase' ? `<option value="">${по('Поставщик не указан', 'No supplier', 'आपूर्तिकर्ता नहीं')}</option>`
                + поставщики.map(п => `<option value="${п.id}">${e(п.name)}${п.goods_note ? ' · ' + e(п.goods_note) : ''}</option>`).join('')
            : владельцы.map(в => `<option value="${в.id}">${e(в.имя)} · ${t('shop_losses_word')} ${
                в.loss_policy === 'compensate' ? t('shop_loss_compensate') : t('shop_loss_owner')}</option>`).join('')
              || `<option value="">${t('shop_no_owners')}</option>`;

        document.querySelectorAll('thead .cost-col').forEach(el => { el.hidden = вид !== 'consignment'; });
        document.querySelectorAll('thead .buy-col').forEach(el => { el.hidden = вид !== 'purchase'; });
        $('#ownerWarn').hidden = безВладельца;
        $('#purchaseHint').hidden = вид !== 'purchase';
        // заводить владельцев может заведующий (то же право проверяет shop_upsert_owner)
        $('#newOwnerBtn').hidden = безВладельца || !window.hasPermission?.('shop_manage');
        $('#newSupplierBtn').hidden = вид !== 'purchase' || !window.hasPermission?.('shop_receive');
    }

    /** Новый поставщик прямо из приёма — сразу выбран. */
    async function новыйПоставщик() {
        const п = await SupplierCard.open(null);
        if (!п) return;
        if (!await загрузить()) return;
        рисоватьШапку();
        $('#ownerSel').value = п.id;
    }

    function открытьНовогоВладельца() {
        $('#ownName').value = '';
        $('#ownPolicy').value = 'compensate';
        $('#ownContact').value = '';
        $('#ownerModal').showModal();
        $('#ownName').focus();
    }

    /** Новый владелец — сразу выбран в поступлении, чтобы не искать его в списке. */
    async function сохранитьВладельца() {
        const имя = $('#ownName').value.trim();
        if (!имя) return Layout.showNotification(t('shop_enter_owner_name'), 'warning');
        if (занято) return;
        занято = true;
        $('#ownGo').disabled = true;
        try {
            const { data, error } = await Layout.db.rpc('shop_upsert_owner', {
                payload: { name: имя, loss_policy: $('#ownPolicy').value,
                           contact_info: $('#ownContact').value.trim() || null },
            });
            if (error) return Layout.handleError(error, t('shop_err_owner_card'));
            $('#ownerModal').close();
            Layout.showNotification(data?.сообщение || t('shop_owner_added'), 'success');
            if (!await загрузить()) return;
            рисоватьШапку();
            if (data?.owner_id) $('#ownerSel').value = data.owner_id;
        } finally {
            занято = false;
            $('#ownGo').disabled = false;
        }
    }

    function рисоватьСтроки() {
        const список = товары.filter(t => вид === 'own' ? t.source === 'own' : t.source !== 'own');
        const чужой = вид === 'consignment', закупка = вид === 'purchase';
        $('#itemsList').innerHTML = список.map(t => `<option value="${e(t.name_ru)}"></option>`).join('');

        $('#rowsTbl').tBodies[0].innerHTML = строки.map((с, i) => {
            const найден = !!с.item_id;
            const новый = !найден && с.название.trim().length > 1;
            const прошлая = найден ? прошлыеЦены[с.item_id] : null;
            return `
            <tr>
                <td data-label="${t('shop_item_col')}">
                    <div class="w-full">
                        <input class="input input-bordered input-sm w-full" list="itemsList" data-name="${i}"
                               value="${e(с.название)}" placeholder="${t('shop_type_name')}">
                        ${закупка ? строкаСнимка(с, i) : ''}
                        ${новый ? `
                        <div class="mt-2 flex flex-wrap gap-2 items-center">
                            <span class="badge badge-sm badge-warning">${t('shop_new_item_badge')}</span>
                            <select class="select select-bordered select-xs" data-cat="${i}">
                                <option value="">${t('shop_category_dots')}</option>
                                ${категории.map(к => `<option value="${к.id}" ${к.id === с.категория ? 'selected' : ''}>${e(к.name_ru)}</option>`).join('')}
                            </select>
                        </div>` : ''}
                    </div>
                </td>
                <td data-label="${t('shop_qty')}" class="text-right">
                    <input class="input input-bordered input-sm w-24 text-right nums" inputmode="numeric"
                           aria-label="${t('shop_qty')}" data-qty="${i}" value="${e(с.qty)}"></td>
                <td data-label="${тр('shop_sale_price_col', 'Цена продажи, ₹')}" class="text-right">
                    <input class="input input-bordered input-sm w-28 text-right nums" inputmode="decimal"
                           aria-label="${тр('shop_sale_price_col', 'Цена продажи, ₹')}" data-price="${i}" value="${e(с.цена)}"
                           placeholder="${t('shop_price_small')}"></td>
                ${закупка ? `
                <td data-label="${тр('shop_list_price_col', 'Цена закупки, ₹')}" class="text-right">
                    <input class="input input-bordered input-sm w-28 text-right nums" inputmode="decimal"
                           aria-label="${тр('shop_list_price_col', 'Цена закупки, ₹')}" data-buy="${i}" value="${e(с.закупка)}"></td>
                <td data-label="${тр('shop_discount_pct_col', 'Скидка поставщика, %')}" class="text-right">
                    <input class="input input-bordered input-sm w-20 text-right nums" inputmode="decimal"
                           aria-label="${тр('shop_discount_pct_col', 'Скидка поставщика, %')}" data-disc="${i}" value="${e(с.скидка)}"
                           placeholder="0"></td>
                <td data-label="${тр('shop_net_cost_col', 'Себестоимость, ₹')}" class="text-right nums font-semibold" data-net="${i}">
                    ${с.закупка ? деньги(себестоимость(с)) : '—'}</td>` : ''}
                <td data-label="${t('shop_cost_col')}" class="text-right cost-col" ${чужой ? '' : 'hidden'}>
                    <input class="input input-bordered input-sm w-28 text-right nums" inputmode="numeric"
                           aria-label="${t('shop_cost_col')}" data-cost="${i}" value="${e(с.cost)}"></td>
                <td data-label="${t('shop_last_time')}" class="text-right cost-col opacity-60 nums" ${чужой ? '' : 'hidden'}>
                    ${прошлая ? деньги(прошлая) : '—'}</td>
                <td data-label="">
                    <button class="btn btn-ghost btn-sm" data-del="${i}" aria-label="${t('shop_remove_row')}">✕</button></td>
            </tr>`;
        }).join('');

        обновитьИтог();
    }

    /** Фото образца, как купили: новое (ещё не загружено) или то, что уже есть у товара. */
    function строкаСнимка(с, i) {
        const есть = с.снимокАдрес || товары.find(т => т.id === с.item_id)?.sample_photo_url;
        return `
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                            ${есть ? `<span class="sample-shot bg-base-200"><img src="${e(есть)}" alt=""></span>` : ''}
                            <label class="btn btn-xs btn-outline gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z"/></svg>
                                ${есть ? по('Переснять', 'Retake', 'फिर से') : по('Фото образца', 'Sample photo', 'नमूने की फोटो')}
                                <input type="file" accept="image/*" data-shot="${i}" hidden>
                            </label>
                        </div>`;
    }

    /** После приёма — фото образцов в карточки товаров. Не критично: приём уже прошёл. */
    async function загрузитьСнимки(годные) {
        for (const с of годные.filter(x => x.снимок && x.item_id)) {
            const имя = `${с.item_id}_sample_${Date.now()}.jpg`;
            const { error } = await Layout.db.storage.from('shop-photos')
                .upload(имя, с.снимок, { contentType: с.снимок.type || 'image/jpeg', cacheControl: '3600' });
            if (error) {
                Layout.showNotification(по('Фото образца не загрузилось: ', 'Sample photo failed: ', 'नमूने की फोटो नहीं गई: ') + error.message, 'warning');
                continue;
            }
            const { data: { publicUrl } } = Layout.db.storage.from('shop-photos').getPublicUrl(имя);
            const { error: ош } = await Layout.db.from('shop_items').update({ sample_photo_url: publicUrl }).eq('id', с.item_id);
            if (ош) Layout.handleError(ош, по('Фото образца', 'Sample photo', 'नमूने की फोटो'));
        }
    }

    async function рисоватьИсторию() {
        const { data, error } = await Layout.db
            .from('shop_receipts')
            .select('id, number, received_on, kind, owner_id, supplier_id, shop_receipt_items(qty, cost_price)')
            .order('received_on', { ascending: false }).order('number', { ascending: false }).limit(12);
        if (ShopUtils.ошибка({ error }, t('shop_err_history'))) return;
        const имена = Object.fromEntries(владельцы.map(в => [в.id, в.имя]));
        const именаПост = Object.fromEntries(поставщики.map(п => [п.id, п.name]));

        const строкиИстории = (data || []).map(п => {
            const позиции = п.shop_receipt_items || [];
            // обязательство только перед владельцем; закупка ШРСК уже оплачена
            const сумма = п.kind !== 'consignment' ? 0
                : позиции.reduce((s, x) => s + Number(x.qty) * Number(x.cost_price || 0), 0);
            const откуда = п.kind === 'own' ? t('shop_workshop_own_short')
                : п.kind === 'purchase' ? тр('shop_purchase_kind', 'Закупка ШРСК')
                    + (именаПост[п.supplier_id] ? ' · ' + именаПост[п.supplier_id] : '')
                : (имена[п.owner_id] || t('shop_owner_unknown'));
            return `<tr>
                <td data-label="№" class="nums">${п.number}</td>
                <td data-label="${t('shop_date')}" class="nums">${DateUtils.formatShort(DateUtils.parseDate(п.received_on))}</td>
                <td data-label="${t('shop_from_col')}">${e(откуда)}${п.kind !== 'consignment'
                    ? ` <span class="badge badge-sm">${t('shop_ours')}</span>` : ''}</td>
                <td data-label="${t('shop_lines_col')}" class="text-right nums">${позиции.length}</td>
                <td data-label="${t('shop_liability_col')}" class="text-right nums">${сумма ? деньги(сумма) : '—'}</td>
            </tr>`;
        });

        $('#historyTbl').tBodies[0].innerHTML = строкиИстории.join('')
            || `<tr><td colspan="5" class="text-center opacity-60 py-6">${t('shop_no_receipts')}</td></tr>`;
        $('#historyCount').textContent = строкиИстории.length
            ? t('shop_last_n').replace('%s', строкиИстории.length) : '';
    }

    async function принять() {
        const годные = строки.filter(с => с.название.trim() && parseFloat(с.qty) > 0);
        if (!годные.length) {
            Layout.showNotification(t('shop_add_one_row'), 'warning');
            return;
        }
        if (вид === 'consignment' && !$('#ownerSel').value) {
            Layout.showNotification(t('shop_pick_owner'), 'warning');
            return;
        }
        if (вид === 'purchase') {
            const без = годные.find(с => !(parseFloat(с.закупка) > 0));
            if (без) return Layout.showNotification(тр('shop_purchase_needs', 'Для «%s» укажите цену закупки').replace('%s', без.название), 'warning');
        }
        // чужой товар: прямо спрашиваем, чей он, — купленное на деньги ШРСК сюда не заводят
        if (вид === 'consignment') {
            const владелец = владельцы.find(в => в.id === $('#ownerSel').value)?.имя || '';
            const долг = годные.reduce((с, x) => с + (parseFloat(x.qty) || 0) * (parseFloat(x.cost) || 0), 0);
            const я = (window.currentUser?.spiritual_name || '').toLowerCase().split(/[\s-]+/)[0];
            const себя = я && владелец.toLowerCase().split(/[\s-]+/)[0] === я;
            const тр = (k, ru) => { const v = t(k); return v === k ? ru : v; };
            const вопрос = (себя
                ? тр('shop_owner_self_q', 'Вы указали владельцем себя. Это ваш собственный товар, а не купленный на деньги ШРСК?') + '\n\n'
                : '')
                + тр('shop_owner_confirm_q', 'Товар будет числиться за «%o». При продаже магазин заплатит ему %s. Это точно его товар, а не закупка ШРСК?')
                    .replace('%o', владелец).replace('%s', ShopUtils.деньги(долг));
            if (!confirm(вопрос)) return;
        }
        if (занято) return;
        занято = true;
        $('#saveRec').setAttribute('disabled', 'disabled');
        try { await отправить(годные); }
        finally { занято = false; $('#saveRec').removeAttribute('disabled'); }
    }

    async function отправить(годные) {

        // новые товары заводим здесь же, иначе приёмку пришлось бы бросать на полпути
        for (const с of годные.filter(x => !x.item_id)) {
            if (!с.категория || !(parseFloat(с.цена) > 0)) {
                Layout.showNotification(t('shop_new_item_needs').replace('%s', с.название), 'warning');
                return;
            }
            const { data, error } = await Layout.db.from('shop_items').insert({
                name_ru: с.название.trim(),
                category_id: с.категория,
                price: parseFloat(с.цена),
                source: вид,
                translit: window.Translit ? Translit.ru(с.название.trim()).toLowerCase() : null,
            }).select('id').single();
            if (error) { Layout.handleError(error, t('shop_err_create_item')); return; }
            с.item_id = data.id;
        }

        const payload = {
            kind: вид,
            received_on: $('#recDate').value || undefined,
            note: $('#recNote').value || undefined,
            items: годные.map(с => ({
                item_id: с.item_id,
                qty: parseFloat(с.qty),
                cost_price: вид === 'consignment' ? parseFloat(с.cost) : null,
                // новая цена продажи уходит в карточку товара (база меняет её, только если другая)
                price: parseFloat(с.цена) > 0 ? parseFloat(с.цена) : null,
                ...(вид === 'purchase' ? { list_price: parseFloat(с.закупка), discount_pct: parseFloat(с.скидка) || 0 } : {}),
            })),
        };
        if (вид === 'consignment') payload.owner_id = $('#ownerSel').value;
        if (вид === 'purchase' && $('#ownerSel').value) payload.supplier_id = $('#ownerSel').value;

        const { error } = await Layout.db.rpc('shop_receive_goods', { payload });
        if (error) { Layout.handleError(error, t('shop_err_receive')); return; }
        await загрузитьСнимки(годные);

        Layout.showNotification(вид === 'own' ? t('shop_own_received')
            : вид === 'purchase' ? тр('shop_purchase_received', 'Закупка принята')
            : t('shop_consign_received'), 'success');
        строки.forEach(с => с.снимокАдрес && URL.revokeObjectURL(с.снимокАдрес));
        строки = [пустаяСтрока()];
        $('#recNote').value = '';
        if (!await загрузить()) return;
        рисоватьШапку();
        рисоватьСтроки();
        await рисоватьИсторию();
    }

    function слушать() {
        document.addEventListener('click', ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.dataset.kind) {
                вид = b.dataset.kind;
                строки = [пустаяСтрока()];
                рисоватьШапку(); рисоватьСтроки();
                return;
            }
            if (b.dataset.del !== undefined) {
                строки.splice(+b.dataset.del, 1);
                if (!строки.length) строки = [пустаяСтрока()];
                return рисоватьСтроки();
            }
            if (b.id === 'addRow') { строки.push(пустаяСтрока()); return рисоватьСтроки(); }
            if (b.id === 'saveRec') return принять();
            if (b.id === 'newOwnerBtn') return открытьНовогоВладельца();
            if (b.id === 'newSupplierBtn') return новыйПоставщик();
            if (b.id === 'ownGo') return сохранитьВладельца();
        });

        document.addEventListener('input', ev => {
            const el = ev.target;
            const i = el.dataset.name ?? el.dataset.qty ?? el.dataset.cost ?? el.dataset.price
                ?? el.dataset.buy ?? el.dataset.disc;
            if (i === undefined) return;
            const с = строки[+i];
            if (!с) return;

            if (el.dataset.qty !== undefined) { с.qty = el.value; обновитьИтог(); return; }
            if (el.dataset.cost !== undefined) { с.cost = el.value; обновитьИтог(); return; }
            if (el.dataset.price !== undefined) { с.цена = el.value; return; }
            if (el.dataset.buy !== undefined || el.dataset.disc !== undefined) {
                if (el.dataset.buy !== undefined) с.закупка = el.value; else с.скидка = el.value;
                const ячейка = document.querySelector(`[data-net="${i}"]`);
                if (ячейка) ячейка.textContent = с.закупка ? деньги(себестоимость(с)) : '—';
                обновитьИтог();
                return;
            }

            if (el.dataset.name !== undefined) {
                с.название = el.value;
                const найден = товары.find(t => t.name_ru.toLowerCase() === el.value.trim().toLowerCase());
                const былНовый = !с.item_id, былId = с.item_id;
                с.item_id = найден?.id || null;
                if (найден && !с.cost && прошлыеЦены[найден.id]) с.cost = String(прошлыеЦены[найден.id]);
                if (найден && (найден.id !== былId || !с.цена)) с.цена = String(Number(найден.price) || '');
                // перерисовываем, только когда меняется вид строки, иначе собьём ввод
                const сталНовый = !с.item_id && el.value.trim().length > 1;
                if (!!найден !== !былНовый || сталНовый !== !!document.querySelector(`[data-cat="${i}"]`)) {
                    рисоватьСтроки();
                    const поле = document.querySelector(`[data-name="${i}"]`);
                    if (поле) { поле.focus(); поле.setSelectionRange(поле.value.length, поле.value.length); }
                }
            }
        });

        document.addEventListener('change', async ev => {
            if (ev.target.dataset.shot !== undefined) {
                const с = строки[+ev.target.dataset.shot];
                const файл = ev.target.files?.[0];
                ev.target.value = '';
                if (!с || !файл) return;
                // повернуть и обрезать — тот же редактор, что в карточке товара
                const готово = window.PhotoEditor ? await PhotoEditor.open(файл, { соотношение: 1.5 }) : файл;
                if (!готово) return;
                if (с.снимокАдрес) URL.revokeObjectURL(с.снимокАдрес);
                с.снимок = готово;
                с.снимокАдрес = URL.createObjectURL(готово);
                return рисоватьСтроки();
            }
            if (ev.target.dataset.cat !== undefined) {
                строки[+ev.target.dataset.cat].категория = ev.target.value;
            }
        });
    }

    function обновитьИтог() {
        const штук = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0), 0);
        const сумма = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0) * (parseFloat(с.cost) || 0), 0);
        const закуплено = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0) * себестоимость(с), 0);
        $('#recTotal').textContent = !штук ? ''
            : вид === 'own' ? t('shop_own_total_hint').replace('%s', штук)
            : вид === 'purchase' ? тр('shop_purchase_total_hint', '%s шт · себестоимость %s').replace('%s', штук).replace('%s', деньги(закуплено))
            : t('shop_consign_total_hint').replace('%s', штук).replace('%s', деньги(сумма));
    }

    async function init() {
        SupplierCard.перевести();
        $('#recDate').value = DateUtils.toISO(new Date());
        if (!await загрузить()) return;
        слушать();
        рисоватьШапку();
        рисоватьСтроки();
        await рисоватьИсторию();
    }

    return { init };
})();
