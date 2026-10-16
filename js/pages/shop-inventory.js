/**
 * Инвентаризация и списания.
 *
 * Расхождений бывает два десятка, и щёлкать «за чей счёт» на каждом никто не станет —
 * поэтому решение принимается один раз для всей ведомости, а поправить можно точечно.
 * Недостача уходит в списание, излишек приходуется партией без владельца: это найденный
 * товар, и продажа из него долга владельцу не создаёт.
 */
const ShopInventory = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const t = key => Layout.t(key);
    const { штук, деньги } = ShopUtils;
    const ПРИЧИНА = код => t('shop_reason_' + код) || код;

    let ведомость = null, строки = [], товары = [], списания = [], общийСчёт = 'us';
    let занято = false;   // проведение и списание необратимы — второй клик недопустим
    const $ = s => document.querySelector(s);
    const можно = () => !!window.hasPermission?.('shop_manage');

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('shop_inventories').select('id, number, inventory_date, status, note, applied_at')
                .order('created_at', { ascending: false }).limit(1),
            Layout.db.from('shop_items').select('id, name_ru, name_en, name_hi, is_active').order('name_ru'),
            Layout.db.from('shop_writeoffs')
                .select('id, created_at, qty, reason, at_whose_cost, compensation, note, shop_items(name_ru, name_en, name_hi)')
                .is('cancelled_at', null).order('created_at', { ascending: false }).limit(15),
        ]);
        if (ShopUtils.ошибка(ответы, t('shop_err_load_inventory'))) return false;

        const [{ data: вед }, { data: тов }, { data: сп }] = ответы;
        товары = тов || [];
        списания = сп || [];
        ведомость = (вед || [])[0]?.status === 'draft' ? вед[0] : null;

        строки = [];
        if (ведомость) {
            const ответ = await Layout.db.from('shop_v_inventory_items')
                .select('*').eq('inventory_id', ведомость.id);
            if (ShopUtils.ошибка(ответ, t('shop_err_load_sheet'))) return false;
            строки = (ответ.data || []).sort((a, b) =>
                (Layout.getName(a) || '').localeCompare(Layout.getName(b) || '', 'ru'));
        }
        return true;
    }

    function рисоватьВедомость() {
        const действия = $('#invActions');

        if (!ведомость) {
            $('#invTitle').textContent = t('shop_sheet');
            $('#invMeta').textContent = t('shop_no_draft');
            действия.innerHTML = можно()
                ? `<button class="btn btn-sm" id="startInv" style="background: var(--current-color); color:#fff;">${
                     t('shop_start_inventory')}</button>` : '';
            $('#invBody').innerHTML = `<div class="text-sm opacity-60">${t('shop_inventory_hint')}</div>`;
            return;
        }

        $('#invTitle').textContent = `${t('shop_sheet')} №${ведомость.number}`;
        $('#invMeta').textContent = DateUtils.formatShort(DateUtils.parseDate(ведомость.inventory_date));
        действия.innerHTML = можно() ? `
            <select class="select select-bordered select-sm" id="bulkCost" title="${t('shop_bulk_title')}">
                <option value="us" ${общийСчёт === 'us' ? 'selected' : ''}>${t('shop_bulk_us')}</option>
                <option value="owner" ${общийСчёт === 'owner' ? 'selected' : ''}>${t('shop_bulk_owner')}</option>
            </select>
            <button class="btn btn-sm btn-outline" id="saveInv">${t('save')}</button>
            <button class="btn btn-sm" id="applyInv" style="background: var(--current-color); color:#fff;">${
                t('shop_apply_sheet')}</button>
            <button class="btn btn-sm btn-ghost" id="dropInv">${t('delete')}</button>` : '';

        const посчитано = строки.filter(с => с.actual_qty !== null).length;
        $('#invBody').innerHTML = `
            <div class="text-sm opacity-60 mb-3">${
                t('shop_counted_of').replace('%s', посчитано).replace('%s', строки.length)}</div>
            <div class="overflow-x-auto">
                <table class="table table-sm stack" id="invTbl">
                    <thead><tr>
                        <th>${t('shop_item_col')}</th><th class="text-right">${t('shop_in_records')}</th>
                        <th class="text-right">${t('shop_actual')}</th><th class="text-right">${t('shop_difference')}</th>
                        <th>${t('reason')}</th><th>${t('shop_at_whose_cost')}</th>
                    </tr></thead>
                    <tbody>${строки.map(рисоватьСтроку).join('')}</tbody>
                </table>
            </div>`;
    }

    function рисоватьСтроку(с) {
        const факт = с.actual_qty;
        const разница = факт === null || факт === '' ? null : Number(факт) - Number(с.current_qty);
        const класс = разница === null ? '' : разница < 0 ? 'diff-neg' : разница > 0 ? 'diff-pos' : 'opacity-50';
        return `
        <tr>
            <td class="head" data-label="">${e(Layout.getName(с))}
                ${с.has_owner ? `<span class="badge badge-sm badge-ghost">${t('shop_foreign')}</span>` : ''}</td>
            <td data-label="${t('shop_in_records')}" class="text-right nums opacity-70">${штук(с.current_qty)}</td>
            <td data-label="${t('shop_actual')}" class="text-right">
                <input type="number" class="input input-bordered input-sm w-24 text-right nums"
                       data-fact="${с.item_id}" value="${факт ?? ''}" step="0.001"
                       ${можно() ? '' : 'disabled'}></td>
            <td data-label="${t('shop_difference')}" class="text-right nums ${класс}">
                ${разница === null ? '—' : (разница > 0 ? '+' : '') + штук(разница)}</td>
            <td data-label="${t('reason')}">
                <input type="text" class="input input-bordered input-sm w-full"
                       data-reason="${с.item_id}" value="${e(с.reason || '')}"
                       placeholder="${разница && разница !== 0 ? t('shop_required') : ''}"
                       ${можно() ? '' : 'disabled'}></td>
            <td data-label="${t('shop_at_whose_cost')}">
                ${с.has_owner ? `
                <select class="select select-bordered select-sm" data-cost="${с.item_id}" ${можно() ? '' : 'disabled'}>
                    <option value="">${t('shop_as_all')}</option>
                    <option value="us" ${с.at_whose_cost === 'us' ? 'selected' : ''}>${t('shop_compensate')}</option>
                    <option value="owner" ${с.at_whose_cost === 'owner' ? 'selected' : ''}>${t('shop_at_owner_cost')}</option>
                </select>` : '<span class="opacity-40">—</span>'}</td>
        </tr>`;
    }

    function рисоватьСписания() {
        $('#woTbl').tBodies[0].innerHTML = списания.map(с => `
            <tr>
                <td data-label="${t('shop_date')}" class="nums">${DateUtils.formatShort(new Date(с.created_at))}</td>
                <td data-label="${t('shop_item_col')}" class="head">${e(Layout.getName(с.shop_items || {}))}</td>
                <td data-label="${t('shop_qty')}" class="text-right nums">${штук(с.qty)}</td>
                <td data-label="${t('reason')}">${e(ПРИЧИНА(с.reason))}
                    ${с.note ? `<span class="opacity-60">· ${e(с.note)}</span>` : ''}</td>
                <td data-label="${t('shop_at_whose_cost')}">${
                    с.at_whose_cost === 'us' ? t('shop_our_cost') : t('shop_owner_cost')}</td>
                <td data-label="${t('shop_compensation')}" class="text-right nums">${
                    Number(с.compensation) > 0 ? деньги(с.compensation) : '—'}</td>
            </tr>`).join('') || `<tr><td colspan="6" class="text-center opacity-60 py-6">${t('shop_no_writeoffs')}</td></tr>`;
    }

    function собратьСтроки() {
        return строки.map(с => ({
            item_id: с.item_id,
            actual_qty: document.querySelector(`[data-fact="${с.item_id}"]`)?.value || '',
            reason: document.querySelector(`[data-reason="${с.item_id}"]`)?.value || '',
            at_whose_cost: document.querySelector(`[data-cost="${с.item_id}"]`)?.value || общийСчёт,
        }));
    }

    async function сохранить(тихо = false) {
        const { error } = await Layout.db.rpc('shop_save_inventory', {
            payload: { inventory_id: ведомость.id, items: собратьСтроки() },
        });
        if (error) { Layout.handleError(error, t('shop_err_save_sheet')); return false; }
        if (!тихо) Layout.showNotification(t('shop_sheet_saved'), 'success');
        return true;
    }

    async function провести() {
        const данные = собратьСтроки();
        const пустые = данные.filter(с => с.actual_qty === '');
        if (пустые.length) {
            return Layout.showNotification(
                t('shop_not_counted').replace('%s', пустые.length), 'warning');
        }
        const безПричины = данные.filter(с => {
            const стр = строки.find(x => x.item_id === с.item_id);
            return Number(с.actual_qty) !== Number(стр.current_qty) && !с.reason.trim();
        });
        if (безПричины.length) {
            return Layout.showNotification(
                t('shop_explain_rows').replace('%s', безПричины.length), 'warning');
        }
        const расхождений = данные.filter(с => {
            const стр = строки.find(x => x.item_id === с.item_id);
            return Number(с.actual_qty) !== Number(стр.current_qty);
        }).length;
        if (!confirm(t('shop_confirm_apply').replace('%s', расхождений))) return;

        if (занято) return;
        занято = true;
        $('#applyInv')?.setAttribute('disabled', 'disabled');
        try {
            if (!await сохранить(true)) return;

            const { data, error } = await Layout.db.rpc('shop_apply_inventory', { p_inventory: ведомость.id });
            if (error) return Layout.handleError(error, t('shop_err_apply_inv'));
            Layout.showNotification(t('shop_applied')
                .replace('%s', data?.недостач ?? 0).replace('%s', data?.излишков ?? 0), 'success');
            await перерисовать();
        } finally { занято = false; }
    }

    function открытьСписание() {
        $('#woItem').innerHTML = товары.filter(т => т.is_active)
            .map(т => `<option value="${т.id}">${e(Layout.getName(т))}</option>`).join('');
        $('#woQty').value = '';
        $('#woNote').value = '';
        woModal.showModal();
    }

    async function списать() {
        const кол = Number($('#woQty').value);
        if (!(кол > 0)) return Layout.showNotification(t('shop_enter_qty'), 'warning');
        if (занято) return;
        занято = true;
        $('#woGo')?.setAttribute('disabled', 'disabled');
        try { await отправитьСписание(кол); }
        finally { занято = false; $('#woGo')?.removeAttribute('disabled'); }
    }

    async function отправитьСписание(кол) {
        const { error } = await Layout.db.rpc('shop_writeoff', {
            payload: {
                item_id: $('#woItem').value,
                qty: кол,
                reason: $('#woReason').value,
                at_whose_cost: $('#woCost').value || null,
                note: $('#woNote').value || null,
            },
        });
        if (error) return Layout.handleError(error, t('shop_err_writeoff'));
        woModal.close();
        Layout.showNotification(t('shop_written_off'), 'success');
        await перерисовать();
    }

    async function перерисовать() {
        if (!await загрузить()) return;
        рисоватьВедомость();
        рисоватьСписания();
        ShopUtils.права();
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'startInv') {
                const { error } = await Layout.db.rpc('shop_create_inventory', { p_note: null });
                if (error) return Layout.handleError(error, t('shop_err_start_inv'));
                return перерисовать();
            }
            if (b.id === 'saveInv') return сохранить();
            if (b.id === 'applyInv') return провести();
            if (b.id === 'dropInv') {
                const посчитано = строки.filter(с => с.actual_qty !== null).length;
                if (!confirm(посчитано
                        ? t('shop_confirm_drop').replace('%s', посчитано)
                        : t('shop_confirm_drop_plain'))) return;
                const { error } = await Layout.db.rpc('shop_drop_inventory', { p_inventory: ведомость.id });
                if (error) return Layout.handleError(error, t('shop_err_drop_inv'));
                Layout.showNotification(t('shop_sheet_deleted'), 'success');
                return перерисовать();
            }
            if (b.id === 'newWriteoff') return открытьСписание();
            if (b.id === 'woGo') return списать();
        });

        document.addEventListener('input', ev => {
            if (ev.target.dataset.fact === undefined) return;
            // пересчитываем только разницу, чтобы не сбить ввод
            const id = ev.target.dataset.fact;
            const стр = строки.find(с => с.item_id === id);
            const ячейка = ev.target.closest('tr')?.querySelector('[data-label="Разница"]');
            if (!стр || !ячейка) return;
            const v = ev.target.value;
            if (v === '') { ячейка.textContent = '—'; ячейка.className = 'text-right nums'; return; }
            const разница = Number(v) - Number(стр.current_qty);
            ячейка.textContent = (разница > 0 ? '+' : '') + штук(разница);
            ячейка.className = 'text-right nums ' +
                (разница < 0 ? 'diff-neg' : разница > 0 ? 'diff-pos' : 'opacity-50');
        });

        document.addEventListener('change', ev => {
            if (ev.target.id === 'bulkCost') общийСчёт = ev.target.value;
        });
    }

    async function init() {
        слушать();
        await перерисовать();
    }

    return { init };
})();
