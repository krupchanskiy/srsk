/**
 * Смена магазина: пересчёт ящика, закрытие, сдача выручки казначею.
 *
 * Деньги попадают в журнал не при закрытии смены, а когда их принял казначей:
 * доход в финмодуле заводит только администратор финансов, и ослаблять это
 * ради магазина неправильно. Физически деньги переходят в кассу ашрама
 * в тот же момент, так что схема совпадает с жизнью.
 */
const ShopShift = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const { ЗНАК, деньги } = ShopUtils;

    let смена = null, операции = [], ожидаем = [], пересчёт = {}, причины = {};
    let пакет = null, строкиПакета = [], счета = [], естьЗакрытыеНесданные = false;
    let история = [], занято = false;

    const $ = s => document.querySelector(s);
    const админФинансов = () => !!(window.currentUser?.is_superuser || window.hasPermission?.('fin_admin'));

    async function загрузить() {
        const ответСмены = await Layout.db.from('shop_shifts')
            .select('id, opened_at, closed_at, status, float_amount, opened_by, handover_id')
            .order('opened_at', { ascending: false }).limit(1);
        if (ShopUtils.ошибка(ответСмены, 'Загрузка смены')) return false;
        смена = ответСмены.data?.[0] || null;

        if (смена) {
            const ответы = await Promise.all([
                Layout.db.from('shop_sales')
                    .select('id, number, sold_at, currency_code, items_total, donation_amount, paid_amount, status, shop_sale_items(qty, shop_items(name_ru))')
                    .eq('shift_id', смена.id).order('sold_at', { ascending: false }),
                Layout.db.rpc('shop_shift_expected', { p_shift: смена.id }),
            ]);
            if (ShopUtils.ошибка(ответы, 'Загрузка смены')) return false;
            операции = ответы[0].data || [];
            ожидаем = ответы[1].data || [];

            const { data: счёты, error: ошСчётов } = await Layout.db.from('shop_cash_counts')
                .select('currency_code, actual, reason').eq('shift_id', смена.id);
            if (ShopUtils.ошибка({ error: ошСчётов }, 'Пересчёт ящика')) return false;
            (счёты || []).forEach(с => { пересчёт[с.currency_code] = с.actual; причины[с.currency_code] = с.reason || ''; });
        }

        const { data: пакеты, error: ошПакета } = await Layout.db.from('shop_handovers')
            .select('id, created_at, status, accepted_at, shop_handover_lines(currency_code, goods_amount, murti_amount, donation_amount, discrepancy)')
            .eq('status', 'pending').order('created_at', { ascending: false }).limit(1);
        if (ShopUtils.ошибка({ error: ошПакета }, 'Пакет к сдаче')) return false;
        пакет = пакеты?.[0] || null;
        строкиПакета = пакет?.shop_handover_lines || [];

        const { count } = await Layout.db.from('shop_shifts')
            .select('id', { count: 'exact', head: true }).eq('status', 'closed').is('handover_id', null);
        естьЗакрытыеНесданные = (count || 0) > 0;

        if (пакет && админФинансов()) {
            // напрямую fin_accounts закрыта даже для казначея — финмодуль отдаёт счета своим представлением
            const { data: сч } = await Layout.db.from('fin_v_account_balances')
                .select('account_id, name, currency_code, kind, is_active')
                .eq('is_active', true).eq('kind', 'real').eq('group_name', 'Касса').order('name');
            счета = (сч || []).map(с => ({ id: с.account_id, name: с.name, currency_code: с.currency_code }));
        }

        // история нужна, чтобы спорный день можно было поднять через неделю:
        // экран «последней смены» показывает только сегодня
        const { data: прошлые } = await Layout.db.from('shop_shifts')
            .select('id, opened_at, closed_at, status, float_amount, handover_id, shop_handovers(status, accepted_at)')
            .order('opened_at', { ascending: false }).limit(11);
        история = (прошлые || []).filter(с => с.id !== смена?.id).slice(0, 10);

        return true;
    }

    // ---------- шапка ----------
    function рисоватьШапку() {
        if (!смена) {
            $('#shiftTitle').textContent = 'Смены ещё не было';
            $('#shiftMeta').textContent = 'Она откроется сама, когда пробьёте первый чек';
            $('#shiftStats').innerHTML = '';
            $('#floatAmount').value = '';
            return;
        }
        const открыта = new Date(смена.opened_at);
        $('#shiftTitle').textContent = `Смена ${DateUtils.formatShort(открыта)}`;
        $('#shiftMeta').textContent = смена.status === 'open'
            ? `открыта в ${DateUtils.formatTime(открыта)}`
            : `закрыта в ${DateUtils.formatTime(new Date(смена.closed_at))}`;
        $('#floatAmount').value = Number(смена.float_amount) || 0;
        $('#floatAmount').disabled = смена.status !== 'open';

        const проведённые = операции.filter(о => о.status === 'posted');
        const товары = проведённые.reduce((s, о) => s + Number(о.items_total), 0);
        const дары = проведённые.reduce((s, о) => s + Number(о.donation_amount) *
            (о.currency_code === 'INR' ? 1 : курсИз(о)), 0);
        const поВалютам = {};
        проведённые.forEach(о => {
            поВалютам[о.currency_code] = (поВалютам[о.currency_code] || 0) + Number(о.paid_amount);
        });

        const ячейка = (ключ, значение, цвет = '') =>
            `<div class="stat-cell"><div class="text-xs opacity-60 font-semibold">${e(ключ)}</div>
             <div class="text-lg font-bold nums ${цвет}">${значение}</div></div>`;

        $('#shiftStats').innerHTML = [
            ячейка('Операций', проведённые.length),
            ячейка('Выручка всего', деньги(товары + дары)),
            ячейка('из них товары', деньги(товары)),
            ячейка('из них пожертвования', деньги(дары), 'text-secondary'),
            ...Object.entries(поВалютам).map(([в, с]) => ячейка(`Наличными ${ЗНАК[в]}`, деньги(с, в))),
            ячейка('Размен', деньги(Number(смена.float_amount) || 0)),
        ].join('');
    }

    // курс чека: paid_amount в валюте платежа, items_total в рупиях
    function курсИз(о) {
        const товарнаяЧасть = Number(о.paid_amount) - Number(о.donation_amount);
        return товарнаяЧасть > 0 ? Number(о.items_total) / товарнаяЧасть : 1;
    }

    // ---------- пересчёт ----------
    function рисоватьПересчёт() {
        if (!смена || смена.status !== 'open') {
            $('#countCard').hidden = true;
            return;
        }
        $('#countCard').hidden = false;

        $('#countBoxes').innerHTML = ожидаем.map(ж => {
            const факт = пересчёт[ж.currency_code];
            const введено = факт !== undefined && факт !== '';
            const разница = введено ? Number(факт) - Number(ж.expected) : null;
            return `
            <label class="form-control">
                <div class="label py-1"><span class="label-text text-sm">
                    ${ЗНАК[ж.currency_code]} · должно быть
                    <b class="nums">${деньги(ж.expected, ж.currency_code)}</b></span></div>
                <input type="number" class="input input-bordered input-sm nums" data-count="${ж.currency_code}"
                       value="${введено ? e(факт) : ''}" placeholder="сколько насчитали">
                ${разница === null ? ''
                  : разница === 0
                    ? '<span class="text-xs text-success mt-1">сходится</span>'
                    : `<span class="text-xs text-error mt-1">расхождение ${разница > 0 ? '+' : ''}${деньги(разница, ж.currency_code)}</span>
                       <input class="input input-bordered input-sm mt-1" data-why="${ж.currency_code}"
                              value="${e(причины[ж.currency_code] || '')}" placeholder="Причина расхождения">`}
            </label>`;
        }).join('') || '<div class="text-sm opacity-60">Продаж ещё не было — пересчитывать нечего</div>';

        const всёВведено = ожидаем.every(ж => (пересчёт[ж.currency_code] ?? '') !== '');
        const объяснено = ожидаем.every(ж => {
            const факт = пересчёт[ж.currency_code];
            if (факт === undefined || факт === '') return false;
            return Number(факт) === Number(ж.expected) || (причины[ж.currency_code] || '').trim() !== '';
        });
        $('#closeShift').disabled = !ожидаем.length || !всёВведено || !объяснено;
        $('#closeNote').textContent = !ожидаем.length ? 'Закрывать нечего'
            : !всёВведено ? 'Сначала пересчитайте ящик'
            : !объяснено ? 'Объясните расхождение — без причины закрыть нельзя'
            : 'Готово к закрытию';
    }

    // ---------- сдача ----------
    function рисоватьСдачу() {
        const тело = $('#handoverBody');

        if (пакет) {
            const итог = строкиПакета.map(л => {
                const р = Number(л.discrepancy) || 0;
                return `
                <tr><td data-label="Валюта">${ЗНАК[л.currency_code]}</td>
                    <td data-label="Товары" class="text-right nums">${деньги(л.goods_amount, л.currency_code)}</td>
                    <td data-label="Свой выпуск" class="text-right nums">${деньги(л.murti_amount, л.currency_code)}</td>
                    <td data-label="Пожертвования" class="text-right nums">${деньги(л.donation_amount, л.currency_code)}</td>
                    <td data-label="Расхождение кассы" class="text-right nums ${р < 0 ? 'text-error' : р > 0 ? 'text-success' : 'opacity-50'}">
                        ${р === 0 ? '—' : (р > 0 ? '+' : '') + деньги(р, л.currency_code)}</td>
                </tr>`;
            }).join('');

            const выборСчетов = админФинансов() ? строкиПакета.map(л => `
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm">Куда зачислить ${ЗНАК[л.currency_code]}</span></div>
                    <select class="select select-bordered select-sm" data-account="${л.currency_code}">
                        ${счета.filter(с => с.currency_code === л.currency_code)
                            .map(с => `<option value="${с.id}">${e(с.name)}</option>`).join('')
                          || '<option value="">Нет счёта в этой валюте</option>'}
                    </select>
                </label>`).join('') : '';

            $('#handoverNote').textContent = 'Пакет собран и ждёт казначея';
            тело.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="table table-sm stack">
                        <thead><tr><th>Валюта</th><th class="text-right">Товары</th>
                            <th class="text-right">Свой выпуск</th><th class="text-right">Пожертвования</th>
                            <th class="text-right">Расхождение кассы</th></tr></thead>
                        <tbody>${итог}</tbody>
                    </table>
                </div>
                ${админФинансов() ? `
                    <div class="grid gap-3 md:grid-cols-3">${выборСчетов}</div>
                    <div><button class="btn btn-sm" id="acceptHandover"
                        style="background: var(--current-color); color:#fff;">Принять выручку</button></div>`
                : '<div class="text-sm opacity-60">Деньги принимает казначей — он проведёт их в финмодуле.</div>'}`;
            return;
        }

        $('#handoverNote').textContent = естьЗакрытыеНесданные
            ? 'Есть закрытые смены, которые ещё не сдавали'
            : 'Всё сдано';
        тело.innerHTML = естьЗакрытыеНесданные
            ? `<div><button class="btn btn-sm btn-outline" id="prepareHandover" data-permission="shop_settle">
                   Собрать пакет к сдаче</button></div>`
            : '<div class="text-sm opacity-60">Непереданной выручки нет.</div>';
    }

    // ---------- операции ----------
    function рисоватьОперации() {
        const последняяПроведённая = операции.find(о => о.status === 'posted');
        $('#opsTbl').tBodies[0].innerHTML = операции.map(о => {
            const позиции = (о.shop_sale_items || [])
                .map(п => `${п.shop_items?.name_ru || 'товар'}${Number(п.qty) > 1 ? ' ×' + Number(п.qty) : ''}`)
                .join(', ');
            const что = позиции || `Пожертвование`;
            const сумма = Number(о.items_total) + Number(о.donation_amount) *
                (о.currency_code === 'INR' ? 1 : курсИз(о));
            const можноОтменить = о.status === 'posted' && о === последняяПроведённая && смена?.status === 'open';
            return `<tr class="${о.status === 'cancelled' ? 'opacity-50' : ''}">
                <td data-label="Время" class="nums">${DateUtils.formatTime(new Date(о.sold_at))}</td>
                <td data-label="Что">${e(что)}
                    ${Number(о.donation_amount) > 0 && позиции ? '<span class="badge badge-sm badge-secondary">+ дар</span>' : ''}
                    ${!позиции ? '<span class="badge badge-sm badge-secondary">дар</span>' : ''}
                    ${о.status === 'cancelled' ? '<span class="badge badge-sm">отменён</span>' : ''}</td>
                <td data-label="Сумма" class="text-right nums">${деньги(сумма)}</td>
                <td data-label="Оплата">${о.currency_code === 'INR'
                    ? 'наличные ₹' : деньги(о.paid_amount, о.currency_code)}</td>
                <td data-label="">${можноОтменить
                    ? `<button class="btn btn-ghost btn-xs" data-cancel="${о.id}">Отменить</button>` : ''}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="5" class="text-center opacity-60 py-6">Операций пока не было</td></tr>';

        $('#opsCount').textContent = операции.length
            ? `${операции.filter(о => о.status === 'posted').length} проведено`
            : '';
    }

    function рисоватьИсторию() {
        $('#histTbl').tBodies[0].innerHTML = история.map(с => {
            const сдача = с.shop_handovers;
            const статус = с.status === 'open' ? '<span class="badge badge-sm badge-warning">открыта</span>'
                : !с.handover_id ? '<span class="badge badge-sm">не сдана</span>'
                : сдача?.status === 'accepted'
                    ? `<span class="badge badge-sm badge-success">принята ${
                        DateUtils.formatShort(new Date(сдача.accepted_at))}</span>`
                    : '<span class="badge badge-sm badge-info">пакет у казначея</span>';
            const открыта = new Date(с.opened_at);
            return `<tr>
                <td data-label="Смена" class="nums">${DateUtils.formatShort(открыта)}
                    <span class="opacity-60">${DateUtils.formatTime(открыта)}</span></td>
                <td data-label="Закрыта" class="nums opacity-70">${с.closed_at
                    ? DateUtils.formatTime(new Date(с.closed_at)) : '—'}</td>
                <td data-label="Размен" class="text-right nums opacity-70">${деньги(с.float_amount)}</td>
                <td data-label="Сдача">${статус}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="4" class="text-center opacity-60 py-6">Прошлых смен ещё нет</td></tr>';
    }

    async function перерисовать() {
        if (!await загрузить()) return;
        рисоватьШапку(); рисоватьПересчёт(); рисоватьСдачу(); рисоватьОперации(); рисоватьИсторию();
        ShopUtils.права();
    }

    // ---------- действия ----------
    // каждое действие на этом экране необратимо, поэтому кнопка гасится до ответа
    async function разово(кнопка, действие) {
        if (занято) return;
        занято = true;
        кнопка.setAttribute('disabled', 'disabled');
        try { await действие(); }
        finally { занято = false; кнопка.removeAttribute('disabled'); }
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const b = ev.target.closest('button');
            if (!b) return;

            if (b.id === 'closeShift') {
                const counts = ожидаем.map(ж => ({
                    currency_code: ж.currency_code,
                    actual: Number(пересчёт[ж.currency_code]),
                    reason: причины[ж.currency_code] || null,
                }));
                const расхождения = ожидаем
                    .map(ж => ({ ж, р: Number(пересчёт[ж.currency_code]) - Number(ж.expected) }))
                    .filter(x => x.р !== 0)
                    .map(x => `${деньги(x.р, x.ж.currency_code)}`);
                if (!confirm(расхождения.length
                        ? `Закрыть смену с расхождением (${расхождения.join(', ')})? ` +
                          'После закрытия чеки отменять нельзя — только возврат покупателю.'
                        : 'Закрыть смену? После закрытия чеки отменять нельзя — только возврат покупателю.')) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_close_shift',
                        { payload: { shift_id: смена.id, counts } });
                    if (error) return Layout.handleError(error, 'Закрытие смены');
                    Layout.showNotification('Смена закрыта', 'success');
                    пересчёт = {}; причины = {};
                    await перерисовать();
                });
            }

            if (b.id === 'prepareHandover') {
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_prepare_handover', { p_note: null });
                    if (error) return Layout.handleError(error, 'Сбор пакета');
                    Layout.showNotification('Пакет собран — передайте деньги казначею', 'success');
                    await перерисовать();
                });
            }

            if (b.id === 'acceptHandover') {
                const accounts = {};
                document.querySelectorAll('[data-account]').forEach(s => {
                    if (s.value) accounts[s.dataset.account] = s.value;
                });
                const безСчёта = строкиПакета.filter(л => !accounts[л.currency_code]);
                if (безСчёта.length) {
                    return Layout.showNotification(`Выберите счёт для ${
                        безСчёта.map(л => ЗНАК[л.currency_code] || л.currency_code).join(', ')}`, 'warning');
                }
                const суммы = строкиПакета.map(л => деньги(
                    Number(л.goods_amount) + Number(л.murti_amount) + Number(л.donation_amount),
                    л.currency_code)).join(', ');
                if (!confirm(`Принять выручку (${суммы})? Операции уйдут в финмодуль, отменить оттуда.`)) return;
                return разово(b, async () => {
                    const { data, error } = await Layout.db.rpc('shop_accept_handover', {
                        payload: { handover_id: пакет.id, accounts },
                    });
                    if (error) return Layout.handleError(error, 'Приём выручки');
                    if (data && data.ok === false) {
                        return Layout.showNotification(data.error?.message || 'Финмодуль отклонил проводку', 'error');
                    }
                    const итоги = (data?.итоги || []).map(и =>
                        `${деньги(и.выручка, и.валюта)}${Number(и.расхождение)
                            ? ` (расхождение ${деньги(и.расхождение, и.валюта)})` : ''}`).join(', ');
                    Layout.showNotification(`Принято: ${итоги || 'выручка проведена'}`, 'success');
                    await перерисовать();
                });
            }

            if (b.dataset.cancel) {
                if (!confirm('Отменить чек? Товар вернётся на полку, деньги нужно отдать покупателю.')) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_cancel_sale', {
                        p_sale_id: b.dataset.cancel, p_reason: 'Отменено на экране смены',
                    });
                    if (error) return Layout.handleError(error, 'Отмена чека');
                    Layout.showNotification('Чек отменён, товар вернулся на полку', 'success');
                    await перерисовать();
                });
            }
        });

        document.addEventListener('input', ev => {
            const el = ev.target;
            if (el.dataset.count !== undefined) {
                пересчёт[el.dataset.count] = el.value;
                const поз = el.selectionStart, вал = el.dataset.count;
                рисоватьПересчёт();
                const нов = document.querySelector(`[data-count="${вал}"]`);
                if (нов) { нов.focus(); try { нов.setSelectionRange(поз, поз); } catch { /* number */ } }
                return;
            }
            if (el.dataset.why !== undefined) {
                причины[el.dataset.why] = el.value;
                $('#closeShift').disabled = !ожидаем.every(ж => {
                    const факт = пересчёт[ж.currency_code];
                    if (факт === undefined || факт === '') return false;
                    return Number(факт) === Number(ж.expected) || (причины[ж.currency_code] || '').trim() !== '';
                });
                $('#closeNote').textContent = $('#closeShift').disabled
                    ? 'Объясните расхождение — без причины закрыть нельзя' : 'Готово к закрытию';
            }
        });

        // прямая запись в смену закрыта — размен меняется функцией, она же проверяет права
        $('#floatAmount').addEventListener('change', async ev => {
            if (!смена || смена.status !== 'open') return;
            const { error } = await Layout.db.rpc('shop_set_float', {
                p_shift: смена.id, p_amount: Number(ev.target.value) || 0,
            });
            if (error) return Layout.handleError(error, 'Разменный фонд');
            await перерисовать();
        });
    }

    async function init() {
        слушать();
        await перерисовать();
    }

    return { init };
})();
