/**
 * Приём товара в магазин.
 *
 * Два вида поступления на одном экране: приём от владельца (чужой товар, долг
 * появится при продаже) и выпуск Мастерской (наш, себестоимости не ведём).
 * Товара, которого ещё нет в справочнике, заводить отдельно не нужно — название
 * вводится прямо в строке, рядом спрашиваем категорию и цену продажи.
 */
const ShopReceive = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const t = key => Layout.t(key);
    const { деньги } = ShopUtils;

    let владельцы = [], товары = [], категории = [], прошлыеЦены = {};
    let занято = false;
    let вид = 'consignment';
    let строки = [пустаяСтрока()];

    const $ = s => document.querySelector(s);
    function пустаяСтрока() { return { название: '', item_id: null, qty: '', cost: '', категория: '', цена: '' }; }

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('shop_v_owners').select('id, name, loss_policy').eq('is_active', true).order('name'),
            Layout.db.from('shop_items').select('id, name_ru, source, price, category_id').eq('is_active', true).order('name_ru'),
            Layout.db.from('shop_categories').select('id, name_ru').eq('is_active', true).order('sort_order'),
            Layout.db.from('shop_batches').select('item_id, cost_price, received_on')
                .not('cost_price', 'is', null).order('received_on', { ascending: false }),
        ]);
        if (ShopUtils.ошибка(ответы, t('shop_err_load_receive'))) return false;

        const [{ data: вл }, { data: тов }, { data: кат }, { data: партии }] = ответы;
        владельцы = (вл || []).map(в => ({ ...в, имя: в.name || t('shop_unnamed') }));
        товары = тов || [];
        категории = кат || [];
        прошлыеЦены = {};
        (партии || []).forEach(п => { if (!(п.item_id in прошлыеЦены)) прошлыеЦены[п.item_id] = Number(п.cost_price); });
        return true;
    }

    function рисоватьШапку() {
        $('#kindConsign').classList.toggle('btn-outline', вид !== 'consignment');
        $('#kindOwn').classList.toggle('btn-outline', вид !== 'own');
        $('#kindConsign').style.cssText = вид === 'consignment' ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';
        $('#kindOwn').style.cssText = вид === 'own' ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';

        $('#ownerLabel').textContent = вид === 'own' ? t('shop_source') : t('shop_owner');
        $('#ownerSel').disabled = вид === 'own';
        $('#ownerSel').innerHTML = вид === 'own'
            ? `<option>${t('shop_workshop_own')}</option>`
            : владельцы.map(в => `<option value="${в.id}">${e(в.имя)} · ${t('shop_losses_word')} ${
                в.loss_policy === 'compensate' ? t('shop_loss_compensate') : t('shop_loss_owner')}</option>`).join('')
              || `<option value="">${t('shop_no_owners')}</option>`;

        document.querySelectorAll('.cost-col').forEach(el => { el.hidden = вид === 'own'; });
    }

    function рисоватьСтроки() {
        const список = товары.filter(t => вид === 'own' ? t.source === 'own' : t.source !== 'own');
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
                        ${новый ? `
                        <div class="mt-2 flex flex-wrap gap-2 items-center">
                            <span class="badge badge-sm badge-warning">${t('shop_new_item_badge')}</span>
                            <select class="select select-bordered select-xs" data-cat="${i}">
                                <option value="">${t('shop_category_dots')}</option>
                                ${категории.map(к => `<option value="${к.id}" ${к.id === с.категория ? 'selected' : ''}>${e(к.name_ru)}</option>`).join('')}
                            </select>
                            <input class="input input-bordered input-xs w-28 nums" inputmode="numeric"
                                   data-price="${i}" value="${e(с.цена)}" placeholder="${t('shop_price_small')}">
                        </div>` : ''}
                    </div>
                </td>
                <td data-label="${t('shop_qty')}" class="text-right">
                    <input class="input input-bordered input-sm w-24 text-right nums" inputmode="numeric"
                           aria-label="${t('shop_qty')}" data-qty="${i}" value="${e(с.qty)}"></td>
                <td data-label="${t('shop_cost_col')}" class="text-right cost-col" ${вид === 'own' ? 'hidden' : ''}>
                    <input class="input input-bordered input-sm w-28 text-right nums" inputmode="numeric"
                           aria-label="${t('shop_cost_col')}" data-cost="${i}" value="${e(с.cost)}"></td>
                <td data-label="${t('shop_last_time')}" class="text-right cost-col opacity-60 nums" ${вид === 'own' ? 'hidden' : ''}>
                    ${прошлая ? деньги(прошлая) : '—'}</td>
                <td data-label="">
                    <button class="btn btn-ghost btn-sm" data-del="${i}" aria-label="${t('shop_remove_row')}">✕</button></td>
            </tr>`;
        }).join('');

        обновитьИтог();
    }

    async function рисоватьИсторию() {
        const { data, error } = await Layout.db
            .from('shop_receipts')
            .select('id, number, received_on, kind, owner_id, shop_receipt_items(qty, cost_price)')
            .order('received_on', { ascending: false }).order('number', { ascending: false }).limit(12);
        if (ShopUtils.ошибка({ error }, t('shop_err_history'))) return;
        const имена = Object.fromEntries(владельцы.map(в => [в.id, в.имя]));

        const строкиИстории = (data || []).map(п => {
            const позиции = п.shop_receipt_items || [];
            const сумма = позиции.reduce((s, x) => s + Number(x.qty) * Number(x.cost_price || 0), 0);
            const откуда = п.kind === 'own' ? t('shop_workshop_own_short')
                : (имена[п.owner_id] || t('shop_owner_unknown'));
            return `<tr>
                <td data-label="№" class="nums">${п.number}</td>
                <td data-label="${t('shop_date')}" class="nums">${DateUtils.formatShort(DateUtils.parseDate(п.received_on))}</td>
                <td data-label="${t('shop_from_col')}">${e(откуда)}${п.kind === 'own'
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
        if (вид !== 'own' && !$('#ownerSel').value) {
            Layout.showNotification(t('shop_pick_owner'), 'warning');
            return;
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
                source: вид === 'own' ? 'own' : 'consignment',
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
                cost_price: вид === 'own' ? null : parseFloat(с.cost),
            })),
        };
        if (вид !== 'own') payload.owner_id = $('#ownerSel').value;

        const { error } = await Layout.db.rpc('shop_receive_goods', { payload });
        if (error) { Layout.handleError(error, t('shop_err_receive')); return; }

        Layout.showNotification(вид === 'own'
            ? t('shop_own_received') : t('shop_consign_received'), 'success');
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
        });

        document.addEventListener('input', ev => {
            const el = ev.target;
            const i = el.dataset.name ?? el.dataset.qty ?? el.dataset.cost ?? el.dataset.price;
            if (i === undefined) return;
            const с = строки[+i];
            if (!с) return;

            if (el.dataset.qty !== undefined) { с.qty = el.value; обновитьИтог(); return; }
            if (el.dataset.cost !== undefined) { с.cost = el.value; обновитьИтог(); return; }
            if (el.dataset.price !== undefined) { с.цена = el.value; return; }

            if (el.dataset.name !== undefined) {
                с.название = el.value;
                const найден = товары.find(t => t.name_ru.toLowerCase() === el.value.trim().toLowerCase());
                const былНовый = !с.item_id;
                с.item_id = найден?.id || null;
                if (найден && !с.cost && прошлыеЦены[найден.id]) с.cost = String(прошлыеЦены[найден.id]);
                // перерисовываем, только когда меняется вид строки, иначе собьём ввод
                const сталНовый = !с.item_id && el.value.trim().length > 1;
                if (!!найден !== !былНовый || сталНовый !== !!document.querySelector(`[data-cat="${i}"]`)) {
                    рисоватьСтроки();
                    const поле = document.querySelector(`[data-name="${i}"]`);
                    if (поле) { поле.focus(); поле.setSelectionRange(поле.value.length, поле.value.length); }
                }
            }
        });

        document.addEventListener('change', ev => {
            if (ev.target.dataset.cat !== undefined) {
                строки[+ev.target.dataset.cat].категория = ev.target.value;
            }
        });
    }

    function обновитьИтог() {
        const штук = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0), 0);
        const сумма = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0) * (parseFloat(с.cost) || 0), 0);
        $('#recTotal').textContent = !штук ? ''
            : вид === 'own' ? t('shop_own_total_hint').replace('%s', штук)
            : t('shop_consign_total_hint').replace('%s', штук).replace('%s', деньги(сумма));
    }

    async function init() {
        $('#recDate').value = DateUtils.toISO(new Date());
        if (!await загрузить()) return;
        слушать();
        рисоватьШапку();
        рисоватьСтроки();
        await рисоватьИсторию();
    }

    return { init };
})();
