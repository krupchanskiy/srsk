// ==================== ФИНАНСЫ: ГЛАВНАЯ ====================
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

// Суммы по валютам: {INR: 347000, USD: 1200}
function sumByCurrency(accounts) {
    const map = {};
    for (const a of accounts) {
        map[a.currency_code] = (map[a.currency_code] || 0) + Number(a.balance);
    }
    return map;
}

function renderCurrencyMap(map) {
    const entries = Object.entries(map).filter(([, v]) => v !== 0);
    if (!entries.length) return '<span class="opacity-50">—</span>';
    return entries.map(([code, total]) =>
        `<div class="text-lg font-semibold ${total < 0 ? 'text-error' : ''}">${FinUtils.fmtMoney(total, code)}</div>`
    ).join('');
}

async function loadDashboard() {
    await FinUtils.loadRefs();
    const accounts = FinUtils.refs.accounts.filter(a => a.is_active);

    if (!accounts.length) {
        document.getElementById('realBalances').innerHTML = `<span class="opacity-60">${t('fin_no_accounts_yet')}</span>`;
        document.getElementById('custodialBalances').textContent = '—';
        document.getElementById('totalBalances').textContent = '—';
    } else {
        const real = accounts.filter(a => a.kind === 'real');
        const custodialPositive = accounts.filter(a => a.kind === 'custodial' && Number(a.balance) > 0);
        const realMap = sumByCurrency(real);
        const custMap = sumByCurrency(custodialPositive);
        const totalMap = { ...realMap };
        for (const [code, v] of Object.entries(custMap)) totalMap[code] = (totalMap[code] || 0) + v;

        document.getElementById('realBalances').innerHTML = renderCurrencyMap(realMap);
        document.getElementById('custodialBalances').innerHTML = renderCurrencyMap(custMap);
        document.getElementById('totalBalances').innerHTML = renderCurrencyMap(totalMap);
    }

    // Минусы
    const negative = accounts.filter(a => a.is_negative);
    document.getElementById('negativeCount').textContent = negative.length;
    document.getElementById('negativeList').innerHTML = negative
        .map(a => `${e(a.name)}: ${FinUtils.fmtMoney(a.balance, a.currency_code)}`)
        .join('<br>');

    // Pending / disputed
    const { data: statusOps } = await Layout.db
        .from('fin_v_operations')
        .select('operation_id, approval')
        .in('approval', ['pending', 'disputed']);
    const pending = (statusOps || []).filter(o => o.approval === 'pending').length;
    const disputed = (statusOps || []).filter(o => o.approval === 'disputed').length;
    document.getElementById('pendingCount').textContent = pending;
    document.getElementById('disputedCount').textContent = disputed;

    // Последние операции
    const { data: ops } = await Layout.db
        .from('fin_v_operations')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

    const tbody = document.getElementById('recentOps');
    if (!ops || !ops.length) {
        tbody.innerHTML = `<tr><td class="text-center py-6 opacity-60">${t('fin_no_operations')}</td></tr>`;
        return;
    }
    // Строка кликабельна: ведёт в ДДС (клавиатура — тоже)
    tbody.innerHTML = ops.map(op => `
        <tr class="cursor-pointer hover:bg-base-200 ${op.is_reversed ? 'opacity-60' : ''}" data-op="${op.operation_id}" tabindex="0">
            <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(op.occurred_on))}</td>
            <td>${e(FinUtils.typeLabel(op.type))}
                ${op.is_reversed ? `<span class="badge badge-ghost badge-xs">${t('fin_reversed_badge')}</span>` : ''}
                ${op.has_post_close ? `<span class="badge badge-neutral badge-xs">${t('fin_post_close_badge')}</span>` : ''}
            </td>
            <td class="text-right font-mono whitespace-nowrap">${FinUtils.fmtAmountsByCurrencyColored(op.amounts_by_currency)}</td>
            <td>${FinUtils.approvalBadge(op.approval)}</td>
            <td class="max-w-xs truncate opacity-70">${e(op.comment || '')}</td>
        </tr>
    `).join('');
    const goDds = () => { window.location.href = 'dds.html'; };
    tbody.querySelectorAll('tr[data-op]').forEach(row => {
        row.addEventListener('click', goDds);
        row.addEventListener('keydown', ev => { if (ev.key === 'Enter') goDds(); });
    });
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_main', itemId: 'fin_main' });
    await loadDashboard();
}

init();
})();
