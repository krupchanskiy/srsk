// ==================== FIN-UTILS.JS ====================
// Общие утилиты финансового модуля: вызов RPC с контрактом {ok,...},
// форматирование денег, справочники, бейджи типов/статусов.

(function() {
'use strict';

const CURRENCY_SYMBOLS = { INR: '₹', RUB: '₽', USD: '$', EUR: '€' };

// « (02.08–30.09.2026)» по датам ретрита; строки YYYY-MM-DD режем без Date —
// никаких сдвигов таймзоны. «Гости без события» хранят заглушку 2000-01-01 — без дат.
function objectDatesLabel(o) {
    const s = o.retreat?.start_date, f = o.retreat?.end_date;
    if (!s || !f || s.startsWith('2000-')) return '';
    const dm = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const from = s.slice(0, 4) === f.slice(0, 4) ? dm(s) : `${dm(s)}.${s.slice(0, 4)}`;
    return ` (${from}–${dm(f)}.${f.slice(0, 4)})`;
}

const OBJECT_RECENT_DAYS = 60;
const OBJECT_SHOW_PAST = '__show_past__';
const OBJECT_GROUP_RU = {
    fin_object_group_current: 'Идут и предстоящие',
    fin_object_group_recent: 'Недавно прошли',
    fin_object_group_past: 'Прошедшие',
    fin_object_show_past: 'Показать прошедшие…'
};
// У кого переводы закэшированы до миграции 602 — Layout.t вернёт сам ключ
function trOr(key) {
    const v = Layout.t(key);
    return v === key ? OBJECT_GROUP_RU[key] : v;
}

// «Показать прошедшие…» — раскрываем архив в этом же списке. Ловим на захвате,
// до обработчиков страницы: служебное значение не должно дойти ни до них, ни до сохранения.
document.addEventListener('change', ev => {
    const sel = ev.target;
    if (!(sel instanceof HTMLSelectElement) || sel.value !== OBJECT_SHOW_PAST) return;
    ev.stopPropagation();
    sel.innerHTML = FinUtils.objectOptions(null, { all: true });
    sel.value = '';
    sel.focus();
    sel.showPicker?.();
}, true);

const refs = { loaded: false, currencies: [], accounts: [], categories: [], costCenters: [], objects: [], contractors: [] };

// Кэш дат ретритов для подсказки «ближайший ретрит» (касса кафе, сен 2026)
let retreatRanges = null;

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

    // Общий курс устарел (ВГ, 28.09): старше 3 дней — жёлтое оповещение, 7 — красное.
    // Смотрим последнюю дату по каждой валюте; оповещение — по самой старой.
    // Возвращает HTML плашки или '' (курс свежий / нет прав на чтение курсов)
    async staleRateAlert(currencies = null) {
        const { data, error } = await Layout.db.from('fin_v_exchange_rates')
            .select('from_currency, effective_date').is('object_id', null);
        if (error || !data?.length) return '';
        const последняя = {};
        for (const r of data) {
            if (currencies && !currencies.includes(r.from_currency)) continue;
            if (!последняя[r.from_currency] || r.effective_date > последняя[r.from_currency]) последняя[r.from_currency] = r.effective_date;
        }
        const сегодня = DateUtils.parseDate(DateUtils.toISO(new Date()));
        const старые = Object.entries(последняя)
            .map(([cur, d]) => ({ cur, d, дней: Math.round((сегодня - DateUtils.parseDate(d)) / 864e5) }))
            .filter(x => x.дней > 3)
            .sort((a, b) => b.дней - a.дней);
        if (!старые.length) return '';
        const красное = старые[0].дней > 7;
        const список = старые.map(x => `${FinUtils.symbol(x.cur)} от ${DateUtils.formatShort(DateUtils.parseDate(x.d))} (${Layout.pluralize(x.дней, { ru: ['день', 'дня', 'дней'], en: ['day', 'days'], hi: 'दिन' })})`).join(' · ');
        return `<div class="alert ${красное ? 'alert-error' : 'alert-warning'} py-2 text-sm">
            <span>⚠ Общий курс устарел: ${список}. По нему считаются гости без события и события без своего курса.</span>
            <a href="dictionaries.html?tab=rates" class="btn btn-sm">Обновить курс</a>
        </div>`;
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
            // Обрыв связи приходит без кода PostgREST. Всё, у чего код есть, — это ответ
            // сервера, и его нужно показать: иначе человек перезагружает страницу впустую.
            if (!error.code) {
                return { ok: false, error: { code: 'network_error', message: error.message } };
            }
            return { ok: false, error: {
                code: error.code,
                message: error.message || error.details || error.hint || error.code
            } };
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
        const [cur, acc, cat, cc, obj, con, ret, fact] = await Promise.all([
            Layout.db.from('fin_v_currencies').select('*'),
            Layout.db.from('fin_v_account_balances').select('*').order('name'),
            Layout.db.from('fin_v_categories').select('*').order('name'),
            Layout.db.from('fin_v_cost_centers').select('*').order('name'),
            Layout.db.from('fin_v_accounting_objects').select('*').order('created_at', { ascending: false }),
            Layout.db.from('fin_v_contractors').select('*').order('name'),
            Layout.db.from('retreats').select('id, start_date, end_date'),
            Layout.db.from('retreat_fact_end').select('retreat_id, fact_end')
        ]);
        refs.currencies = cur.data || [];
        refs.accounts = acc.data || [];
        refs.categories = cat.data || [];
        refs.costCenters = cc.data || [];
        // Даты ретрита — в подпись объекта: два «Ретрита Художников» иначе не различить
        // fact_end — фактическое окончание (последний выезд гостей ретрита, миграция 603):
        // по нему ретрит считается идущим/недавно прошедшим. Нет доступа к местам — плановое окончание.
        const retreatById = new Map((ret.data || []).map(r => [r.id, r]));
        const factById = new Map((fact.data || []).map(f => [f.retreat_id, f.fact_end]));
        refs.objects = (obj.data || []).map(o => {
            const retreat = retreatById.get(o.retreat_id) || null;
            return { ...o, retreat, fact_end: factById.get(o.retreat_id) || retreat?.end_date || null };
        });
        refs.contractors = con.data || [];
        refs.loaded = true;
        return refs;
    },

    async reloadAccounts() {
        const { data } = await Layout.db.from('fin_v_account_balances').select('*').order('name');
        refs.accounts = data || [];
        return refs.accounts;
    },

    // ---- Касса кафе: подсказка ближайшего ретрита по дате (ВГ, сен 2026) ----
    // Приход/расход кафе почти всегда относится к текущему или ближайшему ретриту,
    // но ручной выбор из списка легко промахнуть. Ниже — только подсказка (можно
    // поправить вручную), не жёсткое правило.
    CAFE_CATEGORY_NAME: 'Касса кафе',

    isCafeCategory(categoryId) {
        return refs.categories.find(c => c.id === categoryId)?.name === this.CAFE_CATEGORY_NAME;
    },

    // Кафе не выделено отдельным кост-центром в справочнике — сейчас его выдаёт
    // только название счёта («Кафе (₹)», «Кафе (₽)», «...Касса кафе...»)
    isCafeAccount(accountId) {
        const a = refs.accounts.find(x => x.account_id === accountId);
        return !!a && /кафе/i.test(a.name);
    },

    isCafeDepartmentName(name) {
        return (name || '').trim() === 'Кафе';
    },

    async loadRetreatRanges() {
        if (retreatRanges) return retreatRanges;
        // cafe_eligible = false — ретрит вне подсчёта кафе (внутренний проект,
        // который ашрам финансирует сам, напр. «Ретрит Художников»)
        const { data } = await Layout.db.from('retreats')
            .select('id, start_date, end_date')
            .eq('cafe_eligible', true);
        const byRetreat = new Map((data || []).map(r => [r.id, r]));
        retreatRanges = refs.objects
            .filter(o => o.retreat_id && !o.is_closed && byRetreat.has(o.retreat_id))
            .map(o => ({ object_id: o.id, ...byRetreat.get(o.retreat_id) }));
        return retreatRanges;
    },

    // Ближайший по датам ретрит: 0, если дата внутри диапазона. При пересечении
    // диапазонов (два ретрита идут внахлёст) из нескольких с дистанцией 0
    // побеждает тот, что начался позже — как правило, это более узкое,
    // вложенное событие, а не широкое «фоновое» окно с более ранним стартом
    async nearestRetreatObject(dateStr) {
        if (!dateStr) return null;
        const ranges = await this.loadRetreatRanges();
        if (!ranges.length) return null;
        const target = new Date(dateStr);
        let best = null, bestDist = Infinity, bestStart = null;
        for (const r of ranges) {
            const start = new Date(r.start_date), end = new Date(r.end_date);
            const dist = target < start ? (start - target) : (target > end ? (target - end) : 0);
            if (dist < bestDist || (dist === bestDist && start > bestStart)) {
                best = r.object_id; bestDist = dist; bestStart = start;
            }
        }
        return best;
    },

    // Справочники грузятся один раз на страницу, поэтому только что созданная
    // статья не появлялась в наборе департамента до перезагрузки страницы
    // (замечание ВГ 05.08.2026: «добавил статью — её нет в списке набора»).
    async refreshRefs() {
        refs.loaded = false;
        retreatRanges = null;
        return await this.loadRefs();
    },

    // Опции селектов. Счета группируются: реальные / подотчётные.
    // prefer — вес приоритета: счета с большим весом идут первыми в своей группе.
    // Булев результат тоже принимается (true = 1). Чек-лист ВГ v3, п.4: канал
    // «наличные» ставит кассы выше онлайн-счетов, а рупиевую кассу — первой.
    accountOptions(selectedId, filter, prefer) {
        const e = s => Layout.escapeHtml(s);
        const opt = a => `<option value="${a.account_id}" data-currency="${e(a.currency_code)}" ${a.account_id === selectedId ? 'selected' : ''}>${e(a.name)} (${this.fmtMoney(a.balance, a.currency_code)})</option>`;
        const active = refs.accounts.filter(a => a.is_active && (!filter || filter(a)));
        if (prefer) active.sort((a, b) => Number(prefer(b)) - Number(prefer(a)));
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

    // Ретриты группами (ВГ, 01.10.2026): «Гости без события» наверху, затем
    // идущие и предстоящие, затем недавно прошедшие (до 60 дней после фактического
    // окончания — последнего выезда гостей ретрита, а не даты в карточке). Закрытые и
    // давно прошедшие — в архиве, раскрывается пунктом «Показать прошедшие…».
    // Выбранный ретрит виден всегда, даже архивный — иначе привязка слетит.
    objectOptions(selectedId, { all = false } = {}) {
        const e = s => Layout.escapeHtml(s);
        const today = this.todayISO();
        const d = new Date(); d.setDate(d.getDate() - OBJECT_RECENT_DAYS);
        const recentFrom = DateUtils.toISO(d);
        const opt = o => `<option value="${o.id}" ${o.id === selectedId ? 'selected' : ''}>${e(o.display_name)}${objectDatesLabel(o)}${o.is_closed ? ` (${Layout.t('fin_object_closed')})` : ''}</option>`;
        const group = (key, list) => list.length ? `<optgroup label="${e(trOr(key))}">${list.map(opt).join('')}</optgroup>` : '';

        const top = [], current = [], recent = [], past = [];
        for (const o of refs.objects) {
            const start = o.retreat?.start_date, end = o.fact_end;
            if (start?.startsWith('2000-')) top.push(o);               // «Гости без события»
            else if (!end) current.push(o);
            else if (o.is_closed || end < recentFrom) past.push(o);
            else if (end < today) recent.push(o);
            else current.push(o);
        }
        current.sort((a, b) => (a.retreat?.start_date || '').localeCompare(b.retreat?.start_date || ''));
        recent.sort((a, b) => b.fact_end.localeCompare(a.fact_end));
        past.sort((a, b) => b.fact_end.localeCompare(a.fact_end));

        const pastShown = all ? past : past.filter(o => o.id === selectedId);
        const hasHidden = past.length > pastShown.length;
        return `<option value="">${Layout.t('fin_no_object')}</option>`
            + top.map(opt).join('')
            + group('fin_object_group_current', current)
            + group('fin_object_group_recent', recent)
            + group('fin_object_group_past', pastShown)
            + (hasHidden ? `<option value="${OBJECT_SHOW_PAST}">${e(trOr('fin_object_show_past'))}</option>` : '');
    },

    // Подставить ретрит из кода (подсказка по дате, открытие на правку): если он
    // в архиве и в списке его нет — перерисовываем список вместе с ним
    setObjectValue(sel, objectId) {
        if (!sel) return;
        if (objectId && ![...sel.options].some(o => o.value === objectId)) {
            sel.innerHTML = this.objectOptions(objectId);
        }
        sel.value = objectId || '';
    },

    contractorOptions(selectedId) {
        const e = s => Layout.escapeHtml(s);
        return '<option value="">—</option>' + refs.contractors
            .filter(c => c.is_active)
            .map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${e(c.name)}</option>`)
            .join('');
    },

    // Канал в формах ставится сам по счёту (ВГ, 28.09.2026). «Онлайн-перевод» не
    // предлагаем — для нас это то же, что карта; в старых записях он остаётся.
    // USDT подписан напрямую: перевод новый, а у людей кэш переводов живёт час.
    channelOptions(selected) {
        const label = c => c === 'usdt' ? 'USDT' : Layout.t('fin_channel_' + c);
        return '<option value="">—</option>' + ['cash', 'card', 'paypal', 'usdt']
            .map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${Layout.escapeHtml(label(c))}</option>`)
            .join('');
    },

    // Касса → наличные, PayPal → PayPal, USDT → USDT, остальное (ИП, карты) → карта.
    // Club108 — счёт только для передачи денег, канала у него нет.
    accountChannel(accountId) {
        const a = refs.accounts.find(x => x.account_id === accountId);
        if (!a) return '';
        if (a.reconciliation_mode === 'cash_count') return 'cash';
        if (/paypal/i.test(a.name)) return 'paypal';
        if (/usdt/i.test(a.name)) return 'usdt';
        if (/club\s*108/i.test(a.name)) return '';
        return 'card';
    },

    todayISO() {
        return DateUtils.toISO(new Date());
    },

    // Копирование текста в буфер (с фолбэком для небезопасного контекста)
    async copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch { return false; }
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
