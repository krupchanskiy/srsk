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
    // размен (мигр. 783): сколько казначей выдал и ещё никто не принял, последний акт приёма
    let ждётРазмен = 0, последнийАкт = null, отказРазмена = false;
    // несданные закрытые смены с их пересчётом и последний возврат пакета казначеем (мигр. 784)
    let несданные = [], возврат = null, выручкаСмен = {};

    const $ = s => document.querySelector(s);
    // новый перевод мог ещё не попасть в закэшированный словарь — тогда русский текст, а не ключ
    const тр = (ключ, ru) => { const v = t(ключ); return v === ключ ? ru : v; };
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

        const [{ data: ждёт }, { data: акты }] = await Promise.all([
            Layout.db.rpc('shop_float_pending'),
            Layout.db.from('shop_float_receipts').select('issued, counted, accepted, reason, created_at')
                .order('created_at', { ascending: false }).limit(1),
        ]);
        ждётРазмен = Number(ждёт) || 0;
        последнийАкт = акты?.[0] || null;

        const { data: пакеты, error: ошПакета } = await Layout.db.from('shop_handovers')
            .select('id, created_at, status, accepted_at, float_amount, shop_handover_lines(currency_code, goods_amount, murti_amount, donation_amount, discrepancy)')
            .eq('status', 'pending').order('created_at', { ascending: false }).limit(1);
        if (ShopUtils.ошибка({ error: ошПакета }, t('shop_err_handover_pkg'))) return false;
        пакет = пакеты?.[0] || null;
        строкиПакета = пакет?.shop_handover_lines || [];

        const [{ data: закрытые }, { data: последнийПакет }] = await Promise.all([
            Layout.db.from('shop_shifts')
                .select('id, opened_at, closed_at, shop_cash_counts(currency_code, expected, actual, reason)')
                .eq('status', 'closed').is('handover_id', null).order('opened_at'),
            Layout.db.from('shop_handovers').select('status, return_reason, returned_at')
                .order('created_at', { ascending: false }).limit(1),
        ]);
        несданные = закрытые || [];
        естьЗакрытыеНесданные = несданные.length > 0;
        // пакет, снятый потому, что продавец сам открыл смену снова (мигр. 801), — не возврат казначея
        возврат = последнийПакет?.[0]?.status === 'returned'
            && последнийПакет[0].return_reason !== 'Продавец открыл смену снова' ? последнийПакет[0] : null;

        if (админФинансов()) {
            // напрямую fin_accounts закрыта даже для казначея — финмодуль отдаёт счета своим представлением
            const { data: сч } = await Layout.db.from('fin_v_account_balances')
                .select('account_id, name, currency_code, kind, is_active')
                .eq('is_active', true).eq('kind', 'real').eq('group_name', 'Касса').order('name');
            счета = (сч || []).map(с => ({ id: с.account_id, name: с.name, currency_code: с.currency_code }));
        }

        // история нужна, чтобы спорный день можно было поднять через неделю:
        // экран «последней смены» показывает только сегодня
        const { data: прошлые } = await Layout.db.from('shop_shifts')
            .select('id, opened_at, closed_at, status, float_amount, handover_id, shop_handovers(status, accepted_at), shop_cash_counts(currency_code, actual)')
            .order('opened_at', { ascending: false }).limit(11);
        история = (прошлые || []).filter(с => с.id !== смена?.id).slice(0, 10);
        // выручка смены по валютам: чеки минус выданная рупиями сдача за валюту
        выручкаСмен = {};
        if (история.length) {
            const { data: чеки } = await Layout.db.from('shop_sales')
                .select('shift_id, currency_code, paid_amount, change_inr')
                .in('shift_id', история.map(с => с.id)).eq('status', 'posted');
            (чеки || []).forEach(ч => {
                const в = выручкаСмен[ч.shift_id] ||= {};
                в[ч.currency_code] = (в[ч.currency_code] || 0) + Number(ч.paid_amount);
                if (Number(ч.change_inr)) в.INR = (в.INR || 0) - Number(ч.change_inr);
            });
        }

        return true;
    }

    // ---------- шапка ----------
    function рисоватьШапку() {
        // смена открывается и сама, с первым чеком, но тогда размен в ней нулевой:
        // утром его кладут в ящик заранее и хотят записать до первой продажи
        const нужноОткрыть = !смена || смена.status !== 'open';
        $('#openShift').hidden = !нужноОткрыть;
        // пока казначей не принял выручку, последнюю смену можно открыть снова и поправить
        $('#reopenShift').hidden = !(смена?.status === 'closed'
            && (!смена.handover_id || смена.handover_id === пакет?.id));
        $('#reopenShift').textContent = тр('shop_reopen_shift', 'Открыть смену снова');

        if (!смена) {
            $('#shiftTitle').textContent = t('shop_shift_none');
            $('#shiftMeta').textContent = t('shop_shift_open_hint');
            $('#shiftStats').innerHTML = '';
            return;
        }
        const открыта = new Date(смена.opened_at);
        $('#shiftTitle').textContent = `${t('shop_shift')} ${DateUtils.formatShort(открыта)}`;
        $('#shiftMeta').textContent = смена.status === 'open'
            ? `${t('shop_shift_opened_at')} ${DateUtils.formatTime(открыта)}`
            : `${t('shop_shift_closed_at')} ${DateUtils.formatTime(new Date(смена.closed_at))}`;

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
                <input type="text" inputmode="decimal" autocomplete="off" class="input input-bordered input-sm nums" data-count="${ж.currency_code}" data-cash-calc="${ж.currency_code}"
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

    // ---------- размен ----------
    // Размен выдаёт только казначей (перевод на подотчёт Магазина); кассир, открывающий
    // смену, подтверждает «Принял» — это акт приёма. «Не сходится» уходит казначею в ДДС.
    function рисоватьРазмен() {
        const тело = $('#floatBody');
        const вЯщике = смена?.status === 'open' ? Number(смена.float_amount) || 0 : 0;
        const продавец = window.hasPermission?.('shop_sell');
        const части = [];

        if (ждётРазмен > 0) {
            const сообщил = последнийАкт && !последнийАкт.accepted
                && Number(последнийАкт.issued) === ждётРазмен;
            $('#floatNote').textContent = `${тр('shop_float_issued', 'Казначей выдал на сдачу')} ${деньги(ждётРазмен)}`;
            части.push(`<div class="alert ${сообщил ? 'alert-error' : 'alert-warning'} text-sm">
                <span>${сообщил
                    ? `Вы сообщили казначею: насчитали ${деньги(последнийАкт.counted)} — ${e(последнийАкт.reason)}. Ждём, пока он исправит.`
                    : `${тр('shop_float_issued', 'Казначей выдал на сдачу')} <b class="nums">${деньги(ждётРазмен)}</b>. ${тр('shop_float_recount', 'Пересчитайте и подтвердите.')}`}</span></div>`);
            if (продавец) {
                части.push(`<div class="flex flex-wrap gap-2">
                    <button class="btn btn-sm" id="floatOk" style="background: var(--current-color); color:#fff;">
                        ${тр('shop_float_got', 'Принял')} ${деньги(ждётРазмен)}</button>
                    <button class="btn btn-sm btn-outline btn-error" id="floatBad">${тр('shop_float_mismatch', 'Не сходится')}</button>
                </div>
                <div class="grid gap-2 md:grid-cols-[10rem_1fr_auto] items-end ${отказРазмена ? '' : 'hidden'}" id="floatBadForm">
                    <label class="form-control"><div class="label py-1"><span class="label-text text-sm">${
                        тр('shop_float_counted', 'Сколько насчитали, ₹')}</span></div>
                        <input type="text" inputmode="decimal" autocomplete="off" class="input input-bordered input-sm nums" id="floatCounted"></label>
                    <label class="form-control"><div class="label py-1"><span class="label-text text-sm">${
                        тр('shop_float_what_wrong', 'Что не так')}</span></div>
                        <input class="input input-bordered input-sm" id="floatReason"></label>
                    <button class="btn btn-sm btn-error" id="floatSend">${тр('shop_float_send', 'Отправить казначею')}</button>
                </div>`);
            }
        } else {
            $('#floatNote').textContent = вЯщике
                ? `${тр('shop_float_in_drawer', 'В ящике размена')} ${деньги(вЯщике)}`
                : тр('shop_float_none', 'Размен не выдан');
            if (вЯщике) части.push(`<div class="text-sm opacity-70">${тр('shop_float_in_drawer', 'В ящике размена')}
                <b class="nums">${деньги(вЯщике)}</b> — вечером сдаётся вместе с выручкой.</div>`);
        }

        // казначей выдаёт размен прямо отсюда: перевод из кассы на подотчёт Магазина
        if (админФинансов()) {
            const кассыР = счета.filter(с => с.currency_code === 'INR');
            части.push(`<div class="border-t border-base-200 pt-3 grid gap-2 md:grid-cols-[10rem_1fr_auto] items-end">
                <label class="form-control"><div class="label py-1"><span class="label-text text-sm">${
                    тр('shop_float_issue', 'Выдать на сдачу')}, ₹</span></div>
                    <input type="text" inputmode="decimal" autocomplete="off" class="input input-bordered input-sm nums" id="floatIssueAmount" data-cash-calc="INR"></label>
                <label class="form-control"><div class="label py-1"><span class="label-text text-sm">Из кассы</span></div>
                    <select class="select select-bordered select-sm" id="floatIssueAccount">${
                        кассыР.map(с => `<option value="${с.id}">${e(с.name)}</option>`).join('')}</select></label>
                <button class="btn btn-sm btn-outline" id="floatIssue">${тр('shop_float_issue', 'Выдать на сдачу')}</button>
            </div>`);
        }

        $('#floatCard').hidden = !части.length;
        тело.innerHTML = части.join('');
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

            const размен = Number(пакет.float_amount) || 0;
            // размен возвращается в кассу ₹ — выбор нужен, даже если рупиевой выручки нет
            const валютыПакета = [...new Set([...строкиПакета.map(л => л.currency_code), ...(размен > 0 ? ['INR'] : [])])]
                .map(currency_code => ({ currency_code }));
            const выборСчетов = админФинансов() ? валютыПакета.map(л => `
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm">${
                        t('shop_where_to_credit')} ${ЗНАК[л.currency_code]}</span></div>
                    <select class="select select-bordered select-sm" data-account="${л.currency_code}">
                        ${счета.filter(с => с.currency_code === л.currency_code)
                            .map(с => `<option value="${с.id}">${e(с.name)}</option>`).join('')
                          || `<option value="">${t('shop_no_account_currency')}</option>`}
                    </select>
                </label>`).join('') : '';

            // итог — крупно над слагаемыми, по валютам: рупии с долларами не складываем
            const итогиВалют = {};
            строкиПакета.forEach(л => {
                итогиВалют[л.currency_code] = (итогиВалют[л.currency_code] || 0)
                    + Number(л.goods_amount) + Number(л.murti_amount) + Number(л.donation_amount)
                    + (Number(л.discrepancy) || 0);
            });
            if (размен > 0) итогиВалют.INR = (итогиВалют.INR || 0) + размен;
            const итогСтрокой = Object.entries(итогиВалют).map(([в, с]) => деньги(с, в)).join(' · ') || деньги(0);

            $('#handoverNote').textContent = тр('shop_handover_accepting', 'Казначей принимает выручку');
            тело.innerHTML = `
                <div>
                    <div class="text-xs opacity-60 font-semibold uppercase tracking-wide">Итого принять в кассу</div>
                    <div class="text-3xl font-bold nums">${итогСтрокой}</div>
                    <div class="text-xs opacity-60 mt-1">Из чего сложилось — ниже${размен > 0 ? ', вместе с разменом' : ''}</div>
                </div>
                <div class="overflow-x-auto" tabindex="0">
                    <table class="table table-sm stack">
                        <thead><tr><th>${t('shop_currency')}</th><th class="text-right">${t('shop_goods_line')}</th>
                            <th class="text-right">${t('shop_own_output')}</th>
                            <th class="text-right">${t('shop_donations_word')}</th>
                            <th class="text-right">${t('shop_cash_discrepancy')}</th></tr></thead>
                        <tbody>${итог}</tbody>
                    </table>
                </div>
                ${размен > 0 ? `<div class="text-sm">${тр('shop_float_returns', 'Размен вернётся в кассу')}:
                    <b class="nums">${деньги(размен)}</b></div>` : ''}
                ${админФинансов() ? `
                    <div class="grid gap-3 md:grid-cols-3">${Object.entries(итогиВалют).map(([в, с]) => `
                        <label class="form-control">
                            <div class="label py-1"><span class="label-text text-sm">${тр('shop_take_counted', 'Пересчитал')}, ${ЗНАК[в] || в}</span></div>
                            <input type="text" inputmode="decimal" autocomplete="off" class="input input-bordered input-sm nums"
                                   data-take-check="${в}" data-expected="${с}" data-cash-calc="${в}" placeholder="${деньги(с, в)}">
                            <span data-take-diff="${в}"></span>
                        </label>`).join('')}</div>
                    <div class="grid gap-3 md:grid-cols-3">${выборСчетов}</div>
                    <div class="flex flex-wrap gap-2">
                        <button class="btn btn-sm btn-success" id="acceptHandover">${t('shop_accept_revenue')}</button>
                        <button class="btn btn-sm btn-outline btn-error" id="returnHandover">Вернуть продавцу</button>
                    </div>`
                : `<div class="text-sm opacity-60">${t('shop_treasurer_note')}</div>`}`;
            return;
        }

        $('#handoverNote').textContent = естьЗакрытыеНесданные
            ? тр('shop_handover_waiting', 'Закрытые смены ждут казначея')
            : t('shop_handover_none');
        if (!естьЗакрытыеНесданные) {
            тело.innerHTML = `<div class="text-sm opacity-60">${t('shop_handover_nothing')}</div>`;
            return;
        }
        const продавец = window.hasPermission?.('shop_sell');
        // пересчёт закрытой несданной смены можно поправить до сдачи — каждая правка в журнал
        const сменыСПересчётом = несданные.filter(с => (с.shop_cash_counts || []).length).map(с => `
            <div class="border border-base-200 rounded-lg p-3" data-recount-shift="${с.id}">
                <div class="text-sm font-semibold mb-2">${t('shop_shift')} ${DateUtils.formatShort(new Date(с.opened_at))}
                    <span class="opacity-60 font-normal">· закрыта ${DateUtils.formatTime(new Date(с.closed_at))}</span></div>
                <div class="grid gap-3 md:grid-cols-3">${с.shop_cash_counts.map(к => `
                    <label class="form-control">
                        <div class="label py-1"><span class="label-text text-sm">${ЗНАК[к.currency_code] || к.currency_code} · ${t('shop_must_be')}
                            <b class="nums">${деньги(к.expected, к.currency_code)}</b></span></div>
                        <input type="text" inputmode="decimal" autocomplete="off" class="input input-bordered input-sm nums"
                               data-recount="${к.currency_code}" data-cash-calc="${к.currency_code}" value="${e(к.actual)}" ${продавец ? '' : 'disabled'}>
                        <input class="input input-bordered input-sm mt-1" data-recount-why="${к.currency_code}"
                               value="${e(к.reason || '')}" placeholder="${t('shop_discrepancy_reason')}" ${продавец ? '' : 'disabled'}>
                    </label>`).join('')}</div>
                ${продавец ? `<button class="btn btn-xs btn-outline mt-2" data-recount-save="${с.id}">Сохранить пересчёт</button>` : ''}
            </div>`).join('');
        тело.innerHTML = `
            ${возврат ? `<div class="alert alert-error text-sm"><span>Казначей вернул пакет${
                возврат.returned_at ? ' ' + DateUtils.formatShort(new Date(возврат.returned_at)) : ''}: <b>${
                e(возврат.return_reason)}</b>. Исправьте пересчёт и сдайте заново.</span></div>` : ''}
            ${сменыСПересчётом}
            ${админФинансов()
                ? `<div><button class="btn btn-sm btn-success" id="prepareHandover">${тр('shop_take_revenue', 'Принять выручку')}</button></div>`
                : `<div class="text-sm opacity-60">${тр('shop_handover_seller_note',
                    'Отдайте деньги казначею — он примет их здесь же. Пока не принял, пересчёт можно поправить.')}</div>`}`;
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

    // суммы по валютам одной строкой: рупии с долларами не складываем
    const поВалютам = суммы => {
        const ст = Object.entries(суммы || {}).filter(([, с]) => с);
        return ст.length ? ст.map(([в, с]) => деньги(с, в)).join(' · ') : '<span class="opacity-40">—</span>';
    };

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
                <td data-label="Выручка" class="text-right nums">${поВалютам(выручкаСмен[с.id])}</td>
                <td data-label="${t('shop_float_word')}" class="text-right nums opacity-70">${деньги(с.float_amount)}</td>
                <td data-label="Сдано" class="text-right nums font-semibold">${поВалютам(Object.fromEntries(
                    (с.shop_cash_counts || []).map(к => [к.currency_code, Number(к.actual)])))}</td>
                <td data-label="${t('shop_handover_col')}">${статус}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="6" class="text-center opacity-60 py-6">${t('shop_no_past_shifts')}</td></tr>`;
    }

    async function перерисовать() {
        if (!await загрузить()) return;
        рисоватьШапку(); рисоватьРазмен(); рисоватьПересчёт(); рисоватьСдачу(); рисоватьОперации(); рисоватьИсторию();
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

            if (b.id === 'reopenShift') {
                if (!confirm(тр('shop_reopen_confirm',
                    'Открыть смену снова? Можно будет поправить чеки и пересчёт, потом закрыть заново.'))) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_reopen_shift', { p_shift: смена.id });
                    if (error) return Layout.handleError(error, тр('shop_reopen_shift', 'Открыть смену снова'));
                    Layout.showNotification(тр('shop_reopened_msg', 'Смена снова открыта'), 'success');
                    пересчёт = {}; причины = {};
                    await перерисовать();
                });
            }

            if (b.id === 'openShift') {
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_open_shift', { p_float: 0 });
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
                    Layout.showNotification(тр('shop_take_revenue_msg', 'Проверьте суммы и выберите кассу'), 'success');
                    await перерисовать();
                });
            }

            if (b.id === 'acceptHandover') {
                const accounts = {};
                document.querySelectorAll('[data-account]').forEach(s => {
                    if (s.value) accounts[s.dataset.account] = s.value;
                });
                const размен = Number(пакет.float_amount) || 0;
                const нужныВалюты = [...new Set([...строкиПакета.map(л => л.currency_code), ...(размен > 0 ? ['INR'] : [])])];
                const безСчёта = нужныВалюты.filter(в => !accounts[в]);
                if (безСчёта.length) {
                    return Layout.showNotification(`${t('shop_pick_account_for')} ${
                        безСчёта.map(в => ЗНАК[в] || в).join(', ')}`, 'warning');
                }
                const суммы = строкиПакета.map(л => деньги(
                    Number(л.goods_amount) + Number(л.murti_amount) + Number(л.donation_amount),
                    л.currency_code)).join(', ')
                    + (размен > 0 ? `; ${тр('shop_float_returns', 'Размен вернётся в кассу')} ${деньги(размен)}` : '');
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

            if (b.id === 'returnHandover') {
                const причина = prompt('Что не так? Продавец увидит это и исправит пересчёт');
                if (!причина || !причина.trim()) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_return_handover',
                        { p_handover: пакет.id, p_reason: причина.trim() });
                    if (error) return Layout.handleError(error, 'Возврат пакета');
                    Layout.showNotification('Пакет возвращён продавцу — в учёт ничего не попало', 'success');
                    await перерисовать();
                });
            }
            if (b.dataset.recountSave) {
                const блок = b.closest('[data-recount-shift]');
                const counts = [...блок.querySelectorAll('[data-recount]')].map(i => ({
                    currency_code: i.dataset.recount,
                    actual: parseFloat(i.value.replace(',', '.').replace(/[^\d.]/g, '')),
                    reason: блок.querySelector(`[data-recount-why="${i.dataset.recount}"]`).value.trim() || null,
                }));
                if (counts.some(c => !(c.actual >= 0))) return Layout.showNotification('Укажите, сколько насчитали', 'warning');
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_recount_shift',
                        { payload: { shift_id: b.dataset.recountSave, counts } });
                    if (error) return Layout.handleError(error, 'Исправление пересчёта');
                    Layout.showNotification('Пересчёт исправлен', 'success');
                    await перерисовать();
                });
            }
            if (b.id === 'floatOk') {
                if (!confirm(`${тр('shop_float_got', 'Принял')} ${деньги(ждётРазмен)}?`)) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_receive_float', { p_ok: true });
                    if (error) return Layout.handleError(error, 'Приём размена');
                    Layout.showNotification(`${тр('shop_float_got', 'Принял')} ${деньги(ждётРазмен)}`, 'success');
                    отказРазмена = false;
                    await перерисовать();
                });
            }
            if (b.id === 'floatBad') { отказРазмена = !отказРазмена; return рисоватьРазмен(); }
            if (b.id === 'floatSend') {
                const насчитали = parseFloat(($('#floatCounted').value || '').replace(',', '.').replace(/[^\d.]/g, ''));
                const причина = $('#floatReason').value.trim();
                if (!(насчитали >= 0) || !причина) {
                    return Layout.showNotification('Укажите, сколько насчитали, и что не так', 'warning');
                }
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_receive_float',
                        { p_ok: false, p_counted: насчитали, p_reason: причина });
                    if (error) return Layout.handleError(error, 'Размен не сходится');
                    Layout.showNotification('Казначей увидит это в ДДС', 'success');
                    отказРазмена = false;
                    await перерисовать();
                });
            }
            if (b.id === 'floatIssue') {
                const сумма = parseFloat(($('#floatIssueAmount').value || '').replace(',', '.').replace(/[^\d.]/g, ''));
                const касса = $('#floatIssueAccount').value;
                if (!(сумма > 0) || !касса) return Layout.showNotification('Укажите сумму и кассу', 'warning');
                if (!confirm(`${тр('shop_float_issue', 'Выдать на сдачу')} ${деньги(сумма)}?`)) return;
                return разово(b, async () => {
                    const { error } = await Layout.db.rpc('shop_issue_float', { p_amount: сумма, p_account: касса });
                    if (error) return Layout.handleError(error, 'Выдача размена');
                    Layout.showNotification(`${тр('shop_float_issue', 'Выдать на сдачу')}: ${деньги(сумма)} — ждёт «Принял» кассира`, 'success');
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
            // казначей пересчитывает принятые деньги: только подсказка, нигде не хранится
            if (el.dataset.takeCheck !== undefined) {
                const ждём = Number(el.dataset.expected) || 0;
                const есть = Number(el.value.replace(',', '.').replace(/[^\d.]/g, ''));
                const метка = document.querySelector(`[data-take-diff="${el.dataset.takeCheck}"]`);
                if (!метка) return;
                const р = Math.round((есть - ждём) * 100) / 100;
                метка.className = `text-xs mt-1 ${el.value === '' ? '' : р === 0 ? 'text-success' : 'text-error'}`;
                метка.textContent = el.value === '' ? ''
                    : р === 0 ? t('shop_matches')
                    : `${t('shop_discrepancy')} ${р > 0 ? '+' : ''}${деньги(р, el.dataset.takeCheck)} — пусть продавец поправит пересчёт`;
                return;
            }
            if (el.dataset.count !== undefined) {
                // поле текстовое: у type=number браузер не отдаёт позицию курсора, и после
                // перерисовки цифры вставали в начало — сумма набиралась задом наперёд
                пересчёт[el.dataset.count] = el.value.replace(',', '.').replace(/[^\d.]/g, '');
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

    }

    async function init() {
        слушать();
        await перерисовать();
    }

    return { init };
})();
