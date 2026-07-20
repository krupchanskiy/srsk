// ==================== FIN-UTILS.JS ====================
// Общие утилиты финансового модуля: вызов RPC с контрактом {ok,...},
// форматирование денег, справочники, бейджи типов/статусов.

(function() {
'use strict';

const CURRENCY_SYMBOLS = { INR: '₹', RUB: '₽', USD: '$', EUR: '€' };

const refs = { loaded: false, currencies: [], accounts: [], categories: [], costCenters: [], objects: [], contractors: [] };

// Мелкие SVG-иконки для таблиц (правило проекта: только SVG, не эмодзи)
const ICONS = {
    clock: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3 inline"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    x: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
    check: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5 inline"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>'
};

const FinUtils = {
    refs,
    ICONS,

    newRequestId() {
        return crypto.randomUUID();
    },

    // Обёртка submit-хендлера: блокирует кнопку и показывает спиннер на время RPC
    lockedSubmit(handler) {
        return async ev => {
            ev.preventDefault();
            const btn = ev.submitter || ev.target.querySelector('button[type="submit"]');
            if (btn?.disabled) return;
            const old = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<span class="loading loading-spinner loading-xs"></span> ${old}`;
            }
            try { await handler(ev); }
            finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
        };
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
            let msg = res?.error?.message || res?.error?.code || 'Ошибка';
            // сетевую ошибку переводим с языка backend'а на язык пользователя
            if (res?.error?.code === 'network_error') msg = t('fin_network_error');
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

    // То же, но с цветом по знаку (единая денежная семантика: минус — красный, плюс — зелёный)
    fmtAmountsByCurrencyColored(map) {
        if (!map) return '—';
        return Object.entries(map)
            .map(([code, total]) => {
                const cls = Number(total) < 0 ? 'text-error' : Number(total) > 0 ? 'text-success' : '';
                return `<span class="${cls}">${this.fmtMoney(total, code)}</span>`;
            })
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

    // Опции селектов. Счета группируются: реальные / подотчётные
    accountOptions(selectedId, filter) {
        const e = s => Layout.escapeHtml(s);
        const opt = a => `<option value="${a.account_id}" data-currency="${e(a.currency_code)}" ${a.account_id === selectedId ? 'selected' : ''}>${e(a.name)} (${this.fmtMoney(a.balance, a.currency_code)})</option>`;
        const active = refs.accounts.filter(a => a.is_active && (!filter || filter(a)));
        const real = active.filter(a => a.kind === 'real');
        const custodial = active.filter(a => a.kind === 'custodial');
        if (!real.length || !custodial.length) return active.map(opt).join('');
        return `<optgroup label="${Layout.t('fin_real_accounts')}">${real.map(opt).join('')}</optgroup>` +
               `<optgroup label="${Layout.t('fin_custodial_group')}">${custodial.map(opt).join('')}</optgroup>`;
    },

    // withPlaceholder: пустая опция «— выберите статью —» первой, чтобы дефолтом
    // не оказывалась первая статья по алфавиту (защита от ошибочной аналитики)
    categoryOptions(direction, selectedId, withPlaceholder) {
        const e = s => Layout.escapeHtml(s);
        const opts = refs.categories
            .filter(c => c.is_active && c.direction === direction)
            .map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${e(c.name)}</option>`)
            .join('');
        return (withPlaceholder && !selectedId
            ? `<option value="" disabled selected>${Layout.t('fin_select_category')}</option>` : '') + opts;
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

    // ==================== ВЛОЖЕНИЯ ====================
    async sha256File(file) {
        const buf = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // Загрузить файл в finance-files и привязать к операции или объекту
    // учёта (parentType: 'operation' | 'accounting_object').
    // Путь: <uid>/<request_id>/<имя> (политика Storage требует свой префикс)
    async uploadAndAttach(file, operationId, postingId, parentType) {
        const uid = (await Layout.db.auth.getUser()).data?.user?.id;
        if (!uid) return { ok: false, error: { code: 'forbidden', message: 'Нет сессии' } };
        const requestId = this.newRequestId();
        // ключ Storage — только ASCII; оригинальное имя хранится в fin_attachments.file_name
        const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
        const base = file.name.slice(0, file.name.length - ext.length)
            .normalize('NFKD').replace(/[^A-Za-z0-9.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
        const path = `${uid}/${requestId}/${base || 'file'}${ext}`;
        const { error: upErr } = await Layout.db.storage.from('finance-files').upload(path, file, {
            contentType: file.type || 'application/octet-stream'
        });
        if (upErr) return { ok: false, error: { code: 'upload_failed', message: upErr.message } };
        return this.rpc('fin_create_attachment', {
            request_id: requestId,
            storage_path: path,
            parent_type: parentType || 'operation',
            parent_id: operationId,
            posting_id: postingId || null,
            file_name: file.name,
            sha256: await this.sha256File(file)
        });
    },

    async openAttachment(path) {
        const { data, error } = await Layout.db.storage.from('finance-files').createSignedUrl(path, 300);
        if (error || !data?.signedUrl) {
            Layout.showNotification(error?.message || 'Не удалось открыть файл', 'error');
            return;
        }
        window.open(data.signedUrl, '_blank');
    },

    // Список вложений (общий рендер для разворотов). Делегирование клика
    // вешает страница: [data-attachment-path] → FinUtils.openAttachment
    attachmentsHtml(atts) {
        if (!atts || !atts.length) return '';
        const e = s => Layout.escapeHtml(s);
        return `<div class="pt-2 flex flex-wrap gap-2">` + atts.map(a => `
            <button type="button" class="btn btn-ghost btn-xs gap-1" data-attachment-path="${e(a.storage_path)}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"/></svg>
                ${e(a.file_name)}
            </button>`).join('') + `</div>`;
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

    // Подключить автокомплит к паре input(text) + input(hidden).
    // Клавиатура: ↑/↓ — по списку, Enter — выбор, Esc — закрыть.
    attachPersonSearch(inputEl, hiddenEl, onlyWithUser) {
        const e = s => Layout.escapeHtml(s);
        let box = document.createElement('div');
        box.className = 'absolute z-50 bg-base-100 shadow-lg rounded-lg w-full hidden max-h-60 overflow-y-auto';
        inputEl.parentElement.style.position = 'relative';
        inputEl.parentElement.appendChild(box);
        inputEl.setAttribute('role', 'combobox');
        inputEl.setAttribute('aria-expanded', 'false');
        let activeIdx = -1;

        const close = () => { box.classList.add('hidden'); inputEl.setAttribute('aria-expanded', 'false'); activeIdx = -1; };
        const items = () => [...box.querySelectorAll('button[data-id]')];
        const pick = btn => {
            inputEl.value = btn.dataset.name;
            hiddenEl.value = hiddenEl.dataset.useUserId ? btn.dataset.user : btn.dataset.id;
            close();
        };
        const highlight = idx => {
            const list = items();
            list.forEach((b, i) => b.classList.toggle('bg-base-200', i === idx));
            if (list[idx]) list[idx].scrollIntoView({ block: 'nearest' });
        };

        const search = Layout.debounce(async () => {
            hiddenEl.value = '';
            const found = await FinUtils.searchPersons(inputEl.value.trim(), onlyWithUser);
            if (!found.length) { close(); return; }
            box.innerHTML = found.map(p =>
                `<button type="button" class="block w-full text-left px-3 py-2 hover:bg-base-200" data-id="${p.id}" data-user="${p.user_id || ''}" data-name="${e(p.name)}">${e(p.name)}</button>`
            ).join('');
            box.classList.remove('hidden');
            inputEl.setAttribute('aria-expanded', 'true');
            activeIdx = -1;
        }, 300);

        inputEl.addEventListener('input', search);
        inputEl.addEventListener('keydown', ev => {
            if (box.classList.contains('hidden')) return;
            const list = items();
            if (ev.key === 'ArrowDown') { ev.preventDefault(); activeIdx = Math.min(activeIdx + 1, list.length - 1); highlight(activeIdx); }
            else if (ev.key === 'ArrowUp') { ev.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(activeIdx); }
            else if (ev.key === 'Enter' && activeIdx >= 0) { ev.preventDefault(); pick(list[activeIdx]); }
            else if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
        });
        box.addEventListener('click', ev => {
            const btn = ev.target.closest('button[data-id]');
            if (btn) pick(btn);
        });
        // один общий слушатель на документ для всех автокомплитов страницы
        FinUtils._personBoxes = FinUtils._personBoxes || [];
        FinUtils._personBoxes.push({ inputEl, close });
        if (!FinUtils._personDocListener) {
            FinUtils._personDocListener = ev => FinUtils._personBoxes.forEach(p => {
                if (!p.inputEl.parentElement.contains(ev.target)) p.close();
            });
            document.addEventListener('click', FinUtils._personDocListener);
        }
    }
};

window.FinUtils = FinUtils;
})();
