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
    const деньги = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n || 0) + ' ₹';

    let владельцы = [], товары = [], категории = [], прошлыеЦены = {};
    let вид = 'consignment';
    let строки = [пустаяСтрока()];

    const $ = s => document.querySelector(s);
    function пустаяСтрока() { return { название: '', item_id: null, qty: '', cost: '', категория: '', цена: '' }; }

    async function загрузить() {
        const [{ data: вл }, { data: тов }, { data: кат }, { data: партии }] = await Promise.all([
            Layout.db.from('shop_v_owners').select('id, name, loss_policy').eq('is_active', true).order('name'),
            Layout.db.from('shop_items').select('id, name_ru, source, price, category_id').eq('is_active', true).order('name_ru'),
            Layout.db.from('shop_categories').select('id, name_ru').eq('is_active', true).order('sort_order'),
            Layout.db.from('shop_batches').select('item_id, cost_price, received_on')
                .not('cost_price', 'is', null).order('received_on', { ascending: false }),
        ]);

        владельцы = (вл || []).map(в => ({ ...в, имя: в.name || 'Без названия' }));
        товары = тов || [];
        категории = кат || [];
        прошлыеЦены = {};
        (партии || []).forEach(п => { if (!(п.item_id in прошлыеЦены)) прошлыеЦены[п.item_id] = Number(п.cost_price); });
    }

    function рисоватьШапку() {
        $('#kindConsign').classList.toggle('btn-outline', вид !== 'consignment');
        $('#kindOwn').classList.toggle('btn-outline', вид !== 'own');
        $('#kindConsign').style.cssText = вид === 'consignment' ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';
        $('#kindOwn').style.cssText = вид === 'own' ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';

        $('#ownerLabel').textContent = вид === 'own' ? 'Источник' : 'Владелец';
        $('#ownerSel').disabled = вид === 'own';
        $('#ownerSel').innerHTML = вид === 'own'
            ? '<option>Мастерская — свой выпуск</option>'
            : владельцы.map(в => `<option value="${в.id}">${e(в.имя)} · потери ${
                в.loss_policy === 'compensate' ? 'компенсируем' : 'за его счёт'}</option>`).join('')
              || '<option value="">Владельцев пока нет</option>';

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
                <td data-label="Товар">
                    <div class="w-full">
                        <input class="input input-bordered input-sm w-full" list="itemsList" data-name="${i}"
                               value="${e(с.название)}" placeholder="Начните вводить название">
                        ${новый ? `
                        <div class="mt-2 flex flex-wrap gap-2 items-center">
                            <span class="badge badge-sm badge-warning">новый товар</span>
                            <select class="select select-bordered select-xs" data-cat="${i}">
                                <option value="">категория…</option>
                                ${категории.map(к => `<option value="${к.id}" ${к.id === с.категория ? 'selected' : ''}>${e(к.name_ru)}</option>`).join('')}
                            </select>
                            <input class="input input-bordered input-xs w-28 nums" inputmode="numeric"
                                   data-price="${i}" value="${e(с.цена)}" placeholder="цена, ₹">
                        </div>` : ''}
                    </div>
                </td>
                <td data-label="Количество" class="text-right">
                    <input class="input input-bordered input-sm w-24 text-right nums" inputmode="numeric"
                           data-qty="${i}" value="${e(с.qty)}"></td>
                <td data-label="Цена расчёта" class="text-right cost-col" ${вид === 'own' ? 'hidden' : ''}>
                    <input class="input input-bordered input-sm w-28 text-right nums" inputmode="numeric"
                           data-cost="${i}" value="${e(с.cost)}"></td>
                <td data-label="Было в прошлый раз" class="text-right cost-col opacity-60 nums" ${вид === 'own' ? 'hidden' : ''}>
                    ${прошлая ? деньги(прошлая) : '—'}</td>
                <td data-label="">
                    <button class="btn btn-ghost btn-sm" data-del="${i}" aria-label="Убрать строку">✕</button></td>
            </tr>`;
        }).join('');

        const штук = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0), 0);
        const сумма = строки.reduce((s, с) => s + (parseFloat(с.qty) || 0) * (parseFloat(с.cost) || 0), 0);
        $('#recTotal').textContent = !штук ? ''
            : вид === 'own' ? `${штук} шт — себестоимость не ведём, экономика в проекте`
            : `${штук} шт · обязательство возникнет по мере продажи, максимум ${деньги(сумма)}`;
    }

    async function рисоватьИсторию() {
        const { data } = await Layout.db
            .from('shop_receipts')
            .select('id, number, received_on, kind, owner_id, shop_receipt_items(qty, cost_price)')
            .order('received_on', { ascending: false }).order('number', { ascending: false }).limit(12);
        const имена = Object.fromEntries(владельцы.map(в => [в.id, в.имя]));

        const строкиИстории = (data || []).map(п => {
            const позиции = п.shop_receipt_items || [];
            const сумма = позиции.reduce((s, x) => s + Number(x.qty) * Number(x.cost_price || 0), 0);
            const откуда = п.kind === 'own' ? 'Мастерская, свой выпуск'
                : (имена[п.owner_id] || 'Владелец не указан');
            return `<tr>
                <td data-label="№" class="nums">${п.number}</td>
                <td data-label="Дата" class="nums">${DateUtils.formatShort(DateUtils.parseDate(п.received_on))}</td>
                <td data-label="Откуда">${e(откуда)}${п.kind === 'own'
                    ? ' <span class="badge badge-sm">наше</span>' : ''}</td>
                <td data-label="Позиций" class="text-right nums">${позиции.length}</td>
                <td data-label="Обязательство" class="text-right nums">${сумма ? деньги(сумма) : '—'}</td>
            </tr>`;
        });

        $('#historyTbl').tBodies[0].innerHTML = строкиИстории.join('')
            || '<tr><td colspan="5" class="text-center opacity-60 py-6">Поступлений пока не было</td></tr>';
        $('#historyCount').textContent = строкиИстории.length ? `последние ${строкиИстории.length}` : '';
    }

    async function принять() {
        const годные = строки.filter(с => с.название.trim() && parseFloat(с.qty) > 0);
        if (!годные.length) {
            Layout.showNotification('Добавьте хотя бы одну строку с количеством', 'warning');
            return;
        }

        // новые товары заводим здесь же, иначе приёмку пришлось бы бросать на полпути
        for (const с of годные.filter(x => !x.item_id)) {
            if (!с.категория || !(parseFloat(с.цена) > 0)) {
                Layout.showNotification(`Для «${с.название}» укажите категорию и цену продажи`, 'warning');
                return;
            }
            const { data, error } = await Layout.db.from('shop_items').insert({
                name_ru: с.название.trim(),
                category_id: с.категория,
                price: parseFloat(с.цена),
                source: вид === 'own' ? 'own' : 'consignment',
                translit: Layout.translit ? Layout.translit(с.название.trim()) : null,
            }).select('id').single();
            if (error) { Layout.handleError(error, 'Создание товара'); return; }
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
        if (error) { Layout.handleError(error, 'Приём товара'); return; }

        Layout.showNotification(вид === 'own' ? 'Выпуск принят на склад' : 'Товар принят на реализацию', 'success');
        строки = [пустаяСтрока()];
        $('#recNote').value = '';
        await загрузить();
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
            : вид === 'own' ? `${штук} шт — себестоимость не ведём, экономика в проекте`
            : `${штук} шт · обязательство возникнет по мере продажи, максимум ${деньги(сумма)}`;
    }

    async function init() {
        $('#recDate').value = DateUtils.toISO(new Date());
        await загрузить();
        слушать();
        рисоватьШапку();
        рисоватьСтроки();
        await рисоватьИсторию();
    }

    return { init };
})();
