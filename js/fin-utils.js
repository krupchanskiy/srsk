// ==================== FIN-UTILS.JS ====================
// Общие утилиты финансового модуля: вызов RPC с контрактом {ok,...},
// форматирование денег, справочники, бейджи типов/статусов.

(function() {
'use strict';

const CURRENCY_SYMBOLS = { INR: '₹', RUB: '₽', USD: '$', EUR: '€' };

const refs = { loaded: false, currencies: [], accounts: [], categories: [], costCenters: [], objects: [], contractors: [] };

const FinUtils = {
    refs,

    newRequestId() {
        return crypto.randomUUID();
    },

    // Вызов финансовой RPC: всегда возвращает {ok, result?, warnings?, error?}
    async rpc(name, payload) {
        const args = payload === undefined ? {} : { payload };
        const { data, error } = await Layout.db.rpc(name, args);
        if (error) {
            return { ok: false, error: { code: 'network_error', message: error.message } };
        }
        return data;
    },

    // Показ результата RPC: true если успех
    handleResult(res, successKey) {
        const t = k => Layout.t(k);
        if (!res || !res.ok) {
            const msg = res?.error?.message || res?.error?.code || 'Ошибка';
            Layout.showNotification(msg, 'error');
            return false;
        }
        if (res.warnings && res.warnings.length > 0) {
            Layout.showNotification(t('fin_saved_with_warnings') + ': ' + res.warnings.map(w => w.message).join('; '), 'warning');
        } else {
            Layout.showNotification(t(successKey || 'saved'), 'success');
        }
        return true;
    },

    symbol(code) {
        const cur = refs.currencies.find(c => c.code === code);
        return cur?.symbol || CURRENCY_SYMBOLS[code] || code;
    },

    fmtMoney(amount, currencyCode) {
        const n = Number(amount) || 0;
        const s = n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        return `${this.symbol(currencyCode)} ${s}`;
    },

    // Суммы операции по валютам из jsonb {INR: 100, USD: -5}
    fmtAmountsByCurrency(map) {
        if (!map) return '—';
        return Object.entries(map)
            .map(([code, total]) => this.fmtMoney(total, code))
            .join(' · ');
    },

    typeLabel(type) {
        return Layout.t('fin_type_' + type);
    },

    approvalBadge(approval) {
        const t = k => Layout.t(k);
        const cls = { pending: 'badge-warning', approved: 'badge-success', disputed: 'badge-error', not_required: 'badge-ghost' };
        if (approval === 'not_required') return '';
        return `<span class="badge badge-sm ${cls[approval] || 'badge-ghost'}">${t('fin_approval_' + approval)}</span>`;
    },

    channelLabel(channel) {
        return channel ? Layout.t('fin_channel_' + channel) : '';
    },

    // Загрузка справочников для форм (один раз на страницу)
    async loadRefs() {
        if (refs.loaded) return refs;
        const [cur, acc, cat, cc, obj, con] = await Promise.all([
            Layout.db.from('fin_v_currencies').select('*'),
            Layout.db.from('fin_v_account_balances').select('*').order('name'),
            Layout.db.from('fin_v_categories').select('*').order('name'),
            Layout.db.from('fin_v_cost_centers').select('*').order('name'),
            Layout.db.from('fin_v_accounting_objects').select('*').order('created_at', { ascending: false }),
            Layout.db.from('fin_v_contractors').select('*').order('name')
        ]);
        refs.currencies = cur.data || [];
        refs.accounts = acc.data || [];
        refs.categories = cat.data || [];
        refs.costCenters = cc.data || [];
        refs.objects = obj.data || [];
        refs.contractors = con.data || [];
        refs.loaded = true;
        return refs;
    },

    async reloadAccounts() {
        const { data } = await Layout.db.from('fin_v_account_balances').select('*').order('name');
        refs.accounts = data || [];
        return refs.accounts;
    },

    // Опции селектов
    accountOptions(selectedId, filter) {
        const e = s => Layout.escapeHtml(s);
        return refs.accounts
            .filter(a => a.is_active && (!filter || filter(a)))
            .map(a => `<option value="${a.account_id}" data-currency="${e(a.currency_code)}" ${a.account_id === selectedId ? 'selected' : ''}>${e(a.name)} (${this.fmtMoney(a.balance, a.currency_code)})</option>`)
            .join('');
    },

    categoryOptions(direction, selectedId) {
        const e = s => Layout.escapeHtml(s);
        return refs.categories
            .filter(c => c.is_active && c.direction === direction)
            .map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${e(c.name)}</option>`)
            .join('');
    },

    costCenterOptions(selectedId) {
        const e = s => Layout.escapeHtml(s);
        return '<option value="">—</option>' + refs.costCenters
            .filter(c => c.is_active)
            .map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${e(c.name)}</option>`)
            .join('');
    },

    objectOptions(selectedId) {
        const e = s => Layout.escapeHtml(s);
        return `<option value="">${Layout.t('fin_no_object')}</option>` + refs.objects
            .map(o => `<option value="${o.id}" ${o.id === selectedId ? 'selected' : ''}>${e(o.display_name)}</option>`)
            .join('');
    },

    contractorOptions(selectedId) {
        const e = s => Layout.escapeHtml(s);
        return '<option value="">—</option>' + refs.contractors
            .filter(c => c.is_active)
            .map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${e(c.name)}</option>`)
            .join('');
    },

    channelOptions(selected) {
        const t = k => Layout.t(k);
        return '<option value="">—</option>' + ['cash', 'bank_transfer', 'card', 'paypal']
            .map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${t('fin_channel_' + c)}</option>`)
            .join('');
    },

    todayISO() {
        return DateUtils.toISO(new Date());
    },

    // Поиск людей (vaishnavas) для полей «жертвователь»/«ответственный»
    async searchPersons(query, onlyWithUser) {
        if (!query || query.length < 2) return [];
        let q = Layout.db.from('vaishnavas')
            .select('id, user_id, spiritual_name, first_name, last_name')
            .or(`spiritual_name.ilike.%${query}%,first_name.ilike.%${query}%,last_name.ilike.%${query}%`)
            .limit(10);
        if (onlyWithUser) q = q.not('user_id', 'is', null);
        const { data } = await q;
        return (data || []).map(v => ({
            id: v.id,
            user_id: v.user_id,
            name: v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim()
        }));
    },

    // Подключить автокомплит к паре input(text) + input(hidden)
    attachPersonSearch(inputEl, hiddenEl, onlyWithUser) {
        const e = s => Layout.escapeHtml(s);
        let box = document.createElement('div');
        box.className = 'absolute z-50 bg-base-100 shadow-lg rounded-lg w-full hidden max-h-60 overflow-y-auto';
        inputEl.parentElement.style.position = 'relative';
        inputEl.parentElement.appendChild(box);

        const search = Layout.debounce(async () => {
            hiddenEl.value = '';
            const items = await FinUtils.searchPersons(inputEl.value.trim(), onlyWithUser);
            if (!items.length) { box.classList.add('hidden'); return; }
            box.innerHTML = items.map(p =>
                `<button type="button" class="block w-full text-left px-3 py-2 hover:bg-base-200" data-id="${p.id}" data-user="${p.user_id || ''}" data-name="${e(p.name)}">${e(p.name)}</button>`
            ).join('');
            box.classList.remove('hidden');
        }, 300);

        inputEl.addEventListener('input', search);
        box.addEventListener('click', ev => {
            const btn = ev.target.closest('button[data-id]');
            if (!btn) return;
            inputEl.value = btn.dataset.name;
            hiddenEl.value = hiddenEl.dataset.useUserId ? btn.dataset.user : btn.dataset.id;
            box.classList.add('hidden');
        });
        document.addEventListener('click', ev => {
            if (!inputEl.parentElement.contains(ev.target)) box.classList.add('hidden');
        });
    }
};

window.FinUtils = FinUtils;
})();
