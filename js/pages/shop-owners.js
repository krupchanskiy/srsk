/**
 * Владельцы товара: сколько кому должны, расчёты и возврат непроданного.
 *
 * Главная цифра экрана — «к оплате». Колонки «списано» разведены нарочно:
 * при расчёте разговор идёт не о сумме, а о судьбе каждого экземпляра.
 * Платит казначей своими правами — продавцу функция расчёта откажет.
 */
const ShopOwners = (() => {
    const t = key => Layout.t(key);
    const e = str => Layout.escapeHtml(str ?? '');
    const { деньги, штук } = ShopUtils;

    let владельцы = [], счета = [], текущий = null, остаток = [];
    let занято = false, ключРасчёта = null;
    const $ = s => document.querySelector(s);
    const казначей = () => !!(window.currentUser?.is_superuser || window.hasPermission?.('fin_admin'));
    const заведующий = () => !!window.hasPermission?.('shop_manage');

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('shop_v_owner_report').select('*').order('name'),
            казначей()
                ? Layout.db.from('fin_v_account_balances').select('account_id, name, currency_code')
                    .eq('is_active', true).eq('kind', 'real').eq('currency_code', 'INR').order('name')
                : Promise.resolve({ data: [] }),
        ]);
        if (ShopUtils.ошибка(ответы, 'Загрузка владельцев')) return false;

        const [{ data: вл }, { data: сч }] = ответы;
        владельцы = вл || [];
        счета = (сч || []).map(с => ({ id: с.account_id, name: с.name }));
        return true;
    }

    function рисовать() {
        $('#ownersTbl').tBodies[0].innerHTML = владельцы.map(в => `
            <tr>
                <td class="head" data-label="">${e(в.name)}</td>
                <td data-label="На полке" class="text-right nums">${штук(в.on_shelf)}</td>
                <td data-label="Продано" class="text-right nums">${штук(в.sold_qty)}</td>
                <td data-label="Возвращено" class="text-right nums">${в.returned_qty > 0 ? штук(в.returned_qty) : '—'}</td>
                <td data-label="Списано за наш счёт" class="text-right nums">${в.written_off_us > 0 ? штук(в.written_off_us) : '—'}</td>
                <td data-label="За его счёт" class="text-right nums">${в.written_off_owner > 0 ? штук(в.written_off_owner) : '—'}</td>
                <td data-label="Выплачено" class="text-right nums opacity-70">${в.settled > 0 ? деньги(в.settled) : '—'}</td>
                <td data-label="К оплате" class="text-right nums font-bold ${в.debt < 0 ? 'text-success' : ''}">
                    ${деньги(в.debt)}${в.debt < 0 ? ' <span class="text-xs font-normal">переплата</span>' : ''}</td>
                <td data-label="Потери">
                    <span class="badge badge-sm ${в.loss_policy === 'compensate' ? 'badge-warning' : 'badge-ghost'}">
                        ${в.loss_policy === 'compensate' ? 'компенсируем' : 'за его счёт'}</span></td>
                <td data-label="" class="text-right whitespace-nowrap">
                    ${заведующий() ? `<button class="btn btn-ghost btn-xs" data-card="${в.owner_id}">Карточка</button>` : ''}
                    ${в.on_shelf > 0 ? `<button class="btn btn-ghost btn-xs" data-return="${в.owner_id}">Вернуть непроданное</button>` : ''}
                    ${казначей() && в.debt > 0
                        ? `<button class="btn btn-outline btn-xs" data-settle="${в.owner_id}">Рассчитаться</button>` : ''}
                </td>
            </tr>`).join('') || '<tr><td colspan="10" class="text-center opacity-60 py-6">Владельцев пока нет</td></tr>';
    }

    async function рисоватьПроект() {
        // штуки берём из магазина, деньги — из финмодуля по объекту «Мурти Госвами»
        const { data: товары } = await Layout.db.from('shop_items')
            .select('id').eq('source', 'own').eq('is_active', true);
        const ids = (товары || []).map(i => i.id);

        let выпущено = 0, продано = 0, наполке = 0;
        if (ids.length) {
            const [{ data: партии }, { data: продажи }] = await Promise.all([
                Layout.db.from('shop_batches').select('qty_received, qty_left').in('item_id', ids),
                Layout.db.from('shop_sale_items').select('qty, shop_sales!inner(status)').in('item_id', ids),
            ]);
            выпущено = (партии || []).reduce((s, б) => s + Number(б.qty_received), 0);
            наполке  = (партии || []).reduce((s, б) => s + Number(б.qty_left), 0);
            продано  = (продажи || []).filter(п => п.shop_sales?.status === 'posted')
                                      .reduce((s, п) => s + Number(п.qty), 0);
        }

        const ячейка = (ключ, значение, цвет = '') => `
            <div class="stat py-3">
                <div class="stat-title text-xs">${e(ключ)}</div>
                <div class="stat-value text-xl nums ${цвет}">${значение}</div>
            </div>`;

        $('#murtiStats').innerHTML =
            ячейка('Выпущено', штук(выпущено) + ' шт') +
            ячейка('Продано', штук(продано) + ' шт') +
            ячейка('На полке', штук(наполке) + ' шт') +
            ячейка('Экономика', 'в финмодуле', 'text-base opacity-60');
    }

    // ---------- расчёт ----------
    function открытьРасчёт(ownerId) {
        текущий = владельцы.find(в => в.owner_id === ownerId);
        if (!текущий) return;
        // ключ живёт на всю открытую модалку: повторная отправка той же выплаты
        // возвращает ту же запись, а не платит владельцу дважды
        ключРасчёта = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
        $('#settleOwner').textContent = `Расчёт с «${текущий.name}»`;
        $('#settleDebt').textContent = `К оплате ${деньги(текущий.debt)}`;
        $('#settleAmount').value = Math.max(0, Math.round(Number(текущий.debt)));
        $('#settleNote').value = '';
        $('#settleAccount').innerHTML = счета.map(с => `<option value="${с.id}">${e(с.name)}</option>`).join('')
            || '<option value="">Нет рупиевых счетов</option>';
        settleModal.showModal();
    }

    async function заплатить() {
        const сумма = Number($('#settleAmount').value);
        if (!(сумма > 0)) return Layout.showNotification('Укажите сумму выплаты', 'warning');
        if (!$('#settleAccount').value) return Layout.showNotification('Выберите счёт', 'warning');
        if (!confirm(`Выплатить «${текущий.name}» ${деньги(сумма)}? Операция уйдёт в финмодуль.`)) return;
        if (занято) return;
        занято = true;
        $('#settleGo').setAttribute('disabled', 'disabled');
        try {
            const { data, error } = await Layout.db.rpc('shop_settle_owner', {
                payload: {
                    owner_id: текущий.owner_id,
                    amount: сумма,
                    account_id: $('#settleAccount').value,
                    note: $('#settleNote').value || null,
                    client_uid: ключРасчёта,
                },
            });
            if (error) return Layout.handleError(error, 'Расчёт с владельцем');
            settleModal.close();
            Layout.showNotification(data?.повтор
                ? `Эта выплата уже прошла. Осталось ${деньги(data?.осталось)}`
                : `Выплачено. Осталось ${деньги(data?.осталось)}`, 'success');
            if (await загрузить()) рисовать();
        } finally {
            занято = false;
            $('#settleGo').removeAttribute('disabled');
        }
    }

    // ---------- карточка владельца ----------
    function открытьКарточку(ownerId) {
        текущий = ownerId ? владельцы.find(в => в.owner_id === ownerId) : null;
        $('#cardTitle').textContent = текущий ? 'Владелец товара' : 'Новый владелец';
        $('#cardName').value = текущий?.name || '';
        $('#cardPolicy').value = текущий?.loss_policy || 'compensate';
        $('#cardContact').value = '';
        $('#cardNote').value = текущий?.note || '';
        $('#cardActive').checked = текущий ? текущий.is_active !== false : true;
        cardModal.showModal();
    }

    async function сохранитьКарточку() {
        const имя = $('#cardName').value.trim();
        if (!имя) return Layout.showNotification('Укажите имя владельца', 'warning');
        if (занято) return;
        занято = true;
        $('#cardGo').setAttribute('disabled', 'disabled');
        try {
            const { data, error } = await Layout.db.rpc('shop_upsert_owner', {
                payload: {
                    owner_id: текущий?.owner_id || null,
                    name: имя,
                    loss_policy: $('#cardPolicy').value,
                    contact_info: $('#cardContact').value || null,
                    note: $('#cardNote').value || null,
                    is_active: $('#cardActive').checked,
                },
            });
            if (error) return Layout.handleError(error, 'Карточка владельца');
            cardModal.close();
            Layout.showNotification(data?.сообщение || (data?.создан ? 'Владелец добавлен' : 'Сохранено'), 'success');
            if (await загрузить()) рисовать();
        } finally {
            занято = false;
            $('#cardGo').removeAttribute('disabled');
        }
    }

    // ---------- возврат непроданного ----------
    async function открытьВозврат(ownerId) {
        текущий = владельцы.find(в => в.owner_id === ownerId);
        if (!текущий) return;
        const ответ = await Layout.db.from('shop_v_owner_stock')
            .select('item_id, name_ru, name_en, name_hi, qty').eq('owner_id', ownerId);
        if (ShopUtils.ошибка(ответ, 'Остаток владельца')) return;
        остаток = ответ.data || [];

        $('#returnOwner').textContent = `Вернуть непроданное — «${текущий.name}»`;
        $('#returnTbl').tBodies[0].innerHTML = остаток.map(п => `
            <tr>
                <td>${e(Layout.getName(п))}</td>
                <td class="text-right nums">${штук(п.qty)}</td>
                <td class="text-right">
                    <input type="number" class="input input-bordered input-sm w-24 text-right nums"
                           data-ret="${п.item_id}" min="0" max="${п.qty}" placeholder="0">
                </td>
            </tr>`).join('') || '<tr><td colspan="3" class="text-center opacity-60 py-4">На полке ничего нет</td></tr>';
        returnModal.showModal();
    }

    async function оформитьВозврат() {
        const items = [...document.querySelectorAll('[data-ret]')]
            .map(el => ({ item_id: el.dataset.ret, qty: Number(el.value) || 0 }))
            .filter(п => п.qty > 0);
        if (!items.length) {
            return Layout.showNotification('Не указано, что забирает владелец', 'warning');
        }
        const штукВсего = items.reduce((s, п) => s + п.qty, 0);
        if (!confirm(`Владелец забирает ${штук(штукВсего)} — снять с полки?`)) return;
        if (занято) return;
        занято = true;
        $('#returnGo').setAttribute('disabled', 'disabled');
        try {
            const { error } = await Layout.db.rpc('shop_return_to_owner', {
                payload: { owner_id: текущий.owner_id, items },
            });
            if (error) return Layout.handleError(error, 'Возврат владельцу');
            returnModal.close();
            Layout.showNotification('Возврат оформлен, товар снят с полки', 'success');
            if (await загрузить()) рисовать();
        } finally {
            занято = false;
            $('#returnGo').removeAttribute('disabled');
        }
    }

    function слушать() {
        document.addEventListener('click', ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.dataset.settle) return открытьРасчёт(b.dataset.settle);
            if (b.dataset.card) return открытьКарточку(b.dataset.card);
            if (b.id === 'newOwner') return открытьКарточку(null);
            if (b.id === 'cardGo') return сохранитьКарточку();
            if (b.dataset.return) return открытьВозврат(b.dataset.return);
            if (b.id === 'settleGo') return заплатить();
            if (b.id === 'returnGo') return оформитьВозврат();
        });
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        рисовать();
        ShopUtils.права();
        await рисоватьПроект();
    }

    return { init };
})();
