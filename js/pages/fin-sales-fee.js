// ==================== ФИНАНСЫ: ПРОЦЕНТ ОТДЕЛУ ПРОДАЖ ====================
// За каждого полноценного участника ретрита отдел продаж получает ставку (1 500 ₽).
// Полноценный — приехал и оплатил оргвзнос не меньше порога (80%) от полного взрослого
// оргвзноса в той же валюте. Считает база (fin_sales_fee_calc, миграция 623): живой
// расчёт без проводок. «Зафиксировать» проводит трату ретрита «Процент отделу продаж»
// на счёт «Отдел продаж (₽)» — это долг отделу; выдачи — обычные переводы на этот счёт.
// Список целиком, с суммами и процентами — чтобы у отдела продаж не было вопросов.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let retreats = [];
let currentRetreat = null;
let calc = null;
let isAdmin = false;

// «Оргвзнос не начислен» (0 из 0) не предупреждаем: это не приехавшие, дети, неснятые брони —
// решать там нечего (ВГ 03.10); в списке «Не засчитаны» они остаются
const FLAG_ORDER = ['problems', 'no_price', 'debt', 'discount_pass'];
const shownFlags = r => (r.flags || []).filter(f => FLAG_ORDER.includes(f));
// в ⚠ — только то, по чему ещё не решили: после «Решить» человек уходит из блока
const openFlags = r => r.override ? [] : shownFlags(r);

const fmtRub = n => FinUtils.fmtMoney(n, 'RUB');
// суммы архива пересчитаны в валюту сделки через соотношение цен — копейки там ни о чём не говорят
const money = (v, cur) => FinUtils.fmtMoney(Math.round(Number(v) || 0), cur);
const pctStr = p => p == null ? '—' : `${Math.round(Number(p))}%`;
const fmtDate = ts => ts ? DateUtils.formatDisplay(new Date(ts)) : '';
const participantHref = pid => `participants.html?retreat=${encodeURIComponent(currentRetreat)}&open=${encodeURIComponent(pid)}`;

async function loadRetreats() {
    const { data, error } = await Layout.db.rpc('fin_sales_fee_retreats');
    if (error) { Layout.handleError(error, t('fin_sales_fee_title')); return; }
    retreats = data || [];
    const sel = document.getElementById('retreatSelect');
    sel.innerHTML = retreats.map(r =>
        `<option value="${e(r.id)}">${e(r.name)} · ${e(DateUtils.formatRange(r.start_date, r.end_date))}</option>`).join('');
    const fromUrl = new URLSearchParams(location.search).get('retreat');
    currentRetreat = retreats.some(r => r.id === fromUrl) ? fromUrl : retreats[0]?.id || null;
    if (currentRetreat) sel.value = currentRetreat;
}

async function loadCalc() {
    const body = document.getElementById('sfBody');
    if (!currentRetreat) {
        body.innerHTML = `<div class="text-center py-16 opacity-50">${e(t('fin_sales_fee_no_retreats'))}</div>`;
        return;
    }
    const { data, error } = await Layout.db.rpc('fin_sales_fee_calc', { p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, t('fin_sales_fee_title')); return; }
    calc = data;
    render();
}

// Кто изменился с момента фиксации
function fixationDiff() {
    const fx = calc.fixation;
    if (!fx) return null;
    const was = new Set((fx.participant_ids || []).map(String));
    const now = new Set(calc.rows.filter(r => r.ok).map(r => String(r.participant_id)));
    const byId = Object.fromEntries(calc.rows.map(r => [String(r.participant_id), r]));
    const added = [...now].filter(id => !was.has(id)).map(id => byId[id]);
    const removed = [...was].filter(id => !now.has(id)).map(id => byId[id] || { participant_id: id, name: t('fin_sales_fee_left_list') });
    const delta = Number(calc.amount_rub) - Number(fx.amount_rub);
    return { added, removed, delta, changed: added.length > 0 || removed.length > 0 || delta !== 0 };
}

function renderWarnings() {
    // после фиксации проверять нечего, пока ничего не изменилось
    if (calc.fixation && !fixationDiff().changed) return '';
    const groups = {};
    calc.rows.forEach(r => openFlags(r).forEach(f => { (groups[f] = groups[f] || []).push(r); }));
    const parts = FLAG_ORDER.filter(f => groups[f]).map(f => `
        <div class="mb-2">
            <div class="font-semibold">${e(t('fin_sales_fee_flag_' + f))} — ${groups[f].length}</div>
            <div class="text-sm opacity-80">${e(t('fin_sales_fee_flag_' + f + '_hint'))}</div>
            <div class="text-sm mt-1 flex flex-wrap gap-x-3 gap-y-1">${groups[f].map(r =>
                `<a class="link" href="#" data-goto="${e(r.participant_id)}">${e(r.name)} (${pctStr(r.pct)})</a>`).join('')}</div>
        </div>`);
    if (Number(calc.unposted_crm) > 0) {
        parts.unshift(`<div class="mb-2"><div class="font-semibold">${e(t('fin_sales_fee_unposted'))} — ${calc.unposted_crm}</div>
            <a class="link text-sm" href="index.html">${e(t('fin_sales_fee_unposted_hint'))}</a></div>`);
    }
    if (!parts.length) return '';
    return `<div class="alert alert-warning items-start mb-4 block">
        <div class="font-bold mb-2">⚠ ${e(t('fin_sales_fee_check'))}</div>${parts.join('')}</div>`;
}

function renderSummary() {
    const fx = calc.fixation;
    const diff = fixationDiff();
    const ruleLine = `${e(t('fin_sales_fee_rule'))}: ${fmtRub(calc.rate_rub)} · ${e(t('fin_sales_fee_threshold_short'))} ${Math.round(calc.threshold * 100)}%`
        + (isAdmin ? ` <button type="button" class="btn btn-outline btn-primary btn-xs ml-2 gap-1 no-print" id="settingsBtn"><svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"/></svg>${e(t('edit'))}</button>` : '');
    const prices = Object.entries(calc.prices || {}).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' / ') || '—';

    let fixHtml;
    if (!fx) {
        fixHtml = `<div class="badge badge-ghost">${e(t('fin_sales_fee_not_fixed'))}</div>`;
    } else {
        fixHtml = `<div class="text-sm"><span class="badge badge-success badge-sm">${e(t('fin_sales_fee_fixed'))}</span>
            ${e(fmtDate(fx.created_at))}${fx.created_by_name ? ' · ' + e(fx.created_by_name) : ''}:
            ${fx.qualified_count} × ${fmtRub(fx.rate_rub)} = <b>${fmtRub(fx.amount_rub)}</b>${fx.comment ? ' · ' + e(fx.comment) : ''}</div>`;
        if (diff.changed) {
            const names = (list, sign) => list.map(r => `${sign} ${e(r.name)}`).join(', ');
            fixHtml += `<div class="alert alert-info mt-2 py-2 text-sm block">
                ${e(t('fin_sales_fee_changed'))}: ${calc.qualified} ${e(t('fin_sales_fee_people_short'))} —
                ${diff.delta >= 0 ? e(t('fin_sales_fee_add')) : e(t('fin_sales_fee_reverse'))} <b>${fmtRub(Math.abs(diff.delta))}</b>
                ${diff.added.length ? `<div>${names(diff.added, '+')}</div>` : ''}
                ${diff.removed.length ? `<div>${names(diff.removed, '−')}</div>` : ''}
            </div>`;
        }
    }
    const canFix = isAdmin && calc.has_object && (!fx || diff.changed);
    const fixBtn = canFix
        ? `<button type="button" id="fixBtn" class="btn btn-primary btn-sm no-print">${e(t(fx ? 'fin_sales_fee_refix' : 'fin_sales_fee_fix'))}</button>`
        : '';

    const ex = calc.excluded || {};
    const exParts = ['team', 'volunteer', 'vip'].filter(k => ex[k]).map(k => `${t('fin_sales_fee_status_' + k)} ${ex[k]}`);

    return `<div class="card bg-base-100 mb-4"><div class="card-body py-4">
        <div class="flex flex-wrap justify-between gap-4">
            <div>
                <div class="text-3xl font-bold">${calc.qualified} × ${fmtRub(calc.rate_rub)} = ${fmtRub(calc.amount_rub)}</div>
                <div class="text-sm opacity-70 mt-1">${ruleLine}</div>
                <div class="text-sm opacity-70">${e(t('fin_sales_fee_full_fee'))}: ${e(prices)}</div>
                ${exParts.length ? `<div class="text-sm opacity-60">${e(t('fin_sales_fee_not_paying'))}: ${e(exParts.join(', '))}</div>` : ''}
            </div>
            <div class="flex flex-col items-end gap-2">${fixHtml}${fixBtn}</div>
        </div>
        ${!fx ? `<p class="text-xs opacity-60 mt-2">${e(t('fin_sales_fee_fix_hint'))}</p>` : ''}
    </div></div>`;
}

function rowHtml(r) {
    const flagged = shownFlags(r).length > 0;
    const ov = r.override
        ? `<div class="text-xs ${r.override.include ? 'text-success' : 'text-error'}">${e(t(r.override.include ? 'fin_sales_fee_included_manually' : 'fin_sales_fee_excluded_manually'))}: ${e(r.override.comment || '')}</div>`
        : '';
    const badges = shownFlags(r).map(f => `<span class="badge badge-warning badge-xs">${e(t('fin_sales_fee_flag_' + f))}</span>`).join(' ');
    const paid = money(r.paid, r.currency);
    const price = money(r.price, r.currency);
    const debt = Number(r.debt) > 0 ? `<div class="text-xs text-error">${e(t('fin_sales_fee_owes'))} ${money(r.debt, r.currency)}</div>` : '';
    return `<tr id="sf-row-${e(r.participant_id)}" class="${flagged ? 'sf-flagged' : ''}">
        <td><a class="link link-hover" href="${participantHref(r.participant_id)}" target="_blank">${e(r.name)}</a> ${badges}${ov}</td>
        <td class="text-right font-mono whitespace-nowrap">${paid}${debt}</td>
        <td class="text-right font-mono whitespace-nowrap opacity-60">${price}</td>
        <td class="text-right font-semibold">${pctStr(r.pct)}</td>
        ${isAdmin ? `<td class="text-right no-print"><button type="button" class="btn btn-ghost btn-xs" data-override="${e(r.participant_id)}">${e(t('fin_sales_fee_decide'))}</button></td>` : ''}
    </tr>`;
}

function tableHtml(rows, titleKey, cls) {
    if (!rows.length) return '';
    return `<div class="card bg-base-100 mb-4"><div class="card-body py-4">
        <h2 class="card-title text-base ${cls}">${e(t(titleKey))} — ${rows.length}</h2>
        <div class="overflow-x-auto"><table class="table table-sm sf-table">
            <thead><tr>
                <th>${e(t('fin_sales_fee_col_name'))}</th>
                <th class="text-right">${e(t('fin_sales_fee_col_paid'))}</th>
                <th class="text-right">${e(t('fin_sales_fee_col_full'))}</th>
                <th class="text-right">%</th>
                ${isAdmin ? '<th class="no-print"></th>' : ''}
            </tr></thead>
            <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table></div>
    </div></div>`;
}

function render() {
    const body = document.getElementById('sfBody');
    if (!calc.has_object) {
        body.innerHTML = `<div class="alert alert-warning">${e(t('fin_sales_fee_no_object'))}</div>`;
        return;
    }
    const ok = calc.rows.filter(r => r.ok);
    const no = calc.rows.filter(r => !r.ok);
    body.innerHTML = renderWarnings() + renderSummary()
        + tableHtml(ok, 'fin_sales_fee_pass', 'text-success')
        + tableHtml(no, 'fin_sales_fee_fail', 'text-error');
}

// ---------- действия ----------
async function fix() {
    const fx = calc.fixation;
    const q = fx
        ? `${t('fin_sales_fee_refix_confirm')}\n${fmtRub(fx.amount_rub)} → ${fmtRub(calc.amount_rub)}`
        : `${t('fin_sales_fee_fix_confirm')}\n${calc.qualified} × ${fmtRub(calc.rate_rub)} = ${fmtRub(calc.amount_rub)}`;
    if (!confirm(q)) return;
    const comment = fx ? (prompt(t('fin_sales_fee_refix_reason')) || '').trim() : '';
    const btn = document.getElementById('fixBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await FinUtils.rpc('fin_sales_fee_fix', { retreat_id: currentRetreat, comment: comment || null });
        if (FinUtils.handleResult(res, 'fin_sales_fee_fixed_done')) {
            await loadRetreats();
            await loadCalc();
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

function openOverride(pid) {
    const r = calc.rows.find(x => String(x.participant_id) === String(pid));
    if (!r) return;
    document.getElementById('overridePid').value = pid;
    document.getElementById('overrideTitle').textContent = r.name;
    document.getElementById('overrideInfo').textContent =
        `${t('fin_sales_fee_col_paid')}: ${money(r.paid, r.currency)} ${t('fin_sales_fee_of')} ${money(r.price, r.currency)} — ${pctStr(r.pct)} · ${t(r.auto ? 'fin_sales_fee_formula_yes' : 'fin_sales_fee_formula_no')}`;
    const choice = r.override ? String(r.override.include) : 'auto';
    document.querySelectorAll('input[name="ovChoice"]').forEach(i => { i.checked = i.value === choice; });
    document.getElementById('overrideComment').value = r.override?.comment || '';
    document.getElementById('overrideModal').showModal();
}

async function submitOverride(ev) {
    ev.preventDefault();
    const pid = document.getElementById('overridePid').value;
    const choice = document.querySelector('input[name="ovChoice"]:checked')?.value || 'auto';
    const comment = document.getElementById('overrideComment').value.trim();
    if (choice !== 'auto' && !comment) {
        Layout.showNotification(t('fin_sales_fee_reason_required'), 'warning');
        return;
    }
    const res = await FinUtils.rpc('fin_sales_fee_set_override', {
        retreat_id: currentRetreat, participant_id: pid,
        include: choice === 'auto' ? null : choice === 'true', comment: comment || null
    });
    if (FinUtils.handleResult(res, 'saved')) {
        document.getElementById('overrideModal').close();
        await loadCalc();
    }
}

function openSettings() {
    document.getElementById('setRate').value = calc.rate_rub;
    document.getElementById('setThreshold').value = Math.round(calc.threshold * 100);
    document.getElementById('settingsModal').showModal();
}

async function submitSettings(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_sales_fee_set_settings', {
        rate_rub: Number(document.getElementById('setRate').value),
        threshold: Number(document.getElementById('setThreshold').value) / 100
    });
    if (FinUtils.handleResult(res, 'saved')) {
        document.getElementById('settingsModal').close();
        await loadCalc();
    }
}

// Отчёт для Телеграма: без звёздочек и таблиц, эмодзи-заголовки, «•»
// После фиксации отчёт строится из её снимка — тот самый список, по которому проведена трата
async function telegramText() {
    const ret = retreats.find(r => r.id === currentRetreat);
    const fx = calc.fixation;
    let rows = calc.rows, threshold = calc.threshold;
    if (fx) {
        const { data, error } = await Layout.db.rpc('fin_sales_fee_fixation', { p_fixation: fx.id });
        if (error) { Layout.handleError(error, t('fin_sales_fee_title')); return null; }
        rows = data.rows; threshold = data.threshold;
    }
    const count = fx ? fx.qualified_count : calc.qualified;
    const rate = fx ? fx.rate_rub : calc.rate_rub;
    const amount = fx ? fx.amount_rub : calc.amount_rub;
    const line = r => `• ${r.name} — ${money(r.paid, r.currency)} из ${money(r.price, r.currency)} (${pctStr(r.pct)})`
        + (r.override ? ` — ${r.override.include ? 'засчитан' : 'не засчитан'} вручную: ${r.override.comment || ''}` : '');
    const ok = rows.filter(r => r.ok);
    const no = rows.filter(r => !r.ok);
    return [
        'Харе Кришна! Примите, пожалуйста, мои поклоны.',
        '',
        `📊 Процент отделу продаж — ${ret?.name || ''}`,
        `${count} × ${fmtRub(rate)} = ${fmtRub(amount)}${fx ? ` (зафиксировано ${fmtDate(fx.created_at)})` : ' (расчёт, ещё не зафиксирован)'}`,
        `Засчитываются участники, оплатившие оргвзнос от ${Math.round(threshold * 100)}% полной суммы.`,
        '',
        `✅ Засчитаны — ${ok.length}`,
        ...ok.map(line),
        '',
        `❌ Не засчитаны — ${no.length}`,
        ...no.map(line)
    ].join('\n');
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_sales_fee', itemId: 'fin_sales_fee' });
    isAdmin = !!window.hasPermission?.('fin_admin');

    // Кэш переводов в браузере не знает про новые ключи — один раз сбрасываем
    if (t('fin_sales_fee_title') === 'fin_sales_fee_title' && !sessionStorage.getItem('salesFeeTrReload')) {
        sessionStorage.setItem('salesFeeTrReload', '1');
        Cache.invalidate('translations_v55');
        location.reload();
        return;
    }

    document.getElementById('retreatSelect').addEventListener('change', ev => {
        currentRetreat = ev.target.value;
        const url = new URL(location.href);
        url.searchParams.set('retreat', currentRetreat);
        history.replaceState(null, '', url);
        loadCalc();
    });
    document.getElementById('sfBody').addEventListener('click', ev => {
        if (ev.target.closest('#fixBtn')) { fix(); return; }
        if (ev.target.closest('#settingsBtn')) { openSettings(); return; }
        const go = ev.target.closest('[data-goto]');
        if (go) {
            ev.preventDefault();
            const row = document.getElementById('sf-row-' + go.dataset.goto);
            if (!row) return;
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.remove('sf-found');
            void row.offsetWidth;
            row.classList.add('sf-found');
            return;
        }
        const ov = ev.target.closest('[data-override]');
        if (ov) openOverride(ov.dataset.override);
    });
    document.getElementById('overrideForm').addEventListener('submit', FinUtils.lockedSubmit(submitOverride));
    document.getElementById('settingsForm').addEventListener('submit', FinUtils.lockedSubmit(submitSettings));
    document.getElementById('printBtn').addEventListener('click', () => window.print());
    document.getElementById('copyBtn').addEventListener('click', async () => {
        if (!calc) return;
        const text = await telegramText();
        if (text === null) return;
        const ok = await FinUtils.copyText(text);
        Layout.showNotification(t(ok ? 'fin_sales_fee_copied' : 'error'), ok ? 'success' : 'error');
    });

    await loadRetreats();
    await loadCalc();
}

init();
})();
