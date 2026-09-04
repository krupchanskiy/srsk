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
        `<div class="${total < 0 ? 'text-error' : ''}" data-count="${total}" data-cur="${code}">${FinUtils.fmtMoney(total, code)}</div>`
    ).join('');
}

// Count-up чисел KPI (~0.7s, ease-out-quart); при reduced-motion — сразу итог
function animateCounts() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('#balanceCards [data-count]').forEach(el => {
        const target = Number(el.dataset.count);
        const cur = el.dataset.cur;
        const t0 = performance.now(), dur = 700;
        const tick = now => {
            const p = Math.min(1, (now - t0) / dur);
            const eased = 1 - Math.pow(1 - p, 4);
            el.textContent = FinUtils.fmtMoney(p < 1 ? Math.round(target * eased) : target, cur);
            if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
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
        animateCounts();
    }

    // Минусы — кликабельны (→ лента счёта в ДДС)
    const negative = accounts.filter(a => a.is_negative);
    document.getElementById('negativeCount').textContent = negative.length;
    document.getElementById('negativeList').innerHTML = negative
        .map(a => `<a href="dds.html?account=${a.account_id}" class="block hover:underline">${e(a.name)}: ${FinUtils.fmtMoney(a.balance, a.currency_code)}</a>`)
        .join('');

    renderSyncAge(accounts);

    // Плитка «Входящие» считает ВСЁ, что ждёт разбора: непроверенные операции,
    // заявки из чатов и неразнесённые платежи. Замечание ВГ от 26.07.2026:
    // раньше считались только непроверенные, и при двух висящих заявках из
    // чатов на главной честно горел ноль — то есть плитка говорила «всё
    // разобрано», когда это было неправдой.
    // Оспоренные сюда не входят: у них своя плитка рядом.
    const [{ data: statusOps }, chatDrafts, unpostedPay] = await Promise.all([
        Layout.db.from('fin_v_operations').select('operation_id, approval')
            .in('approval', ['pending', 'disputed']),
        Layout.db.from('fin_v_chat_drafts').select('*', { count: 'exact', head: true }),
        Layout.db.from('fin_v_unposted_crm_payments').select('*', { count: 'exact', head: true })
    ]);
    const pending = (statusOps || []).filter(o => o.approval === 'pending').length;
    const disputed = (statusOps || []).filter(o => o.approval === 'disputed').length;
    const fromChats = chatDrafts.count || 0;
    const unposted = unpostedPay.count || 0;

    document.getElementById('pendingCount').textContent = pending + fromChats + unposted;
    document.getElementById('disputedCount').textContent = disputed;

    // Состав под заголовком: иначе непонятно, что именно ждёт разбора
    const parts = [];
    if (pending)  parts.push(`${pending} ${t('fin_tab_pending').toLowerCase()}`);
    if (fromChats) parts.push(`${fromChats} ${t('fin_tab_chat_drafts').toLowerCase()}`);
    if (unposted) parts.push(`${unposted} ${t('fin_tab_unposted').toLowerCase()}`);
    document.getElementById('pendingBreakdown').textContent = parts.join(' · ');

    // Ведём сразу на вкладку, где что-то есть: иначе человек жмёт «Входящие»,
    // попадает на пустое «Не проверено» и ищет сам.
    const target = pending ? '' : fromChats ? '?tab=chat_drafts' : unposted ? '?tab=unposted' : '';
    document.getElementById('pendingCount').closest('a').href = 'inbox.html' + target;

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

// Давность сверки по реальным счетам: точка-цвет + «сегодня / N дн. назад»,
// вся строка ведёт в сверку с предвыбранным счётом (ежедневный ритуал, runbook §4)
function renderSyncAge(accounts) {
    const card = document.getElementById('syncAgeCard');
    const list = document.getElementById('syncAgeList');
    if (!card || !list) return;
    const real = accounts.filter(a => a.kind === 'real');
    if (!real.length) { card.style.display = 'none'; return; }
    const COLORS = { success: '#059669', warning: '#b45309', error: '#dc2626' };
    // Свежесть — это ещё не порядок. Сверка, закончившаяся расхождением,
    // раньше выглядела здоровым зелёным «сегодня»: сигнал о свежести прятал
    // сам факт недостачи (замечание ВГ, 26.07.2026). Расхождение важнее
    // давности, поэтому оно перекрывает цвет и выносится в подпись.
    const ageInfo = a => {
        const gap = Number(a.last_difference) || 0;
        if (!a.last_checkpoint_seq) return { days: Infinity, label: t('fin_never_reconciled'), cls: 'error', gap: 0 };
        const days = Math.floor((Date.now() - new Date(a.last_checkpoint_at).getTime()) / 86400000);
        const label = days <= 0 ? t('fin_today') : t('fin_days_ago').replace('{n}', days);
        const cls = gap !== 0 ? 'error' : days <= 0 ? 'success' : days <= 3 ? 'warning' : 'error';
        return { days, label, cls, gap };
    };
    real.sort((a, b) => ageInfo(b).days - ageInfo(a).days);   // самые несвежие сверху
    list.innerHTML = real.map(a => {
        const info = ageInfo(a);
        const gapText = info.gap !== 0
            ? ` · ${t('fin_difference').toLowerCase()} ${FinUtils.fmtMoney(info.gap, a.currency_code)}`
            : '';
        return `<a href="reconciliation.html?account=${a.account_id}" class="flex items-center gap-2 py-2 hover:bg-base-200/50 -mx-2 px-2 rounded">
            <span class="inline-block w-2 h-2 rounded-full" style="background:${COLORS[info.cls]}"></span>
            <span class="flex-1">${e(a.name)}</span>
            <span class="text-sm" style="color:${COLORS[info.cls]}">${info.label}${gapText}</span>
        </a>`;
    }).join('');
    card.style.display = '';
}

// Сигналы наверху дашборда: платежи, не разнесённые в учёт (автопроводка),
// и нарушения целостности от ночного сторожа. Если чисто — блок скрыт.
async function loadSignals() {
    const box = document.getElementById('finSignals');
    if (!box) return;
    const [unposted, integrity] = await Promise.all([
        Layout.db.from('fin_v_unposted_crm_payments').select('*', { count: 'exact', head: true }),
        Layout.db.from('fin_v_integrity_open').select('check_name, detail, bad_count')
    ]);
    const cards = [];
    const nUnposted = unposted.count || 0;
    if (nUnposted > 0) {
        cards.push(`<a href="inbox.html?tab=unposted" class="flex items-center gap-3 p-3 rounded-lg bg-error/10 border border-error/30 hover:bg-error/15">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-5 h-5 text-error shrink-0"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>
            <span class="text-sm"><span class="font-semibold text-error">${nUnposted}</span> ${t('fin_signal_unposted')}</span>
        </a>`);
    }
    // integrity view может отсутствовать, пока миграция сторожа не применена — тихо игнорируем
    // Сигнал раскрывается: «не сходится (1)» без имён и сумм не позволяет дойти
    // до проблемы, а именно за этим на него и смотрят (ВГ, 08.08).
    for (const a of (integrity.data || [])) {
        cards.push(`<details class="fin-signal" data-check="${e(a.check_name)}">
            <summary class="flex items-center gap-3 p-3 rounded-lg bg-error/10 border border-error/30 cursor-pointer hover:bg-error/15">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-5 h-5 text-error shrink-0"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>
                <span class="text-sm flex-1"><span class="font-semibold text-error">${t('fin_signal_integrity')}:</span> ${e(a.detail)} (${a.bad_count})</span>
                <span class="fin-signal-chev"></span>
            </summary>
            <div class="fin-signal-body"><span class="loading loading-spinner loading-xs"></span></div>
        </details>`);
    }
    if (!cards.length) { box.classList.add('hidden'); return; }
    box.innerHTML = `<div class="space-y-2">${cards.join('')}</div>`;
    box.classList.remove('hidden');

    // Расшифровку тянем при раскрытии: на дашборде она нужна не всегда
    box.querySelectorAll('.fin-signal').forEach(d => d.addEventListener('toggle', async () => {
        if (!d.open || d.dataset.loaded) return;
        d.dataset.loaded = '1';
        const body = d.querySelector('.fin-signal-body');
        const { data, error } = await Layout.db.rpc('fin_get_integrity_details', { p_check: d.dataset.check });
        const rows = (!error && data?.ok) ? data.result : [];
        body.innerHTML = rows.length
            ? rows.map(r => `<div class="fin-signal-item">
                    <a class="fin-signal-row" href="${e(r.link)}">
                        <span class="fin-signal-who">${e(r.title)}</span>
                        <span class="fin-signal-where">${e(r.subtitle || '')}</span>
                        <span class="fin-signal-what">${e(r.detail || '')}</span>
                    </a>
                    ${resolveActionsHtml(r.action)}
                </div>`).join('')
            : `<div class="fin-signal-empty">${t('fin_signal_no_details')}</div>`;
        body.querySelectorAll('.fin-signal-act').forEach(b => b.addEventListener('click', onResolveClick));
    }));
}

// Разбор сигнала «человека нет в учёте» прямо из списка: ВГ проходит 13 строк
// в несколько кликов, а не открывает каждую карточку (ВГ, 03.09).
// Отменившим участие — пометка «оставлено как пожертвование», едущим —
// добор начального остатка. Деньги в обоих случаях уже внутри остатков счетов
// на дату запуска, поэтому проводок ни то ни другое не создаёт.
function resolveActionsHtml(a) {
    if (!a || a.kind !== 'resolve_missing_advance') return '';
    const attrs = act => `data-act="${act}" data-pid="${e(a.participant_id)}" data-rid="${e(a.retreat_id)}"`
        + ` data-who="${e(a.who || '')}" data-amount="${e(a.amount || '')}" data-mode="${e(a.mode || '')}"`;
    // Неполная загрузка: остаток есть, но недобрал — выбора нет, только добор
    if (a.mode === 'topup') {
        return `<div class="fin-signal-acts"><button class="fin-signal-act" ${attrs('advance')}>${t('fin_resolve_topup')}</button></div>`;
    }
    const пожертвование = `<button class="fin-signal-act${a.cancelled ? '' : ' ghost'}" ${attrs('donation')}>${t('fin_resolve_donation')}</button>`;
    const аванс = `<button class="fin-signal-act${a.cancelled ? ' ghost' : ''}" ${attrs('advance')}>${t('fin_resolve_advance')}</button>`;
    // Первой идёт та кнопка, которая уместна по статусу сделки
    return `<div class="fin-signal-acts">${a.cancelled ? пожертвование + аванс : аванс + пожертвование}</div>`;
}

async function onResolveClick(ev) {
    const b = ev.currentTarget;
    const ключ = b.dataset.act === 'donation' ? 'fin_resolve_donation_confirm'
        : b.dataset.mode === 'topup' ? 'fin_resolve_topup_confirm'
        : 'fin_resolve_advance_confirm';
    const вопрос = t(ключ).replace('{0}', b.dataset.who).replace('{1}', b.dataset.amount);
    if (!confirm(вопрос)) return;
    b.disabled = true;
    const { data, error } = await Layout.db.rpc('fin_resolve_missing_advance', {
        payload: {
            request_id: FinUtils.newRequestId(),
            participant_id: b.dataset.pid,
            retreat_id: b.dataset.rid,
            action: b.dataset.act
        }
    });
    if (error || !data?.ok) {
        b.disabled = false;
        alert(`${t('fin_resolve_failed')}: ${error?.message || data?.error?.message || ''}`);
        return;
    }
    loadSignals();
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_main', itemId: 'fin_main' });
    await loadDashboard();
    loadSignals();
}

init();
})();
