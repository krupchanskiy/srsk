// ==================== ФИНАНСЫ: СВЕРКА ====================
// Наличные — пересчёт по точкам хранения и номиналам; безнал — выписка.
// Одна кнопка «Сохранить сверку» → единственный вызов fin_perform_reconciliation.
// opened_seq фиксируется при выборе счёта (защита от гонки на сервере).
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let denominations = {};      // { INR: [2000, 500, ...] }
let currentAccount = null;   // строка fin_v_account_balances
let openedSeq = 0;           // MAX(ledger_seq) на момент выбора счёта
let requestId = null;
let locationSeq = 0;
let streakCount = 0;   // сколько последних чекпоинтов подряд без расхождений (критерий запуска: 3, runbook §4)

// ==================== СЧЁТ ====================
async function loadDenominations() {
    const { data } = await Layout.db.from('fin_v_denominations').select('*');
    denominations = {};
    for (const d of data || []) {
        (denominations[d.currency_code] = denominations[d.currency_code] || []).push(Number(d.value));
    }
}

function buildAccountSelect() {
    document.getElementById('accountSelect').innerHTML =
        `<option value="">—</option>` +
        FinUtils.refs.accounts.filter(a => a.is_active)
            .map(a => `<option value="${a.account_id}">${e(a.name)}</option>`).join('');
}

async function selectAccount(accountId) {
    if (!accountId) {
        document.getElementById('reconBlock').classList.add('hidden');
        document.getElementById('reconEmpty').classList.remove('hidden');
        currentAccount = null;
        return;
    }
    document.getElementById('reconEmpty').classList.add('hidden');
    // свежие данные счёта (включая last_ledger_seq на момент открытия формы)
    const accounts = await FinUtils.reloadAccounts();
    currentAccount = accounts.find(a => a.account_id === accountId);
    if (!currentAccount) return;

    openedSeq = Number(currentAccount.last_ledger_seq || 0);
    requestId = FinUtils.newRequestId();

    const info = [];
    info.push(`${t('fin_system_balance')}: ${FinUtils.fmtMoney(currentAccount.balance, currentAccount.currency_code)}`);
    if (currentAccount.last_checkpoint_seq) {
        info.push(`${t('fin_last_checkpoint')}: №${currentAccount.last_checkpoint_seq}, ${DateUtils.formatShort(new Date(currentAccount.last_checkpoint_at))}`);
        info.push(`${currentAccount.unreconciled_count} ${t('fin_unreconciled_after')}`);
    } else {
        info.push(t('fin_no_checkpoint'));
    }
    document.getElementById('accountInfo').textContent = info.join(' · ');

    const isCash = currentAccount.reconciliation_mode === 'cash_count';
    document.getElementById('cashBlock').classList.toggle('hidden', !isCash);
    document.getElementById('statementBlock').classList.toggle('hidden', isCash);
    document.getElementById('reconBlock').classList.remove('hidden');
    document.getElementById('statementBalance').value = '';
    document.getElementById('adjustmentReason').value = '';

    if (isCash) {
        document.getElementById('locations').innerHTML = '';
        locationSeq = 0;
        // стандартные точки хранения (ТЗ 4.9); имена можно править в форме
        addLocation('На руках');
        addLocation('Сейф');
    }

    document.getElementById('systemBalance').textContent = FinUtils.fmtMoney(currentAccount.balance, currentAccount.currency_code);
    recalc();
    await loadHistory(accountId);
}

// ==================== ТОЧКИ ХРАНЕНИЯ ====================
function addLocation(name) {
    locationSeq++;
    const cur = currentAccount.currency_code;
    const denoms = denominations[cur] || [];
    const html = `
    <div class="border border-base-300 rounded-lg p-3 mb-3 recon-location" data-idx="${locationSeq}">
        <div class="flex items-center gap-3 mb-2">
            <input type="text" class="input input-bordered input-sm w-48 loc-name" value="${e(name || '')}" placeholder="${t('fin_recon_location')}">
            <span class="ml-auto font-mono loc-total">0</span>
            ${locationSeq > 1 ? `<button type="button" class="btn btn-ghost btn-xs text-error" aria-label="Удалить" onclick="this.closest('.recon-location').remove(); FinRecon.recalc()">${FinUtils.ICONS.x}</button>` : ''}
        </div>
        <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2">
            ${denoms.map(d => `
                <div class="form-control">
                    <label class="label py-0"><span class="label-text text-xs font-mono">${d} ×</span></label>
                    <input type="number" min="0" step="1" class="input input-bordered input-sm denom-qty" data-denom="${d}">
                </div>`).join('')}
        </div>
        <div class="flex gap-2 mt-2">
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_other_amount')}</span></label>
                <input type="number" min="0" step="0.01" class="input input-bordered input-sm w-36 other-amount">
            </div>
            <div class="form-control flex-1">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_other_comment')}</span></label>
                <input type="text" class="input input-bordered input-sm other-comment">
            </div>
        </div>
    </div>`;
    document.getElementById('locations').insertAdjacentHTML('beforeend', html);
}

// ==================== ПЕРЕСЧЁТ ====================
function countedTotal() {
    if (!currentAccount) return 0;
    if (currentAccount.reconciliation_mode === 'statement') {
        return Number(document.getElementById('statementBalance').value) || 0;
    }
    let total = 0;
    document.querySelectorAll('.recon-location').forEach(loc => {
        loc.querySelectorAll('.denom-qty').forEach(inp => {
            const qty = Number(inp.value) || 0;
            total += qty * Number(inp.dataset.denom);
        });
        total += Number(loc.querySelector('.other-amount').value) || 0;
        // итог точки
        let locTotal = 0;
        loc.querySelectorAll('.denom-qty').forEach(inp => locTotal += (Number(inp.value) || 0) * Number(inp.dataset.denom));
        locTotal += Number(loc.querySelector('.other-amount').value) || 0;
        loc.querySelector('.loc-total').textContent = locTotal.toLocaleString('ru-RU');
    });
    return total;
}

function recalc() {
    if (!currentAccount) return;
    const counted = countedTotal();
    const diff = Math.round((counted - Number(currentAccount.balance)) * 100) / 100;
    document.getElementById('countedBalance').textContent = FinUtils.fmtMoney(counted, currentAccount.currency_code);
    const diffEl = document.getElementById('differenceValue');
    diffEl.textContent = FinUtils.fmtMoney(diff, currentAccount.currency_code);
    diffEl.className = 'font-mono font-bold text-xl mt-0.5 ' + (diff === 0 ? 'text-success' : 'text-error');
    const tile = document.getElementById('differenceTile');
    if (tile) tile.className = 'rounded-xl border-2 p-3 ' + (diff === 0 ? 'border-success/40' : 'border-error/40');
    document.getElementById('mismatchBlock').classList.toggle('hidden', diff === 0);
}

// ==================== СОХРАНЕНИЕ ====================
function collectCounts() {
    const counts = [];
    document.querySelectorAll('.recon-location').forEach(loc => {
        const denomsObj = {};
        loc.querySelectorAll('.denom-qty').forEach(inp => {
            const qty = Number(inp.value) || 0;
            if (qty > 0) denomsObj[inp.dataset.denom] = qty;
        });
        const point = {
            location: loc.querySelector('.loc-name').value.trim(),
            denominations: denomsObj
        };
        const other = Number(loc.querySelector('.other-amount').value) || 0;
        if (other > 0) {
            point.other_amount = String(other);
            point.other_comment = loc.querySelector('.other-comment').value.trim() || null;
        }
        counts.push(point);
    });
    return counts;
}

async function save() {
    if (!currentAccount) return;
    const isCash = currentAccount.reconciliation_mode === 'cash_count';
    const hadMismatch = !document.getElementById('mismatchBlock').classList.contains('hidden');
    const accId = currentAccount.account_id;
    const payload = {
        request_id: requestId,
        account_id: accId,
        opened_seq: openedSeq,
        adjustment_reason: document.getElementById('adjustmentReason').value.trim() || null,
        counts: isCash ? collectCounts() : null,
        statement_balance: isCash ? null : (document.getElementById('statementBalance').value || null)
    };
    const res = await FinUtils.rpc('fin_perform_reconciliation', payload);
    if (FinUtils.handleResult(res)) {
        requestId = null;
        await selectAccount(accId);
        showSuccess(!hadMismatch);   // после перезагрузки истории
    } else if (res?.error?.code === 'reconciliation_stale') {
        // форма устарела — перезагружаем данные счёта и просим пересчитать
        await selectAccount(accId);
    }
}

// Peak-end момент: крупное «сверено ✓» + серия чекпоинтов без расхождений
function showSuccess(matched) {
    const box = document.getElementById('reconSuccess');
    const txt = document.getElementById('reconSuccessText');
    if (!box || !txt) return;
    const seq = currentAccount?.last_checkpoint_seq;
    let msg = matched
        ? `${t('fin_recon_saved_ok')} №${seq || ''}`
        : `${t('fin_recon_saved_adj')} №${seq || ''}`;
    if (streakCount > 0) {
        msg += ` · ${t('fin_recon_streak').replace('{n}', streakCount)}`;
    }
    txt.textContent = msg;
    box.classList.toggle('alert-success', matched);
    box.classList.toggle('alert-warning', !matched);
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    clearTimeout(showSuccess._t);
    showSuccess._t = setTimeout(() => box.classList.add('hidden'), 8000);
}

// ==================== ИСТОРИЯ ====================
async function loadHistory(accountId) {
    const { data } = await Layout.db.from('fin_v_reconciliations').select('*')
        .eq('account_id', accountId)
        .order('performed_at', { ascending: false })
        .limit(50);
    const body = document.getElementById('historyBody');
    // серия чекпоинтов подряд без расхождений (сверху вниз)
    streakCount = 0;
    for (const r of data || []) {
        if (Number(r.original_difference || 0) === 0) streakCount++; else break;
    }
    const streakEl = document.getElementById('reconStreak');
    if (streakEl) {
        if (streakCount > 0) {
            streakEl.textContent = t('fin_recon_streak').replace('{n}', streakCount);
            streakEl.classList.remove('hidden');
            streakEl.classList.toggle('badge-success', streakCount >= 3);
            streakEl.classList.toggle('badge-warning', streakCount < 3);
        } else {
            streakEl.classList.add('hidden');
        }
    }
    if (!data || !data.length) {
        body.innerHTML = `<tr><td colspan="6" class="text-center py-4 opacity-60">${t('fin_no_checkpoint')}</td></tr>`;
        return;
    }
    body.innerHTML = data.map(r => `
        <tr>
            <td class="whitespace-nowrap">${DateUtils.formatDateTime(new Date(r.performed_at))}</td>
            <td>${e(r.performed_by_name || '')}</td>
            <td class="font-mono">№${r.cutoff_ledger_seq}</td>
            <td class="text-right font-mono">${FinUtils.fmtMoney(r.counted_balance, currentAccount.currency_code)}</td>
            <td class="text-right font-mono ${r.original_difference ? 'text-error' : 'text-success'}">
                ${r.original_difference ? FinUtils.fmtMoney(r.original_difference, currentAccount.currency_code) : FinUtils.ICONS.check}
            </td>
            <td class="opacity-70">${e(r.comment || '')}</td>
        </tr>
    `).join('');
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_reconciliation', itemId: 'fin_reconciliation' });
    await Promise.all([FinUtils.loadRefs(), loadDenominations()]);
    buildAccountSelect();

    document.getElementById('accountSelect').addEventListener('change', ev => selectAccount(ev.target.value));
    const locs = document.getElementById('locations');
    locs.addEventListener('input', recalc);
    document.getElementById('statementBalance').addEventListener('input', recalc);

    // Клавиатурный поток пересчёта: значение выделяется при фокусе, Enter → следующее поле
    locs.addEventListener('focusin', ev => {
        if (ev.target.matches('input[type="number"]')) ev.target.select();
    });
    locs.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' || !ev.target.matches('input')) return;
        ev.preventDefault();
        const inputs = [...locs.querySelectorAll('input')];
        const i = inputs.indexOf(ev.target);
        if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus();
        else document.getElementById('saveBtn')?.focus();
    });

    // Deep-link ?account= — вход в ритуал одним кликом с главной/счетов
    const preset = new URLSearchParams(location.search).get('account');
    if (preset) {
        const sel = document.getElementById('accountSelect');
        if ([...sel.options].some(o => o.value === preset)) {
            sel.value = preset;
            await selectAccount(preset);
            const first = document.querySelector('#cashBlock:not(.hidden) .denom-qty, #statementBlock:not(.hidden) #statementBalance');
            first?.focus();
        }
    }
}

window.FinRecon = { addLocation: () => { addLocation(''); recalc(); }, recalc, save };
init();
})();
