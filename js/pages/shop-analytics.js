/**
 * Аналитика магазина.
 *
 * Себестоимость считается по-разному для чужого и своего, и это не придирка:
 * за чужой товар мы должны владельцу ровно цену расчёта, а у мурти цены единицы
 * не существует — смолу и краску покупают впрок, роспись оплачивают людям.
 * Поэтому мастерская считается в среднем: всё потраченное на проекте делится
 * на всё с него выпущенное. Блок «Мастерская» показывает эту кухню целиком,
 * вместе с деньгами периода — чтобы было видно, когда закупались.
 *
 * Остаток показан двумя строками. Чужой товар лежит на полке, но нам не
 * принадлежит: его стоимость — это будущее обязательство, а не наш актив.
 */
const ShopAnalytics = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const t = key => Layout.t(key);
    const { деньги, штук } = ShopUtils;
    const шт = n => штук(n) + ' ' + t('shop_pcs_short');
    const $ = s => document.querySelector(s);

    let отчёт = null;

    async function загрузить() {
        const { data, error } = await Layout.db.rpc('shop_report', {
            p_from: $('#from').value, p_to: $('#to').value,
        });
        if (error) { Layout.handleError(error, t('shop_err_report')); return false; }
        отчёт = data;
        return true;
    }

    function плитка(ключ, значение, подпись = '', цвет = '') {
        return `<div class="tile">
            <div class="k">${e(ключ)}</div>
            <div class="v nums ${цвет}">${значение}</div>
            ${подпись ? `<div class="s">${e(подпись)}</div>` : ''}
        </div>`;
    }

    function рисовать() {
        if (!отчёт) return;
        const о = отчёт;
        const м = о.мурти || {};
        const прибыль = Number(о.валовая_прибыль) || 0;
        const оборот = Number(о.перепродажа) + Number(о.свой_выпуск);
        const маржа = оборот > 0 ? Math.round(прибыль / оборот * 100) : 0;

        $('#tiles').innerHTML =
            плитка(t('shop_revenue'), деньги(о.выручка_товары),
                   t('shop_receipts_avg').replace('%s', о.чеков).replace('%s', деньги(о.средний_чек))) +
            плитка(t('shop_resale'), деньги(о.перепродажа), t('shop_foreign_goods')) +
            плитка(t('shop_own_output'), деньги(о.свой_выпуск),
                   t('shop_murti_pcs').replace('%s', штук(м.продано_штук))) +
            плитка(t('shop_cost'), деньги(Number(о.себестоимость) + Number(о.себестоимость_своего)),
                   t('shop_cost_split').replace('%s', деньги(о.себестоимость))
                                       .replace('%s', деньги(о.себестоимость_своего))) +
            плитка(t('shop_gross_profit'), деньги(прибыль),
                   t('shop_margin_of_turnover').replace('%s', маржа),
                   прибыль >= 0 ? 'text-success' : 'text-error') +
            плитка(t('shop_donations_word'), деньги(о.пожертвования), t('shop_included_in_revenue')) +
            плитка(t('shop_own_on_shelf'), шт(о.остаток.своё_штук), t('shop_no_unit_cost')) +
            плитка(t('shop_foreign_on_shelf'), шт(о.остаток.чужое_штук),
                   t('shop_liability_of').replace('%s', деньги(о.остаток.чужое_обязательства))) +
            (Number(о.остаток.недостача) ? плитка(t('shop_shortage'),
                   шт(о.остаток.недостача), t('shop_sold_more'), 'text-error') : '') +
            (Number(о.возвращено) ? плитка(t('shop_refunded_to_buyers'),
                   деньги(о.возвращено), t('shop_for_period')) : '');

        const топ = о.топ || [];
        const максимум = топ.reduce((m, т) => Math.max(m, Number(т.amount)), 0) || 1;
        $('#topTbl').tBodies[0].innerHTML = топ.map(т => `
            <tr>
                <td data-label="">
                    <div class="font-semibold">${e(Layout.getName(т))}
                        ${т.source === 'own' ? `<span class="badge badge-sm badge-secondary">${t('shop_ours')}</span>` : ''}</div>
                    <div class="bar mt-1" style="width: ${Math.max(4, Math.round(Number(т.amount) / максимум * 100))}%"></div>
                </td>
                <td data-label="${t('shop_pcs_col')}" class="text-right nums">${штук(т.qty)}</td>
                <td data-label="${t('shop_revenue')}" class="text-right nums font-semibold">${деньги(т.amount)}</td>
                <td data-label="${t('shop_profit_col')}" class="text-right nums ${т.source === 'own' ? 'opacity-40' : ''}">
                    ${т.source === 'own' ? t('shop_in_project') : деньги(т.margin)}</td>
            </tr>`).join('') ||
            `<tr><td colspan="4" class="text-center opacity-60 py-6">${t('shop_nothing_sold')}</td></tr>`;

        рисоватьМастерскую(м);

        const цели = о.цели || [];
        $('#goalsCard').hidden = !цели.length;
        $('#goalsTbl').tBodies[0].innerHTML = цели.map(ц => `
            <tr>
                <td data-label="">${e(Layout.getName(ц))}</td>
                <td data-label="${t('shop_collected')}" class="text-right nums font-semibold">${деньги(ц.amount)}</td>
            </tr>`).join('');

        const лежит = о.лежалое || [];
        $('#deadTbl').tBodies[0].innerHTML = лежит.map(т => `
            <tr>
                <td data-label="">${e(Layout.getName(т))}</td>
                <td data-label="${t('shop_stock_col')}" class="text-right nums">${штук(т.qty)}</td>
                <td data-label="${t('shop_lying')}" class="text-right nums">${т.days} ${t('shop_days_short')}</td>
            </tr>`).join('') ||
            `<tr><td colspan="3" class="text-center opacity-60 py-6">${t('shop_nothing_stale')}</td></tr>`;
    }

    function рисоватьМастерскую(м) {
        const выпущено = Number(м.выпущено_всего) || 0;
        const заШтуку = Number(м.за_штуку) || 0;

        $('#murtiNote').textContent = !выпущено
            ? t('shop_no_output_yet')
            : !Number(м.расход_всего)
                ? t('shop_no_workshop_costs')
                : t('shop_avg_basis').replace('%s', деньги(м.расход_всего)).replace('%s', штук(выпущено));

        $('#murtiTiles').innerHTML =
            плитка(t('shop_cost_per_piece'), деньги(заШтуку), t('shop_calculated_avg')) +
            плитка(t('shop_sold'), шт(м.продано_штук), t('shop_sold_for').replace('%s', деньги(м.выручка))) +
            плитка(t('shop_murti_profit'), деньги(м.прибыль),
                   t('shop_cost_of_sold').replace('%s', деньги(м.себестоимость_проданного)),
                   Number(м.прибыль) >= 0 ? 'text-success' : 'text-error') +
            плитка(t('shop_spent_in_period'), деньги(м.расход_период), t('shop_materials')) +
            плитка(t('shop_produced_in_period'), шт(м.выпущено_период),
                   t('shop_total_pcs').replace('%s', штук(выпущено))) +
            плитка(t('shop_stock_col'), шт(м.на_полке),
                   t('shop_at_cost').replace('%s', деньги(Number(м.на_полке) * заШтуку))) +
            плитка(t('shop_project_cash'), деньги(м.касса_проекта),
                   t('shop_project_cash_hint'),
                   Number(м.касса_проекта) >= 0 ? 'text-success' : '');
    }

    // «день» — это сегодня, а не сутки назад: отчёт за смену смотрят каждый вечер
    function период(d) {
        const до = new Date();
        const от = new Date(Date.now() - d * 86400000);
        $('#to').value = DateUtils.toISO(до);
        $('#from').value = DateUtils.toISO(от);
        document.querySelectorAll('#periods button').forEach(b => {
            const свой = Number(b.dataset.days) === d;
            b.classList.toggle('btn-outline', !свой);
            b.style.cssText = свой ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';
        });
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const b = ev.target.closest('[data-days]');
            if (!b) return;
            период(Number(b.dataset.days));
            if (await загрузить()) рисовать();
        });
        ['#from', '#to'].forEach(сел => $(сел).addEventListener('change', async () => {
            if (await загрузить()) рисовать();
        }));
    }

    async function init() {
        слушать();
        период(30);
        if (await загрузить()) рисовать();
    }

    return { init };
})();
