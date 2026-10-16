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
    const t = key => Layout.t(key);
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
        if (ShopUtils.ошибка(ответСмены, t('shop_err_load_shift'))) return false;
        смена = ответСмены.data?.[0] || null;

        if (смена) {
            const ответы = await Promise.all([
                Layout.db.from('shop_sales')
                    .select('id, number, sold_at, currency_code, items_total, donation_amount, paid_amount, status, shop_sale_items(qty, shop_items(name_ru))')
                    .eq('shift_id', смена.id).order('sold_at', { ascending: false }),
                Layout.db.rpc('shop_shift_expected', { p_shift: смена.id }),
            ]);
            if (ShopUtils.ошибка(ответы, t('shop_err_load_shift'))) return false;
            операции = ответы[0].data || [];
            ожидаем = ответы[1].data || [];

            const { data: счёты, error: ошСчётов } = await Layout.db.from('shop_cash_counts')
                .select('currency_code, actual, reason').eq('shift_id', смена.id);
            if (ShopUtils.ошибка({ error: ошСчётов }, t('shop_err_counts'))) return false;
            (счёты || []).forEach(с => { пересчёт[с.currency_code] = с.actual; причины[с.currency_code] = с.reason || ''; });
        }

        const { data: пакеты, error: ошПакета } = await Layout.db.from('shop_handovers')
            .select('id, created_at, status, accepted_at, shop_handover_lines(currency_code, goods_amount, murti_amount, donation_amount, discrepancy)')
            .eq('status', 'pending').order('created_at', { ascending: false }).limit(1);
        if (ShopUtils.ошибка({ error: ошПакета }, t('shop_err_handover_pkg'))) return false;
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
        // смена открывается и сама, с первым чеком, но тогда размен в ней нулевой:
        // утром его кладут в ящик заранее и хотят записать до первой продажи
        const нужноОткрыть = !смена || смена.status !== 'open';
        $('#openShift').hidden = !нужноОткрыть;
        $('#floatAmount').disabled = нужноОткрыть ? false : смена.status !== 'open';

        if (!смена) {
            $('#shiftTitle').textContent = t('shop_shift_none');
            $('#shiftMeta').textContent = t('shop_shift_open_hint');
            $('#shiftStats').innerHTML = '';
            $('#floatAmount').value = '';
            return;
        }
        const открыта = new Date(смена.opened_at);
        $('#shiftTitle').textContent = `${t('shop_shift')} ${DateUtils.formatShort(открыта)}`;
        $('#shiftMeta').textContent = смена.status === 'open'
            ? `${t('shop_shift_opened_at')} ${DateUtils.formatTime(открыта)}`
            : `${t('shop_shift_closed_at')} ${DateUtils.formatTime(new Date(смена.closed_at))}`;
        $('#floatAmount').value = смена.status === 'open' ? Number(смена.float_amount) || 0 : '';

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
            ячейка(t('shop_ops_count'), проведённые.length),
            ячейка(t('shop_revenue_total'), деньги(товары + дары)),
            ячейка(t('shop_of_which_goods'), деньги(товары)),
            ячейка(t('shop_of_which_donations'), деньги(дары), 'text-secondary'),
            ...Object.entries(поВалютам).map(([в, с]) =>
                ячейка(`${t('shop_cash_in')} ${ЗНАК[в]}`, деньги(с, в))),
            ячейка(t('shop_float_word'), деньги(Number(смена.float_amount) || 0)),
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
                    ${ЗНАК[ж.currency_code]} · ${t('shop_must_be')}
                    <b class="nums">${деньги(ж.expected, ж.currency_code)}</b></span></div>
                <input type="number" class="input input-bordered input-sm nums" data-count="${ж.currency_code}"
                       value="${введено ? e(факт) : ''}" placeholder="${t('shop_counted_placeholder')}">
                ${разница === null ? ''
                  : разница === 0
                    ? `<span class="text-xs text-success mt-1">${t('shop_matches')}</span>`
                    : `<span class="text-xs text-error mt-1">${t('shop_discrepancy')} ${разница > 0 ? '+' : ''}${деньги(разница, ж.currency_code)}</span>
                       <input class="input input-bordered input-sm mt-1" data-why="${ж.currency_code}"
                              value="${e(причины[ж.currency_code] || '')}" placeholder="${t('shop_discrepancy_reason')}">`}
            </label>`;
        }).join('') || `<div class="text-sm opacity-60">${t('shop_count_hint_none')}</div>`;

        const всёВведено = ожидаем.every(ж => (пересчёт[ж.currency_code] ?? '') !== '');
        const объяснено = ожидаем.every(ж => {
            const факт = пересчёт[ж.currency_code];
            if (факт === undefined || факт === '') return false;
            return Number(факт) === Number(ж.expected) || (причины[ж.currency_code] || '').trim() !== '';
        });
        $('#closeShift').disabled = !ожидаем.length || !всёВведено || !объяснено;
        $('#closeNote').textContent = !ожидаем.length ? t('shop_nothing_to_close')
            : !всёВведено ? t('shop_count_first')
            : !объяснено ? t('shop_explain_first')
            : t('shop_ready_to_close');
    }

    // ---------- сдача ----------
    function рисоватьСдачу() {
        const тело = $('#handoverBody');

        if (пакет) {
            const итог = строкиПакета.map(л => {
                const р = Number(л.discrepancy) || 0;
                return `
                <tr><td data-label="${t('shop_currency')}">${ЗНАК[л.currency_code]}</td>
                    <td data-label="${t('shop_goods_line')}" class="text-right nums">${деньги(л.goods_amount, л.currency_code)}</td>
                    <td data-label="${t('shop_own_output')}" class="text-right nums">${деньги(л.murti_amount, л.currency_code)}</td>
                    <td data-label="${t('shop_donations_word')}" class="text-right nums">${деньги(л.donation_amount, л.currency_code)}</td>
                    <td data-label="${t('shop_cash_discrepancy')}" class="text-right nums ${р < 0 ? 'text-error' : р > 0 ? 'text-success' : 'opacity-50'}">
                        ${р === 0 ? '—' : (р > 0 ? '+' : '') + деньги(р, л.currency_code)}</td>
                </tr>`;
            }).join('');

            const выборСчетов = админФинансов() ? строкиПакета.map(л => `
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm">${
                        t('shop_where_to_credit')} ${ЗНАК[л.currency_code]}</span></div>
                    <select class="select select-bordered select-sm" data-account="${л.currency_code}">
                        ${счета.filter(с => с.currency_code === л.currency_code)
                            .map(с => `<option value="${с.id}">${e(с.name)}</option>`).join('')
                          || `<option value="">${t('shop_no_account_currency')}</option>`}
                    </select>
                </label>`).join('') : '';

            $('#handoverNote').textContent = t('shop_handover_pending');
            тело.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="table table-sm stack">
                        <thead><tr><th>${t('shop_currency')}</th><th class="text-right">${t('shop_goods_line')}</th>
                            <th class="text-right">${t('shop_own_output')}</th>
                            <th class="text-right">${t('shop_donations_word')}</th>
                            <th class="text-right">${t('shop_cash_discrepancy')}</th></tr></thead>
                        <tbody>${итог}</tbody>
                    </table>
                </div>
                ${админФинансов() ? `
                    <div class="grid gap-3 md:grid-cols-3">${выборСчетов}</div>
                    <div><button class="btn btn-sm" id="acceptHandover"
                        style="background: var(--current-color); color:#fff;">${t('shop_accept_revenue')}</button></div>`
                : `<div class="text-sm opacity-60">${t('shop_treasurer_note')}</div>`}`;
            return;
        }

        $('#handoverNote').textContent = естьЗакрытыеНесданные
            ? t('shop_handover_has_closed')
            : t('shop_handover_none');
        тело.innerHTML = естьЗакрытыеНесданные
            ? `<div><button class="btn btn-sm btn-outline" id="prepareHandover" data-permission="shop_settle">${
                   t('shop_prepare_handover')}</button></div>`
            : `<div class="text-sm opacity-60">${t('shop_handover_nothing')}</div>`;
    }

    // ---------- операции ----------
    function рисоватьОперации() {
        const последняяПроведённая = операции.find(о => о.status === 'posted');
        $('#opsTbl').tBodies[0].innerHTML = операции.map(о => {
            const позиции = (о.shop_sale_items || [])
                .map(п => `${Layout.getName(п.shop_items || {}) || t('shop_item')}${
                    Number(п.qty) > 1 ? ' ×' + Number(п.qty) : ''}`)
                .join(', ');
            const что = позиции || t('shop_donation');
            const сумма = Number(о.items_total) + Number(о.donation_amount) *
                (о.currency_code === 'INR' ? 1 : курсИз(о));
            const можноОтменить = о.status === 'posted' && о === последняяПроведённая && смена?.status === 'open';
            return `<tr class="${о.status === 'cancelled' ? 'opacity-50' : ''}">
                <td data-label="${t('shop_time')}" class="nums">${DateUtils.formatTime(new Date(о.sold_at))}</td>
                <td data-label="${t('shop_what')}">${e(что)}
                    ${Number(о.donation_amount) > 0 && позиции
                        ? `<span class="badge badge-sm badge-secondary">${t('shop_plus_donation')}</span>` : ''}
                    ${!позиции ? `<span class="badge badge-sm badge-secondary">${t('shop_donation_short')}</span>` : ''}
                    ${о.status === 'cancelled' ? `<span class="badge badge-sm">${t('shop_cancelled')}</span>` : ''}</td>
                <td data-label="${t('shop_amount_word')}" class="text-right nums">${деньги(сумма)}</td>
                <td data-label="${t('shop_payment')}">${о.currency_code === 'INR'
                    ? t('shop_cash_inr') : деньги(о.paid_amount, о.currency_code)}</td>
                <td data-label="">${можноОтменить
                    ? `<button class="btn btn-ghost btn-xs" data-cancel="${о.id}">${t('shop_undo')}</button>` : ''}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="5" class="text-center opacity-60 py-6">${t('shop_no_ops')}</td></tr>`;

        $('#opsCount').textContent = операции.length
            ? `${операции.filter(о => о.status === 'posted').length} ${t('shop_posted_count')}`
            : '';
    }

    function рисоватьИсторию() {
        $('#histTbl').tBodies[0].innerHTML = история.map(с => {
            const сдача = с.shop_handovers;
            const статус = с.status === 'open'
                ? `<span class="badge badge-sm badge-warning">${t('shop_status_open')}</span>`
                : !с.handover_id ? `<span class="badge badge-sm">${t('shop_status_not_handed')}</span>`
                : сдача?.status === 'accepted'
                    ? `<span class="badge badge-sm badge-success">${t('shop_status_accepted')} ${
                        DateUtils.formatShort(new Date(сдача.accepted_at))}</span>`
                    : `<span class="badge badge-sm badge-info">${t('shop_status_with_treasurer')}</span>`;
            const открыта = new Date(с.opened_at);
            return `<tr>
                <td data-label="${t('shop_shift')}" class="nums">${DateUtils.formatShort(открыта)}
                    <span class="opacity-60">${DateUtils.formatTime(открыта)}</span></td>
                <td data-label="${t('shop_closed_col')}" class="nums opacity-70">${с.closed_at
                    ? DateUtils.formatTime(new Date(с.closed_at)) : '—'}</td>
                <td data-label="${t('shop_float_word')}" class="text-right nums opacity-70">${деньги(с.float_amount)}</td>
                <td data-label="${t('shop_handover_col')}">${статус}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="4" class="text-center opacity-60 py-6">${t('shop_no_past_shifts')}</td></tr>`;
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

            if (b.id === 'openShift') {
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_open_shift',
                        { p_float: Number($('#floatAmount').value) || 0 });
                    if (error) return Layout.handleError(error, t('shop_err_open'));
                    Layout.showNotification(t('shop_shift_opened_msg'), 'success');
                    await перерисовать();
                });
            }

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
                        ? t('shop_confirm_close_diff').replace('%s', расхождения.join(', '))
                        : t('shop_confirm_close'))) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_close_shift',
                        { payload: { shift_id: смена.id, counts } });
                    if (error) return Layout.handleError(error, t('shop_err_close'));
                    Layout.showNotification(t('shop_shift_closed_msg'), 'success');
                    пересчёт = {}; причины = {};
                    await перерисовать();
                });
            }

            if (b.id === 'prepareHandover') {
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_prepare_handover', { p_note: null });
                    if (error) return Layout.handleError(error, t('shop_err_prepare'));
                    Layout.showNotification(t('shop_prepared_msg'), 'success');
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
                    return Layout.showNotification(`${t('shop_pick_account_for')} ${
                        безСчёта.map(л => ЗНАК[л.currency_code] || л.currency_code).join(', ')}`, 'warning');
                }
                const суммы = строкиПакета.map(л => деньги(
                    Number(л.goods_amount) + Number(л.murti_amount) + Number(л.donation_amount),
                    л.currency_code)).join(', ');
                if (!confirm(t('shop_confirm_accept').replace('%s', суммы))) return;
                return разово(b, async () => {
                    const { data, error } = await Layout.db.rpc('shop_accept_handover', {
                        payload: { handover_id: пакет.id, accounts },
                    });
                    if (error) return Layout.handleError(error, t('shop_err_accept'));
                    if (data && data.ok === false) {
                        return Layout.showNotification(data.error?.message || t('shop_fin_rejected'), 'error');
                    }
                    const итоги = (data?.итоги || []).map(и =>
                        `${деньги(и.выручка, и.валюта)}${Number(и.расхождение)
                            ? ` (${t('shop_discrepancy')} ${деньги(и.расхождение, и.валюта)})` : ''}`).join(', ');
                    Layout.showNotification(`${t('shop_accepted_msg')} ${
                        итоги || t('shop_revenue_posted')}`, 'success');
                    await перерисовать();
                });
            }

            if (b.dataset.cancel) {
                if (!confirm(t('shop_confirm_cancel_sale'))) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_cancel_sale', {
                        p_sale_id: b.dataset.cancel, p_reason: t('shop_cancel_reason_shift'),
                    });
                    if (error) return Layout.handleError(error, t('shop_err_cancel'));
                    Layout.showNotification(t('shop_sale_cancelled'), 'success');
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
                    ? t('shop_explain_first') : t('shop_ready_to_close');
            }
        });

        // прямая запись в смену закрыта — размен меняется функцией, она же проверяет права
        $('#floatAmount').addEventListener('change', async ev => {
            if (!смена || смена.status !== 'open') return;   // до открытия поле просто запоминает сумму
            const { error } = await Layout.db.rpc('shop_set_float', {
                p_shift: смена.id, p_amount: Number(ev.target.value) || 0,
            });
            if (error) return Layout.handleError(error, t('shop_err_float'));
            await перерисовать();
        });
    }

    async function init() {
        слушать();
        await перерисовать();
    }

    return { init };
})();
