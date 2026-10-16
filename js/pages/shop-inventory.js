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
    const { штук, деньги, ПРИЧИНЫ_СПИСАНИЯ: ПРИЧИНЫ } = ShopUtils;

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
        if (ShopUtils.ошибка(ответы, 'Загрузка инвентаризации')) return false;

        const [{ data: вед }, { data: тов }, { data: сп }] = ответы;
        товары = тов || [];
        списания = сп || [];
        ведомость = (вед || [])[0]?.status === 'draft' ? вед[0] : null;

        строки = [];
        if (ведомость) {
            const ответ = await Layout.db.from('shop_v_inventory_items')
                .select('*').eq('inventory_id', ведомость.id);
            if (ShopUtils.ошибка(ответ, 'Загрузка ведомости')) return false;
            строки = (ответ.data || []).sort((a, b) =>
                (Layout.getName(a) || '').localeCompare(Layout.getName(b) || '', 'ru'));
        }
        return true;
    }

    function рисоватьВедомость() {
        const действия = $('#invActions');

        if (!ведомость) {
            $('#invTitle').textContent = 'Ведомость';
            $('#invMeta').textContent = 'незавершённых нет';
            действия.innerHTML = можно()
                ? `<button class="btn btn-sm" id="startInv" style="background: var(--current-color); color:#fff;">
                     Начать инвентаризацию</button>` : '';
            $('#invBody').innerHTML = `<div class="text-sm opacity-60">
                Начните ведомость — в неё попадёт весь товар, включая тот, что числится по нулям:
                нулевой остаток тоже нужно подтвердить глазами, иначе недостача не найдётся.</div>`;
            return;
        }

        $('#invTitle').textContent = `Ведомость №${ведомость.number}`;
        $('#invMeta').textContent = `от ${DateUtils.formatShort(DateUtils.parseDate(ведомость.inventory_date))}`;
        действия.innerHTML = можно() ? `
            <select class="select select-bordered select-sm" id="bulkCost" title="За чей счёт расхождения по чужому товару">
                <option value="us" ${общийСчёт === 'us' ? 'selected' : ''}>недостачу компенсируем владельцам</option>
                <option value="owner" ${общийСчёт === 'owner' ? 'selected' : ''}>недостача за счёт владельцев</option>
            </select>
            <button class="btn btn-sm btn-outline" id="saveInv">Сохранить</button>
            <button class="btn btn-sm" id="applyInv" style="background: var(--current-color); color:#fff;">Провести</button>
            <button class="btn btn-sm btn-ghost" id="dropInv">Удалить</button>` : '';

        const посчитано = строки.filter(с => с.actual_qty !== null).length;
        $('#invBody').innerHTML = `
            <div class="text-sm opacity-60 mb-3">
                Посчитано ${посчитано} из ${строки.length}. Пустое поле — товар ещё не считали.
            </div>
            <div class="overflow-x-auto">
                <table class="table table-sm stack" id="invTbl">
                    <thead><tr>
                        <th>Товар</th><th class="text-right">В учёте</th><th class="text-right">Факт</th>
                        <th class="text-right">Разница</th><th>Причина</th><th>За чей счёт</th>
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
                ${с.has_owner ? '<span class="badge badge-sm badge-ghost">чужой</span>' : ''}</td>
            <td data-label="В учёте" class="text-right nums opacity-70">${штук(с.current_qty)}</td>
            <td data-label="Факт" class="text-right">
                <input type="number" class="input input-bordered input-sm w-24 text-right nums"
                       data-fact="${с.item_id}" value="${факт ?? ''}" step="0.001"
                       ${можно() ? '' : 'disabled'}></td>
            <td data-label="Разница" class="text-right nums ${класс}">
                ${разница === null ? '—' : (разница > 0 ? '+' : '') + штук(разница)}</td>
            <td data-label="Причина">
                <input type="text" class="input input-bordered input-sm w-full"
                       data-reason="${с.item_id}" value="${e(с.reason || '')}"
                       placeholder="${разница && разница !== 0 ? 'обязательно' : ''}"
                       ${можно() ? '' : 'disabled'}></td>
            <td data-label="За чей счёт">
                ${с.has_owner ? `
                <select class="select select-bordered select-sm" data-cost="${с.item_id}" ${можно() ? '' : 'disabled'}>
                    <option value="">как у всех</option>
                    <option value="us" ${с.at_whose_cost === 'us' ? 'selected' : ''}>компенсируем</option>
                    <option value="owner" ${с.at_whose_cost === 'owner' ? 'selected' : ''}>за счёт владельца</option>
                </select>` : '<span class="opacity-40">—</span>'}</td>
        </tr>`;
    }

    function рисоватьСписания() {
        $('#woTbl').tBodies[0].innerHTML = списания.map(с => `
            <tr>
                <td data-label="Дата" class="nums">${DateUtils.formatShort(new Date(с.created_at))}</td>
                <td data-label="Товар" class="head">${e(Layout.getName(с.shop_items || {}))}</td>
                <td data-label="Количество" class="text-right nums">${штук(с.qty)}</td>
                <td data-label="Причина">${e(ПРИЧИНЫ[с.reason] || с.reason)}
                    ${с.note ? `<span class="opacity-60">· ${e(с.note)}</span>` : ''}</td>
                <td data-label="За чей счёт">${с.at_whose_cost === 'us' ? 'наш' : 'владельца'}</td>
                <td data-label="Компенсация" class="text-right nums">${
                    Number(с.compensation) > 0 ? деньги(с.compensation) : '—'}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="text-center opacity-60 py-6">Списаний пока не было</td></tr>';
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
        if (error) { Layout.handleError(error, 'Сохранение ведомости'); return false; }
        if (!тихо) Layout.showNotification('Ведомость сохранена', 'success');
        return true;
    }

    async function провести() {
        const данные = собратьСтроки();
        const пустые = данные.filter(с => с.actual_qty === '');
        if (пустые.length) {
            return Layout.showNotification(
                `Не посчитано позиций: ${пустые.length}. Проставьте факт везде, даже нули`, 'warning');
        }
        const безПричины = данные.filter(с => {
            const стр = строки.find(x => x.item_id === с.item_id);
            return Number(с.actual_qty) !== Number(стр.current_qty) && !с.reason.trim();
        });
        if (безПричины.length) {
            return Layout.showNotification(
                `Объясните расхождения: без причины ${безПричины.length} позиций`, 'warning');
        }
        const расхождений = данные.filter(с => {
            const стр = строки.find(x => x.item_id === с.item_id);
            return Number(с.actual_qty) !== Number(стр.current_qty);
        }).length;
        if (!confirm(`Провести ведомость? Расхождений: ${расхождений}. ` +
                     'Недостачи спишутся, излишки встанут на полку — отменить это нельзя.')) return;

        if (занято) return;
        занято = true;
        $('#applyInv')?.setAttribute('disabled', 'disabled');
        try {
            if (!await сохранить(true)) return;

            const { data, error } = await Layout.db.rpc('shop_apply_inventory', { p_inventory: ведомость.id });
            if (error) return Layout.handleError(error, 'Проведение инвентаризации');
            Layout.showNotification(
                `Проведено: недостач ${data?.недостач ?? 0}, излишков ${data?.излишков ?? 0}`, 'success');
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
        if (!(кол > 0)) return Layout.showNotification('Укажите количество', 'warning');
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
        if (error) return Layout.handleError(error, 'Списание');
        woModal.close();
        Layout.showNotification('Списано', 'success');
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
                if (error) return Layout.handleError(error, 'Начало инвентаризации');
                return перерисовать();
            }
            if (b.id === 'saveInv') return сохранить();
            if (b.id === 'applyInv') return провести();
            if (b.id === 'dropInv') {
                const посчитано = строки.filter(с => с.actual_qty !== null).length;
                if (!confirm(посчитано
                        ? `Удалить ведомость? Посчитанное пропадёт: позиций ${посчитано}.`
                        : 'Удалить ведомость?')) return;
                const { error } = await Layout.db.rpc('shop_drop_inventory', { p_inventory: ведомость.id });
                if (error) return Layout.handleError(error, 'Удаление ведомости');
                Layout.showNotification('Ведомость удалена', 'success');
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
