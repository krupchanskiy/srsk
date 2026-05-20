/* =============================================================================
 * Prepayment Operations — модуль операций с предоплатой
 * (Перенос на ретрит / Возврат / Пожертвование)
 *
 * Используется на deal.html, prepayments.html, person.html.
 *
 * API:
 *   PrepaymentOps.ensureRefs()
 *   PrepaymentOps.loadByPayment(paymentId)
 *   PrepaymentOps.loadByVaishnava(vaishnavaId)
 *   PrepaymentOps.getBalances(vaishnavaId) -> [{currency, amount}]
 *   PrepaymentOps.openDistribute({ payment, dealId, onSave })
 *   PrepaymentOps.openPlaceBalance({ vaishnavaId, currency, balance, dealId, dealRetreatId, onSave })
 *   PrepaymentOps.markRefundPaid(operationId)
 *   PrepaymentOps.confirmOperation(operationId)
 *   PrepaymentOps.deleteOperation(operationId)
 *   PrepaymentOps.canConfirmRefund()
 *   PrepaymentOps.renderOperationsList(operations, options)
 * =============================================================================
 */

(function() {
    'use strict';

    const PrepaymentOps = {};
    window.PrepaymentOps = PrepaymentOps;

    // ---------------- State / refs ----------------
    let _retreats = [];
    let _systems  = [];
    let _modalEl  = null;
    let _modalCtx = null; // { payment, dealId, vaishnavaId, currency, balance, mode }
    let _rowSeq   = 0;
    let _onSaveCb = null;

    const db = () => Layout.db;
    const t  = key => Layout.t(key);
    const e  = str => Layout.escapeHtml(str);
    const fmt = (a, c) => CrmUtils.formatMoney(a, c || 'INR');

    PrepaymentOps.canConfirmRefund = () => !!window.hasPermission?.('confirm_refund');

    PrepaymentOps.ensureRefs = async function() {
        if (_retreats.length && _systems.length) return;
        const [retreatsRes, systemsRes] = await Promise.all([
            db().from('retreats').select('id, name_ru, name_en, name_hi, color, start_date').order('start_date', { ascending: false }),
            db().from('crm_payment_systems').select('*').eq('is_archived', false).order('sort_order')
        ]);
        _retreats = retreatsRes.data || [];
        _systems  = systemsRes.data  || [];
    };

    // ---------------- Loaders ----------------
    const SELECT_OP = `
        *,
        target_retreat:target_retreat_id(id, name_ru, name_en, name_hi, color),
        donation_retreat:retreat_id(id, name_ru, name_en, name_hi, color),
        refund_system:refund_payment_system_id(id, code, name_ru, name_en),
        created_by_user:created_by(spiritual_name, first_name, last_name),
        confirmed_by_user:confirmed_by(spiritual_name, first_name, last_name),
        refund_paid_by_user:refund_paid_by(spiritual_name, first_name, last_name)
    `;

    PrepaymentOps.loadByPayment = async function(paymentId) {
        const { data, error } = await db()
            .from('crm_prepayment_operations')
            .select(SELECT_OP)
            .eq('payment_id', paymentId)
            .order('created_at');
        if (error) { Layout.handleError(error, 'Загрузка операций'); return []; }
        return data || [];
    };

    PrepaymentOps.loadByVaishnava = async function(vaishnavaId) {
        const { data, error } = await db()
            .from('crm_prepayment_operations')
            .select(SELECT_OP)
            .eq('vaishnava_id', vaishnavaId)
            .order('created_at', { ascending: false });
        if (error) { Layout.handleError(error, 'Загрузка операций'); return []; }
        return data || [];
    };

    PrepaymentOps.getBalances = async function(vaishnavaId) {
        const { data, error } = await db()
            .from('crm_participant_balance')
            .select('*')
            .eq('vaishnava_id', vaishnavaId);
        if (error) { Layout.handleError(error, 'Баланс'); return []; }
        return data || [];
    };

    // ---------------- Modal: ensure DOM ----------------
    function ensureModalDom() {
        if (_modalEl) return;
        const html = `
            <dialog id="distributeModal" class="modal">
              <div class="modal-box max-w-3xl">
                <h3 class="font-bold text-lg mb-1" id="distModalTitle">${t('crm_distribute_prepayment')}</h3>
                <div class="text-sm text-base-content/70 mb-3" id="distModalSubtitle"></div>

                <div id="distRows" class="space-y-3"></div>

                <button type="button" class="btn btn-sm btn-outline mt-3" id="distAddRowBtn">
                    ${t('crm_add_operation_row')}
                </button>

                <div class="divider my-3"></div>
                <div class="text-sm space-y-1">
                  <div class="flex justify-between">
                    <span class="text-base-content/60">${t('crm_total_distributed')}:</span>
                    <span class="font-mono font-bold" id="distTotal">—</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-base-content/60">${t('crm_balance_remainder')}:</span>
                    <span class="font-mono font-bold" id="distRemainder">—</span>
                  </div>
                </div>

                <div class="modal-action">
                  <button type="button" class="btn btn-ghost" id="distCancelBtn">${t('cancel') || 'Отмена'}</button>
                  <button type="button" class="btn btn-primary" id="distSaveBtn">${t('save') || 'Сохранить'}</button>
                </div>
              </div>
              <form method="dialog" class="modal-backdrop"><button>close</button></form>
            </dialog>`;
        document.body.insertAdjacentHTML('beforeend', html);
        _modalEl = document.getElementById('distributeModal');
        document.getElementById('distAddRowBtn').addEventListener('click', () => addRow());
        document.getElementById('distCancelBtn').addEventListener('click', () => _modalEl.close());
        document.getElementById('distSaveBtn').addEventListener('click', saveDistribution);
    }

    // ---------------- Modal: open ----------------
    PrepaymentOps.openDistribute = async function({ payment, dealId, onSave }) {
        await PrepaymentOps.ensureRefs();
        ensureModalDom();

        const existingOps = await PrepaymentOps.loadByPayment(payment.id);
        const distributed = existingOps.reduce((s, o) => s + Number(o.amount), 0);
        const remainder   = Number(payment.amount) - distributed;

        _modalCtx = {
            mode: 'payment',
            payment,
            dealId,
            vaishnavaId: payment.deal?.vaishnava_id || payment.vaishnava_id || null,
            currency: payment.currency,
            rate: Number(payment.rate_to_inr) || 1,
            sourceAmount: Number(payment.amount),
            alreadyDistributed: distributed,
            maxAddable: remainder
        };
        _onSaveCb = onSave;

        const retreatLabel = payment.deal?.retreats ? Layout.getName(payment.deal.retreats) : '';
        document.getElementById('distModalTitle').textContent = t('crm_distribute_prepayment');
        document.getElementById('distModalSubtitle').innerHTML = `
            <div><span class="text-base-content/50">${e(CrmUtils.getGuestName(payment.deal?.vaishnavas) || '')}</span></div>
            <div>Предоплата: <span class="font-mono font-medium">${e(fmt(payment.amount, payment.currency))}</span>
              ${retreatLabel ? ` · ${e(retreatLabel)}` : ''}
              ${distributed > 0 ? ` · уже распределено <span class="font-mono">${e(fmt(distributed, payment.currency))}</span>` : ''}
            </div>
        `;

        // Reset rows
        document.getElementById('distRows').innerHTML = '';
        _rowSeq = 0;
        addRow({ amount: remainder > 0 ? remainder : '' });
        recalcTotals();
        _modalEl.showModal();
    };

    PrepaymentOps.openPlaceBalance = async function({ vaishnavaId, currency, balance, dealId, dealRetreatId, onSave }) {
        await PrepaymentOps.ensureRefs();
        ensureModalDom();

        const rate = (function() {
            // Грубо: курс берём из crm_currencies (если есть передан Layout.currencies — лучше). Здесь 1, если INR.
            return 1; // курс уже зашит в исходной предоплате; здесь не нужен для базовой записи
        })();

        _modalCtx = {
            mode: 'balance',
            payment: null,
            dealId: dealId || null,
            vaishnavaId,
            currency,
            rate,
            sourceAmount: Number(balance),
            alreadyDistributed: 0,
            maxAddable: Number(balance),
            preselectRetreatId: dealRetreatId || null
        };
        _onSaveCb = onSave;

        document.getElementById('distModalTitle').textContent = t('crm_place_balance');
        document.getElementById('distModalSubtitle').innerHTML = `
            <div>${t('crm_balance_remainder')}: <span class="font-mono font-medium">${e(fmt(balance, currency))}</span></div>
        `;
        document.getElementById('distRows').innerHTML = '';
        _rowSeq = 0;
        // Дефолт — Перенос на текущий ретрит (если задан)
        addRow({ type: 'transfer', amount: balance, targetRetreatId: dealRetreatId || '' });
        recalcTotals();
        _modalEl.showModal();
    };

    // ---------------- Modal: rows ----------------
    function addRow(initial = {}) {
        _rowSeq++;
        const id = 'dist-row-' + _rowSeq;
        const div = document.createElement('div');
        div.className = 'border border-base-300 rounded-lg p-3 bg-base-200/30';
        div.dataset.rowId = id;
        div.innerHTML = `
            <div class="flex flex-wrap items-center gap-2">
              <select class="select select-bordered select-sm" data-role="type">
                <option value="transfer">${e(t('crm_operation_transfer'))}</option>
                <option value="refund">${e(t('crm_operation_refund'))}</option>
                <option value="donation">${e(t('crm_operation_donation'))}</option>
              </select>
              <input type="number" step="0.01" min="0.01" class="input input-bordered input-sm w-32 text-right font-mono" data-role="amount" placeholder="0">
              <span class="text-xs text-base-content/50">${e(_modalCtx.currency)}</span>
              <div class="flex-1"></div>
              <button type="button" class="btn btn-ghost btn-xs text-error" data-role="remove" title="Удалить">✕</button>
            </div>
            <div class="mt-2" data-role="extras"></div>
        `;
        document.getElementById('distRows').appendChild(div);

        const typeSel = div.querySelector('[data-role="type"]');
        const amountInp = div.querySelector('[data-role="amount"]');
        const removeBtn = div.querySelector('[data-role="remove"]');

        typeSel.value = initial.type || 'transfer';
        if (initial.amount != null) amountInp.value = initial.amount;

        typeSel.addEventListener('change', () => renderExtras(div));
        amountInp.addEventListener('input', recalcTotals);
        removeBtn.addEventListener('click', () => {
            div.remove();
            recalcTotals();
            // Гарантировать хотя бы одну строку
            if (document.querySelectorAll('#distRows > div').length === 0) addRow();
        });

        renderExtras(div, initial);
    }

    function renderExtras(rowEl, initial = {}) {
        const type = rowEl.querySelector('[data-role="type"]').value;
        const ex = rowEl.querySelector('[data-role="extras"]');
        if (type === 'transfer') {
            const preselect = initial.targetRetreatId || _modalCtx.preselectRetreatId || '';
            ex.innerHTML = `
                <div class="flex flex-wrap items-center gap-2">
                  <label class="label cursor-pointer gap-2 py-0">
                    <input type="checkbox" class="checkbox checkbox-sm" data-role="undecided" ${initial.undecided ? 'checked' : ''}>
                    <span class="label-text text-xs">${e(t('crm_retreat_undecided'))}</span>
                  </label>
                  <select class="select select-bordered select-sm flex-1 min-w-[200px]" data-role="target-retreat">
                    <option value="">— ${e(t('crm_target_retreat'))} —</option>
                    ${_retreats.map(r => `<option value="${r.id}" ${r.id===preselect?'selected':''}>${e(Layout.getName(r))}</option>`).join('')}
                  </select>
                  <input type="text" class="input input-bordered input-sm flex-1 min-w-[200px] hidden" data-role="transfer-note" placeholder="Комментарий (например «уточнит позже»)" value="${e(initial.transferNote || '')}">
                </div>
            `;
            const cb = ex.querySelector('[data-role="undecided"]');
            const sel = ex.querySelector('[data-role="target-retreat"]');
            const note = ex.querySelector('[data-role="transfer-note"]');
            const sync = () => {
                if (cb.checked) {
                    sel.classList.add('hidden');
                    note.classList.remove('hidden');
                    sel.value = '';
                } else {
                    sel.classList.remove('hidden');
                    note.classList.add('hidden');
                }
            };
            cb.addEventListener('change', sync);
            sync();
        } else if (type === 'refund') {
            const initStatus = initial.refundStatus || 'pending';
            ex.innerHTML = `
                <div class="flex flex-wrap items-center gap-2">
                  <select class="select select-bordered select-sm" data-role="refund-system">
                    <option value="">— Способ возврата —</option>
                    ${_systems.map(s => `<option value="${s.id}">${e(Layout.getName(s))}</option>`).join('')}
                  </select>
                  <select class="select select-bordered select-sm" data-role="refund-status">
                    <option value="pending" ${initStatus==='pending'?'selected':''}>${e(t('crm_refund_pending'))}</option>
                    <option value="paid"    ${initStatus==='paid'   ?'selected':''}>${e(t('crm_refund_paid'))}</option>
                  </select>
                  <input type="date" class="input input-bordered input-sm hidden" data-role="refund-date" value="${initial.refundPaidAt || DateUtils.toISO(new Date())}">
                </div>
                <div class="text-xs text-amber-700 mt-1">Подтверждение и смена статуса на «Выплачен» — только у пользователя с правом «Подтверждение возврата».</div>
            `;
            const statusSel = ex.querySelector('[data-role="refund-status"]');
            const dateInp = ex.querySelector('[data-role="refund-date"]');
            const sync = () => {
                if (statusSel.value === 'paid') dateInp.classList.remove('hidden');
                else dateInp.classList.add('hidden');
            };
            statusSel.addEventListener('change', sync);
            sync();
            // Без права — блокируем выбор "paid"
            if (!PrepaymentOps.canConfirmRefund()) {
                statusSel.value = 'pending';
                statusSel.disabled = true;
            }
        } else if (type === 'donation') {
            ex.innerHTML = `
                <div class="flex flex-wrap items-center gap-2">
                  <select class="select select-bordered select-sm flex-1 min-w-[200px]" data-role="donation-retreat" required>
                    <option value="">— ${e(t('crm_target_retreat'))} (обязательно) —</option>
                    ${_retreats.map(r => `<option value="${r.id}">${e(Layout.getName(r))}</option>`).join('')}
                  </select>
                  <input type="text" class="input input-bordered input-sm flex-1 min-w-[200px]" data-role="donation-note" placeholder="Комментарий (необязательно)" value="${e(initial.donationNote || '')}">
                </div>
            `;
        }
    }

    function recalcTotals() {
        const rows = document.querySelectorAll('#distRows > div');
        let total = 0;
        rows.forEach(r => {
            const v = parseFloat(r.querySelector('[data-role="amount"]').value);
            if (!isNaN(v) && v > 0) total += v;
        });
        const ctx = _modalCtx;
        const remainder = ctx.maxAddable - total;
        document.getElementById('distTotal').textContent = fmt(total, ctx.currency);
        const remEl = document.getElementById('distRemainder');
        if (remainder < 0) {
            remEl.textContent = fmt(remainder, ctx.currency) + ' (превышение!)';
            remEl.className = 'font-mono font-bold text-error';
        } else {
            remEl.textContent = fmt(remainder, ctx.currency);
            remEl.className = remainder > 0 ? 'font-mono font-bold text-amber-600' : 'font-mono font-bold text-emerald-600';
        }
        document.getElementById('distSaveBtn').disabled = (remainder < 0) || rows.length === 0;
    }

    // ---------------- Modal: save ----------------
    async function saveDistribution() {
        const rows = document.querySelectorAll('#distRows > div');
        const ctx = _modalCtx;

        const inserts = [];
        for (const r of rows) {
            const type = r.querySelector('[data-role="type"]').value;
            const amount = parseFloat(r.querySelector('[data-role="amount"]').value);
            if (!amount || amount <= 0) continue;

            const base = {
                payment_id:  ctx.payment?.id || null,
                vaishnava_id: ctx.vaishnavaId,
                deal_id:     ctx.dealId || null,
                operation_type: type,
                amount: amount,
                currency: ctx.currency,
                rate_to_inr: ctx.rate,
                amount_inr: amount * ctx.rate,
                created_by: window.currentUser?.vaishnava_id || null,
                is_confirmed: true,   // по умолчанию для transfer/donation
                confirmed_at: new Date().toISOString(),
                confirmed_by: window.currentUser?.vaishnava_id || null
            };

            if (type === 'transfer') {
                const undecided = r.querySelector('[data-role="undecided"]').checked;
                const targetRetreatId = r.querySelector('[data-role="target-retreat"]').value || null;
                const note = r.querySelector('[data-role="transfer-note"]').value.trim() || null;
                base.target_retreat_id = undecided ? null : targetRetreatId;
                base.transfer_note = undecided ? (note || 'Ретрит не определён') : null;
            } else if (type === 'refund') {
                const sysId = r.querySelector('[data-role="refund-system"]').value || null;
                const status = r.querySelector('[data-role="refund-status"]').value;
                const dateInp = r.querySelector('[data-role="refund-date"]');
                base.refund_payment_system_id = sysId;
                base.refund_status = status;
                if (status === 'paid') {
                    base.refund_paid_at = (dateInp.value || DateUtils.toISO(new Date())) + 'T12:00:00';
                    base.refund_paid_by = window.currentUser?.vaishnava_id || null;
                    base.is_confirmed = true;
                } else {
                    // Возврат, ожидающий выплаты — НЕ подтверждён (нужно явное подтверждение)
                    base.is_confirmed = false;
                    base.confirmed_at = null;
                    base.confirmed_by = null;
                }
            } else if (type === 'donation') {
                const retreatId = r.querySelector('[data-role="donation-retreat"]').value;
                if (!retreatId) {
                    Layout.showNotification('У пожертвования обязательно укажите ретрит-получатель', 'error');
                    return;
                }
                base.retreat_id = retreatId;
                base.donation_note = r.querySelector('[data-role="donation-note"]').value.trim() || null;
            }

            inserts.push(base);
        }

        if (inserts.length === 0) {
            Layout.showNotification('Нечего сохранять', 'error');
            return;
        }

        const { data, error } = await db().from('crm_prepayment_operations').insert(inserts).select('id, operation_type, amount, currency');
        if (error) { Layout.handleError(error, 'Сохранение операций'); return; }

        // Логи
        for (const op of (data || [])) {
            await logActivity(ctx.dealId, 'prepayment_operation_created', {
                operation_id: op.id,
                operation_type: op.operation_type,
                amount: op.amount,
                currency: op.currency,
                payment_id: ctx.payment?.id || null
            });
        }

        Layout.showNotification('Операции сохранены', 'success');
        _modalEl.close();
        if (typeof _onSaveCb === 'function') await _onSaveCb();
    }

    async function logActivity(dealId, actionType, details) {
        if (!dealId) return;
        try {
            await db().from('crm_activity_log').insert({
                deal_id: dealId,
                manager_id: window.currentUser?.vaishnava_id || null,
                action_type: actionType,
                action_details: details
            });
        } catch (err) {
            console.warn('activity_log insert failed', err);
        }
    }

    // ---------------- Per-operation actions ----------------
    PrepaymentOps.markRefundPaid = async function(operationId) {
        if (!PrepaymentOps.canConfirmRefund()) {
            Layout.showNotification('Нет прав на изменение статуса возврата', 'error');
            return false;
        }
        const { data, error } = await db()
            .from('crm_prepayment_operations')
            .update({
                refund_status: 'paid',
                refund_paid_at: new Date().toISOString(),
                refund_paid_by: window.currentUser?.vaishnava_id || null,
                is_confirmed: true,
                confirmed_at: new Date().toISOString(),
                confirmed_by: window.currentUser?.vaishnava_id || null
            })
            .eq('id', operationId)
            .select('id, deal_id, amount, currency')
            .single();
        if (error) { Layout.handleError(error, 'Возврат'); return false; }
        await logActivity(data.deal_id, 'prepayment_operation_refund_paid', { operation_id: data.id, amount: data.amount, currency: data.currency });
        Layout.showNotification('Возврат отмечен как выплаченный', 'success');
        return true;
    };

    PrepaymentOps.confirmOperation = async function(operationId) {
        if (!PrepaymentOps.canConfirmRefund()) {
            Layout.showNotification('Нет прав на подтверждение операции', 'error');
            return false;
        }
        const { data, error } = await db()
            .from('crm_prepayment_operations')
            .update({
                is_confirmed: true,
                confirmed_at: new Date().toISOString(),
                confirmed_by: window.currentUser?.vaishnava_id || null
            })
            .eq('id', operationId)
            .select('id, deal_id, operation_type')
            .single();
        if (error) { Layout.handleError(error, 'Подтверждение'); return false; }
        await logActivity(data.deal_id, 'prepayment_operation_confirmed', { operation_id: data.id, operation_type: data.operation_type });
        Layout.showNotification('Операция подтверждена', 'success');
        return true;
    };

    PrepaymentOps.deleteOperation = async function(operationId) {
        if (!confirm('Удалить операцию?')) return false;
        const { data: op } = await db().from('crm_prepayment_operations').select('deal_id, operation_type, amount, currency, refund_status').eq('id', operationId).single();
        // Запрет: возврат уже выплачен — нельзя удалять без права
        if (op?.operation_type === 'refund' && op.refund_status === 'paid' && !PrepaymentOps.canConfirmRefund()) {
            Layout.showNotification('Выплаченный возврат может удалить только пользователь с правом подтверждения', 'error');
            return false;
        }
        const { error } = await db().from('crm_prepayment_operations').delete().eq('id', operationId);
        if (error) { Layout.handleError(error, 'Удаление'); return false; }
        if (op) await logActivity(op.deal_id, 'prepayment_operation_deleted', { operation_id: operationId, operation_type: op.operation_type, amount: op.amount, currency: op.currency });
        Layout.showNotification('Операция удалена', 'success');
        return true;
    };

    // ---------------- Rendering ----------------
    const OP_ICON = {
        transfer: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>',
        refund:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg>',
        donation: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>'
    };

    PrepaymentOps.renderOperationsList = function(operations, options = {}) {
        if (!operations || operations.length === 0) {
            return options.compact ? '' : `<div class="text-xs text-base-content/40 py-2 text-center">${e(t('crm_no_operations'))}</div>`;
        }
        return `<div class="space-y-1 ${options.compact ? '' : 'py-2'}">
            ${operations.map(op => renderOperationRow(op, options)).join('')}
        </div>`;
    };

    function renderOperationRow(op, options = {}) {
        const typeLabel = t('crm_operation_' + op.operation_type);
        const icon = OP_ICON[op.operation_type] || '';
        let detailsHtml = '';
        let statusHtml = '';

        if (op.operation_type === 'transfer') {
            if (op.target_retreat) {
                detailsHtml = `<span class="badge badge-sm whitespace-nowrap" style="background-color:${e(op.target_retreat.color || '#6b7280')};color:white;">${e(Layout.getName(op.target_retreat))}</span>`;
            } else {
                detailsHtml = `<span class="text-amber-700 text-xs">${e(t('crm_retreat_undecided'))}${op.transfer_note ? ' · ' + e(op.transfer_note) : ''}</span>`;
            }
            statusHtml = `<span class="text-emerald-600 text-xs">✓</span>`;
        } else if (op.operation_type === 'refund') {
            const sys = op.refund_system ? Layout.getName(op.refund_system) : '—';
            detailsHtml = `<span class="text-base-content/70 text-xs">${e(sys)}</span>`;
            if (op.refund_status === 'paid') {
                statusHtml = `<span class="text-emerald-600 text-xs">✓ ${e(t('crm_refund_paid'))}</span>`;
            } else {
                statusHtml = `<span class="text-amber-600 text-xs">⏳ ${e(t('crm_refund_pending'))}</span>`;
            }
        } else if (op.operation_type === 'donation') {
            if (op.donation_retreat) {
                detailsHtml = `<span class="badge badge-sm whitespace-nowrap" style="background-color:${e(op.donation_retreat.color || '#6b7280')};color:white;">${e(Layout.getName(op.donation_retreat))}</span>`;
            }
            statusHtml = op.is_confirmed
                ? `<span class="text-emerald-600 text-xs">✓</span>`
                : `<span class="text-amber-600 text-xs">○</span>`;
        }

        const actionsHtml = options.withActions ? renderRowActions(op) : '';
        return `
            <div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200/60 text-sm">
              <span class="text-base-content/50">${icon}</span>
              <span class="w-32 shrink-0">${e(typeLabel)}</span>
              <span class="font-mono w-24 shrink-0">${e(fmt(op.amount, op.currency))}</span>
              <span class="flex-1 min-w-0 truncate">${detailsHtml}</span>
              <span class="shrink-0">${statusHtml}</span>
              ${actionsHtml}
            </div>
        `;
    }

    function renderRowActions(op) {
        const buttons = [];
        const canConfirm = PrepaymentOps.canConfirmRefund();
        if (op.operation_type === 'refund' && op.refund_status === 'pending' && canConfirm) {
            buttons.push(`<button class="btn btn-ghost btn-xs text-emerald-600" data-action="mark-paid" data-id="${op.id}" title="${e(t('crm_mark_refund_paid'))}">${e(t('crm_mark_refund_paid'))}</button>`);
        }
        // удаление — всегда доступно (с проверкой внутри)
        buttons.push(`<button class="btn btn-ghost btn-xs text-error" data-action="delete-op" data-id="${op.id}" title="Удалить">✕</button>`);
        return `<div class="shrink-0 flex gap-1">${buttons.join('')}</div>`;
    }

    // ---------------- Global event delegation for actions ----------------
    if (!window.__prepaymentOpsDelegated) {
        window.__prepaymentOpsDelegated = true;
        document.addEventListener('click', async (ev) => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action === 'mark-paid') {
                ev.preventDefault();
                const ok = await PrepaymentOps.markRefundPaid(id);
                if (ok) document.dispatchEvent(new CustomEvent('prepayment-ops:changed'));
            } else if (action === 'delete-op') {
                ev.preventDefault();
                const ok = await PrepaymentOps.deleteOperation(id);
                if (ok) document.dispatchEvent(new CustomEvent('prepayment-ops:changed'));
            } else if (action === 'confirm-op') {
                ev.preventDefault();
                const ok = await PrepaymentOps.confirmOperation(id);
                if (ok) document.dispatchEvent(new CustomEvent('prepayment-ops:changed'));
            }
        });
    }
})();
