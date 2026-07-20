// ==================== ФИНАНСЫ: АНАЛИТИКА ====================
// 9.6 «По ретриту»: живой отчёт, закрытие (UC-12), версии, PDF.
// 9.7 «Общая»: период → статьи / месяцы / объекты.
// PDF формируется на клиенте (pdf-lib + fontkit + Noto Sans) из
// snapshot версии закрытия, загружается как объектное вложение и
// связывается fin_finalize_closure — сбой генерации ничего не откатывает.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
const fmtB = n => FinUtils.fmtMoney(n, 'INR');

let retreats = [];
let currentRetreat = null;
let currentData = null;   // результат fin_get_retreat_report

// ==================== ПО РЕТРИТУ ====================
async function loadRetreats() {
    const { data } = await Layout.db.from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date')
        .order('start_date', { ascending: false });
    retreats = data || [];
    const sel = document.getElementById('retreatSelect');
    sel.innerHTML = `<option value="">${t('fin_select_retreat')}</option>` +
        retreats.map(r => `<option value="${r.id}">${e(Layout.getName(r))}</option>`).join('');
    sel.addEventListener('change', () => selectRetreat(sel.value || null));
}

async function selectRetreat(id) {
    currentRetreat = id;
    if (!id) {
        document.getElementById('retreatReport').innerHTML =
            `<div class="text-center py-8 opacity-60">${t('fin_select_retreat')}</div>`;
        return;
    }
    await loadReport();
}

function catTable(rows, titleKey) {
    if (!rows?.length) return '';
    return `
    <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
        <h2 class="card-title text-base">${t(titleKey)}</h2>
        <div class="overflow-x-auto"><table class="table table-sm">
            <tbody>${rows.map(r => `
                <tr>
                    <td>${e(r.name)}</td>
                    <td class="text-right opacity-60">${Object.entries(r.by_currency || {}).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' · ')}</td>
                    <td class="text-right font-mono w-36">${fmtB(r.base_total)}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>
    </div></div>`;
}

function closureBlock(d) {
    const isAdmin = window.hasPermission?.('fin_admin');
    let statusHtml;
    if (!d.is_closed) {
        statusHtml = `<span class="badge badge-success">${t('fin_status_open')}</span>
            ${isAdmin ? `<button class="btn btn-error btn-sm ml-auto" onclick="FinAnalytics.openClose()">${t('fin_close_retreat')}</button>` : ''}`;
    } else if (d.report_dirty_at) {
        statusHtml = `<span class="badge badge-neutral">${t('fin_status_closed')}</span>
            <span class="badge badge-warning">${t('fin_report_dirty')}</span>
            ${isAdmin ? `<button class="btn btn-warning btn-sm ml-auto" onclick="FinAnalytics.openReissue()">${t('fin_reissue')}</button>` : ''}`;
    } else {
        statusHtml = `<span class="badge badge-neutral">${t('fin_status_closed')}</span>`;
    }

    const versions = (d.versions || []).map(v => `
        <tr>
            <td>v${v.version}${v.is_initial ? ` <span class="opacity-70 text-xs">${t('fin_initial')}</span>` : ''}</td>
            <td>${v.status === 'finalized'
                ? `<span class="badge badge-success badge-sm">${t('fin_finalized')}</span>`
                : `<span class="badge badge-warning badge-sm">${t('fin_report_pending')}</span>`}</td>
            <td class="whitespace-nowrap opacity-70">${v.closed_at ? DateUtils.formatShort(new Date(v.closed_at.slice(0, 16))) : ''}</td>
            <td class="opacity-70">${e(v.reason || '')}</td>
            <td class="text-right">${v.attachment_path
                ? `<button class="btn btn-ghost btn-xs" data-attachment-path="${e(v.attachment_path)}">PDF</button>`
                : (window.hasPermission?.('fin_admin')
                    ? `<button class="btn btn-outline btn-xs" onclick="FinAnalytics.makePdf('${v.closure_id}', ${v.version})">${t('fin_generate_pdf')}</button>`
                    : '')}</td>
        </tr>`).join('');

    return `
    <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
        <div class="flex items-center gap-2 flex-wrap">
            <h2 class="card-title text-base mr-2">${t('fin_closure')}</h2>
            ${statusHtml}
        </div>
        ${versions ? `<div class="overflow-x-auto"><table class="table table-sm mt-2"><tbody>${versions}</tbody></table></div>` : ''}
    </div></div>`;
}

async function loadReport() {
    const box = document.getElementById('retreatReport');
    box.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;
    const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'Аналитика'); return; }
    if (!data?.ok) { Layout.showNotification(data?.error?.message || 'Ошибка', 'error'); return; }
    currentData = data.result;

    if (!currentData.exists) {
        box.innerHTML = `<div class="text-center py-8 opacity-60">${t('fin_no_fin_data')}</div>`;
        return;
    }
    const r = currentData.report;
    const p = r.participants;
    const tot = r.totals;

    const kpi = (chip, icon, label, value, sub) => `
        <div class="card bg-base-100 fin-kpi"><div class="card-body">
            <div class="flex items-start gap-3">
                <div class="fin-icon-chip ${chip}">${icon}</div>
                <div class="min-w-0">
                    <div class="fin-kpi-label">${label}</div>
                    <div class="fin-kpi-value mt-0.5">${value}</div>
                    ${sub ? `<div class="text-xs opacity-70 mt-0.5">${sub}</div>` : ''}
                </div>
            </div>
        </div></div>`;
    const icUsers = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>';
    const icUp = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/></svg>';
    const icDown = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181"/></svg>';
    const icNet = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15M9 12l2.25 2.25L15 9.75M9 8.25V6a3 3 0 013-3v0a3 3 0 013 3v2.25"/></svg>';
    box.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${kpi('', icUsers, t('fin_participants_count'), p.count, `${t('fin_charged')}: ${fmtB(p.charged)} · ${t('fin_paid')}: ${fmtB(p.paid)}`)}
            ${kpi('', icUp, t('fin_income'), `<span class="text-success">${fmtB(tot.income_base)}</span>`)}
            ${kpi('is-error', icDown, t('fin_expense'), `<span class="text-error">${fmtB(tot.expense_base)}</span>`)}
            ${kpi(Number(tot.net_base) < 0 ? 'is-error' : '', icNet, t('fin_net'), `<span class="${Number(tot.net_base) < 0 ? 'text-error' : ''}">${fmtB(tot.net_base)}</span>`)}
        </div>

        ${closureBlock(currentData)}
        ${catTable(r.income_by_category, 'fin_income_by_category')}
        ${catTable(r.expense_by_category, 'fin_expense_by_category')}

        ${p.debtors?.length ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <h2 class="card-title text-base">${t('fin_debtors')} <span class="badge badge-error badge-sm">${p.debtors.length}</span>
                <span class="ml-auto font-mono text-error text-base">${fmtB(p.debt_total)}</span></h2>
            <div class="overflow-x-auto"><table class="table table-sm"><tbody>
                ${p.debtors.map(x => `<tr><td>${e(x.name || '')}</td><td class="text-right font-mono text-error w-36">${fmtB(x.debt)}</td></tr>`).join('')}
            </tbody></table></div>
        </div></div>` : ''}
        ${Number(p.advance_total) > 0 ? `<div class="text-sm opacity-70">${t('fin_advance')}: ${fmtB(p.advance_total)}</div>` : ''}
    `;
}

// ==================== ЗАКРЫТИЕ ====================
function openClose() {
    const p = currentData.report.participants;
    document.getElementById('closeInfo').innerHTML =
        p.debt_total > 0
            ? `<span class="text-error font-medium">${t('fin_debtors')}: ${p.debtors.length} · ${fmtB(p.debt_total)}</span>`
            : `<span class="text-success">${t('fin_no_debts')}</span>`;
    document.getElementById('closeModal').showModal();
}

async function submitClose() {
    const res = await FinUtils.rpc('fin_create_closure', {
        request_id: FinUtils.newRequestId(),
        object_id: currentData.object_id
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('closeModal').close();
        await loadReport();
    }
}

function openReissue() {
    document.getElementById('reissueReason').value = '';
    document.getElementById('reissueModal').showModal();
}

async function submitReissue(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_reissue_closure', {
        request_id: FinUtils.newRequestId(),
        object_id: currentData.object_id,
        reason: document.getElementById('reissueReason').value
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('reissueModal').close();
        await loadReport();
    }
}

// ==================== PDF ====================
const FONT_URL = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Regular.ttf';

async function makePdf(closureId, version) {
    Layout.showNotification(t('fin_generating_pdf'), 'info');
    try {
        // snapshot берём из версии закрытия (зафиксированные числа, не живой отчёт)
        const snap = await loadClosureSnapshot(closureId);
        const blob = await renderClosurePdf(snap, version);
        const file = new File([blob], `closure-report-v${version}.pdf`, { type: 'application/pdf' });
        const attRes = await FinUtils.uploadAndAttach(file, currentData.object_id, null, 'accounting_object');
        if (!attRes?.ok) { Layout.showNotification(attRes?.error?.message || 'Ошибка вложения', 'error'); return; }
        const finRes = await FinUtils.rpc('fin_finalize_closure', {
            closure_id: closureId,
            attachment_id: attRes.result.attachment_id
        });
        if (FinUtils.handleResult(finRes, 'fin_pdf_ready')) await loadReport();
    } catch (err) {
        console.error('[PDF]', err);
        Layout.showNotification(t('fin_pdf_failed') + ': ' + err.message, 'error');
    }
}

// totals_snapshot версии закрытия (таблица deny-all — только через RPC)
async function loadClosureSnapshot(closureId) {
    const { data, error } = await Layout.db.rpc('fin_get_closure_snapshot', { p_closure: closureId });
    if (error || !data?.ok) throw new Error(data?.error?.message || error?.message || 'snapshot');
    return data.result;
}

async function renderClosurePdf(snap, version) {
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fontBytes = await fetch(FONT_URL).then(r => { if (!r.ok) throw new Error('шрифт недоступен'); return r.arrayBuffer(); });
    const font = await doc.embedFont(fontBytes, { subset: true });

    let page = doc.addPage([595, 842]); // A4
    let y = 800;
    const left = 50, right = 545;
    const line = (txt, size, opts = {}) => {
        if (y < 60) { page = doc.addPage([595, 842]); y = 800; }
        page.drawText(String(txt), { x: opts.x || left, y, size, font, color: opts.color || rgb(0.1, 0.1, 0.1) });
        if (!opts.keep) y -= size + (opts.gap ?? 8);
    };
    const rightText = (txt, size, yy) => {
        const w = font.widthOfTextAtSize(String(txt), size);
        page.drawText(String(txt), { x: right - w, y: yy, size, font, color: rgb(0.1, 0.1, 0.1) });
    };
    const money = n => '₹ ' + Number(n).toLocaleString('ru-RU');

    line('Финансовый отчёт закрытия', 20, { gap: 4 });
    line(snap.object?.display_name || '', 14, { color: rgb(0.3, 0.3, 0.3), gap: 4 });
    line(`Версия ${version} · ${new Date().toLocaleDateString('ru-RU')}`, 10, { color: rgb(0.45, 0.45, 0.45), gap: 18 });

    const p = snap.participants || {};
    line('Участники', 13, { gap: 6 });
    line(`Всего: ${p.count}   Начислено: ${money(p.charged)}   Оплачено: ${money(p.paid)}`, 10, { gap: 4 });
    line(`Долги: ${money(p.debt_total)}   Авансы: ${money(p.advance_total)}`, 10, { gap: 14 });

    const section = (title, rows) => {
        if (!rows?.length) return;
        line(title, 13, { gap: 6 });
        for (const r of rows) {
            const yy = y;
            line(r.name, 10, { keep: true });
            rightText(money(r.base_total), 10, yy);
            y -= 16;
        }
        y -= 8;
    };
    section('Приходы по статьям', snap.income_by_category);
    section('Расходы по статьям', snap.expense_by_category);

    const tot = snap.totals || {};
    line(`Приход: ${money(tot.income_base)}   Расход: ${money(tot.expense_base)}   Сальдо: ${money(tot.net_base)}`, 12, { gap: 16 });

    if (p.debtors?.length) {
        line('Должники', 13, { gap: 6 });
        for (const d of p.debtors) {
            const yy = y;
            line(d.name || '', 10, { keep: true });
            rightText(money(d.debt), 10, yy);
            y -= 16;
        }
    }

    return new Blob([await doc.save()], { type: 'application/pdf' });
}

// ==================== CSV ====================
function exportCsv() {
    if (!currentData?.exists) return;
    const r = currentData.report;
    const rows = [['Раздел', 'Название', 'Сумма (₹)']];
    for (const x of r.income_by_category || []) rows.push(['Приход', x.name, x.base_total]);
    for (const x of r.expense_by_category || []) rows.push(['Расход', x.name, x.base_total]);
    rows.push(['Итог', 'Приход', r.totals.income_base]);
    rows.push(['Итог', 'Расход', r.totals.expense_base]);
    rows.push(['Итог', 'Сальдо', r.totals.net_base]);
    for (const d of r.participants?.debtors || []) rows.push(['Долг', d.name, d.debt]);
    const csv = '﻿' + rows.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'retreat-report.csv';
    a.click();
}

// ==================== ОБЩАЯ ====================
async function loadSummary() {
    const from = document.getElementById('sumFrom').value;
    const to = document.getElementById('sumTo').value;
    if (!from || !to) return;
    const box = document.getElementById('summaryReport');
    box.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;
    const { data, error } = await Layout.db.rpc('fin_get_summary_report', { p_from: from, p_to: to });
    if (error) { Layout.handleError(error, 'Аналитика'); return; }
    if (!data?.ok) { Layout.showNotification(data?.error?.message || 'Ошибка', 'error'); return; }
    const s = data.result;

    const tbl = (title, rows, cols) => rows?.length ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <h2 class="card-title text-base">${title}</h2>
            <div class="overflow-x-auto"><table class="table table-sm"><tbody>
                ${rows.map(r => `<tr>${cols(r)}</tr>`).join('')}
            </tbody></table></div>
        </div></div>` : '';

    box.innerHTML =
        tbl(t('fin_by_category'), s.by_category, r =>
            `<td>${e(r.name)}</td><td class="opacity-60">${t(r.direction === 'in' ? 'fin_dir_in' : 'fin_dir_out')}</td><td class="text-right font-mono w-36">${fmtB(r.base_total)}</td>`) +
        tbl(t('fin_by_month'), s.by_month, r =>
            `<td>${e(r.month)}</td><td class="text-right font-mono text-success">${fmtB(r.income_base)}</td><td class="text-right font-mono text-error w-36">${fmtB(r.expense_base)}</td>`) +
        tbl(t('fin_by_object'), s.by_object, r =>
            `<td>${e(r.name)}</td><td class="text-right font-mono text-success">${fmtB(r.income_base)}</td><td class="text-right font-mono text-error w-36">${fmtB(r.expense_base)}</td>`)
        || `<div class="text-center py-8 opacity-60">${t('fin_no_operations')}</div>`;
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_analytics', itemId: 'fin_analytics' });
    await FinUtils.loadRefs();
    await loadRetreats();

    document.querySelectorAll('[data-tab]').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('tab-active'));
            tab.classList.add('tab-active');
            document.getElementById('retreatTab').classList.toggle('hidden', tab.dataset.tab !== 'retreat');
            document.getElementById('summaryTab').classList.toggle('hidden', tab.dataset.tab !== 'summary');
        }));

    document.getElementById('reissueForm').addEventListener('submit', submitReissue);
    document.addEventListener('click', ev => {
        const att = ev.target.closest('[data-attachment-path]');
        if (att) FinUtils.openAttachment(att.dataset.attachmentPath);
    });

    // период по умолчанию: текущий год
    const now = new Date();
    document.getElementById('sumFrom').value = `${now.getFullYear()}-01-01`;
    document.getElementById('sumTo').value = FinUtils.todayISO();

    const params = new URLSearchParams(window.location.search);
    const preset = params.get('retreat');
    if (preset && retreats.some(r => r.id === preset)) {
        document.getElementById('retreatSelect').value = preset;
        await selectRetreat(preset);
    }
}

window.FinAnalytics = { openClose, submitClose, openReissue, makePdf, exportCsv, loadSummary };
init();
})();
