// ==================== ФИНАНСЫ: СПРАВОЧНИКИ ====================
// Табы: статьи / cost centers / контрагенты / курсы валют
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let currentTab = 'categories';
let rows = [];
let editingId = null;

const editIcon = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z"/></svg>`;

// ==================== ЗАГРУЗКА ====================
async function loadTab() {
    const body = document.getElementById('dictBody');
    body.innerHTML = `<tr><td colspan="6" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;

    const sources = {
        categories: () => Layout.db.from('fin_v_categories').select('*').order('name'),
        cost_centers: () => Layout.db.from('fin_v_cost_centers').select('*').order('name'),
        contractors: () => Layout.db.from('fin_v_contractors').select('*').order('name'),
        rates: () => Layout.db.from('fin_v_exchange_rates').select('*').order('effective_date', { ascending: false }).limit(200)
    };
    const { data, error } = await sources[currentTab]();
    if (error) { Layout.handleError(error, 'Справочники'); return; }
    rows = data || [];
    renderTab();
}

function activeBadge(row) {
    return row.is_active ? '' : ` <span class="badge badge-ghost badge-xs">${t('fin_archived')}</span>`;
}

let dictQuery = '';
let dictDir = '';   // '' | 'in' | 'out' (только для статей)

// Отфильтрованный по поиску/направлению срез rows
function filteredRows() {
    const q = dictQuery.trim().toLowerCase();
    return rows.filter(r => {
        if (currentTab === 'categories' && dictDir && r.direction !== dictDir) return false;
        if (!q) return true;
        const hay = [r.name, r.code, r.from_currency, r.object_name, r.contact_info].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    });
}

// «Действующий сейчас» курс = самый свежий (effective_date ≤ сегодня) для пары валюта|объект
function computeCurrentRateIds(list) {
    const today = FinUtils.todayISO();
    const seen = new Set(), current = new Set();
    // list уже отсортирован по effective_date desc
    for (const r of list) {
        const key = `${r.from_currency}|${r.object_id || ''}`;
        if (!seen.has(key) && r.effective_date <= today) { current.add(r.id); seen.add(key); }
    }
    return current;
}

function renderTab() {
    const head = document.getElementById('dictHead');
    const body = document.getElementById('dictBody');
    const view = filteredRows();
    const countEl = document.getElementById('dictCount');
    if (countEl) countEl.textContent = rows.length ? `${view.length} / ${rows.length}` : '';
    document.getElementById('dirFilter').style.display = currentTab === 'categories' ? '' : 'none';

    if (currentTab === 'categories') {
        head.innerHTML = `<tr><th>${t('col_code') || 'Код'}</th><th>${t('col_name') || 'Название'}</th><th>${t('fin_direction')}</th><th>${t('fin_visible_departments')}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
                <td class="font-mono">${e(r.code)}</td>
                <td>${e(r.name)}${activeBadge(r)}</td>
                <td><span class="badge badge-sm ${r.direction === 'in' ? 'badge-success' : 'badge-error'}">${t('fin_dir_' + r.direction)}</span></td>
                <td>${r.visible_to_departments ? FinUtils.ICONS.check : ''}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    } else if (currentTab === 'cost_centers') {
        head.innerHTML = `<tr><th>${t('col_code') || 'Код'}</th><th>${t('col_name') || 'Название'}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
                <td class="font-mono">${e(r.code)}</td>
                <td>${e(r.name)}${activeBadge(r)}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    } else if (currentTab === 'contractors') {
        head.innerHTML = `<tr><th>${t('col_name') || 'Название'}</th><th>${t('fin_person_org')}</th><th>${t('fin_comment')}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
                <td>${e(r.name)}${activeBadge(r)}</td>
                <td>${t(r.type === 'person' ? 'fin_person' : 'fin_organization')}</td>
                <td class="opacity-70">${e([r.contact_info, r.note].filter(Boolean).join(' · '))}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    } else {
        const currentIds = computeCurrentRateIds(rows);
        head.innerHTML = `<tr><th>${t('fin_currency')}</th><th>${t('fin_effective_date')}</th><th>${t('fin_rate')}</th><th>${t('fin_retreat_object')}</th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${currentIds.has(r.id) ? 'font-medium' : 'opacity-70'}">
                <td class="font-mono font-bold">${e(r.from_currency)}</td>
                <td>${DateUtils.formatShort(DateUtils.parseDate(r.effective_date))}${currentIds.has(r.id) ? ` <span class="badge badge-success badge-xs">${t('fin_rate_current')}</span>` : ''}</td>
                <td class="font-mono">${r.rate}</td>
                <td>${e(r.object_name || t('fin_general_rate'))}</td>
            </tr>`).join('');
    }
    if (!view.length) {
        const canAdd = currentTab !== 'rates' || window.hasPermission?.('fin_admin');
        const msg = rows.length ? t('fin_nothing_found') : t('fin_dict_empty');
        body.innerHTML = `<tr><td colspan="6" class="text-center py-10 opacity-60">
            <div class="mb-2">${msg}</div>
            ${!rows.length && canAdd ? `<button class="btn btn-primary btn-sm" onclick="FinDicts.openAdd()">${t('fin_add')}</button>` : ''}
        </td></tr>`;
    }
}

// ==================== ФОРМЫ ====================
function fieldHtml(id, labelKey, inputHtml) {
    return `<div class="form-control mb-2">
        <label class="label py-0"><span class="label-text">${t(labelKey)}</span></label>
        ${inputHtml}
    </div>`;
}

function openForm(row) {
    editingId = row?.id || null;
    const fields = document.getElementById('dictFields');
    const title = document.getElementById('dictModalTitle');
    title.textContent = t(row ? 'edit' : 'fin_add');

    if (currentTab === 'categories') {
        fields.innerHTML =
            fieldHtml('f_code', 'col_code', `<input type="text" id="f_code" class="input input-bordered input-sm" value="${e(row?.code || '')}" required>`) +
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            fieldHtml('f_dir', 'fin_direction', `<select id="f_dir" class="select select-bordered select-sm" ${row ? 'disabled' : ''}>
                <option value="in" ${row?.direction === 'in' ? 'selected' : ''}>${t('fin_dir_in')}</option>
                <option value="out" ${row?.direction === 'out' ? 'selected' : ''}>${t('fin_dir_out')}</option></select>`) +
            `<div class="form-control mb-2"><label class="label cursor-pointer justify-start gap-3 py-1">
                <input type="checkbox" id="f_visible" class="checkbox checkbox-sm" ${row?.visible_to_departments ? 'checked' : ''}>
                <span class="label-text">${t('fin_visible_departments')}</span></label></div>` +
            activeCheckbox(row);
    } else if (currentTab === 'cost_centers') {
        fields.innerHTML =
            fieldHtml('f_code', 'col_code', `<input type="text" id="f_code" class="input input-bordered input-sm" value="${e(row?.code || '')}" required>`) +
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            activeCheckbox(row);
    } else if (currentTab === 'contractors') {
        fields.innerHTML =
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            fieldHtml('f_type', 'fin_person_org', `<select id="f_type" class="select select-bordered select-sm">
                <option value="person" ${row?.type === 'person' ? 'selected' : ''}>${t('fin_person')}</option>
                <option value="organization" ${row?.type === 'organization' ? 'selected' : ''}>${t('fin_organization')}</option></select>`) +
            fieldHtml('f_info', 'fin_comment', `<input type="text" id="f_info" class="input input-bordered input-sm" value="${e(row?.contact_info || '')}">`) +
            activeCheckbox(row);
    } else {
        fields.innerHTML =
            fieldHtml('f_cur', 'fin_currency', `<select id="f_cur" class="select select-bordered select-sm">${
                FinUtils.refs.currencies.filter(c => c.is_active && c.code !== 'INR')
                    .map(c => `<option value="${c.code}">${e(c.symbol)} ${c.code}</option>`).join('')}</select>`) +
            fieldHtml('f_date', 'fin_effective_date', `<input type="date" id="f_date" class="input input-bordered input-sm" value="${FinUtils.todayISO()}" required>`) +
            fieldHtml('f_rate', 'fin_rate', `<input type="number" id="f_rate" class="input input-bordered input-sm" min="0.000001" step="0.000001" required>`) +
            fieldHtml('f_obj', 'fin_retreat_object', `<select id="f_obj" class="select select-bordered select-sm">
                <option value="">${t('fin_general_rate')}</option>${
                FinUtils.refs.objects.map(o => `<option value="${o.id}">${e(o.display_name)}</option>`).join('')}</select>`);
    }
    document.getElementById('dictModal').showModal();
}

function activeCheckbox(row) {
    return `<div class="form-control mb-2"><label class="label cursor-pointer justify-start gap-3 py-1">
        <input type="checkbox" id="f_active" class="checkbox checkbox-sm" ${!row || row.is_active ? 'checked' : ''}>
        <span class="label-text">${t('fin_active')}</span></label></div>`;
}

async function submitForm(ev) {
    ev.preventDefault();
    const val = id => document.getElementById(id)?.value;
    const checked = id => !!document.getElementById(id)?.checked;
    let res;

    if (currentTab === 'categories') {
        res = await FinUtils.rpc('fin_save_category', {
            id: editingId, code: val('f_code'), name: val('f_name'),
            direction: val('f_dir'), visible_to_departments: checked('f_visible'), is_active: checked('f_active')
        });
    } else if (currentTab === 'cost_centers') {
        res = await FinUtils.rpc('fin_save_cost_center', {
            id: editingId, code: val('f_code'), name: val('f_name'), is_active: checked('f_active')
        });
    } else if (currentTab === 'contractors') {
        res = await FinUtils.rpc('fin_save_contractor', {
            id: editingId, name: val('f_name'), type: val('f_type'),
            contact_info: val('f_info') || null, is_active: checked('f_active')
        });
    } else {
        res = await FinUtils.rpc('fin_save_exchange_rate', {
            object_id: val('f_obj') || null, effective_date: val('f_date'),
            from_currency: val('f_cur'), rate: val('f_rate')
        });
    }

    if (FinUtils.handleResult(res)) {
        document.getElementById('dictModal').close();
        await loadTab();
    }
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_dictionaries', itemId: 'fin_dictionaries' });
    await FinUtils.loadRefs();

    document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', () => {
        document.querySelectorAll('[role="tab"]').forEach(x => x.classList.remove('tab-active'));
        tab.classList.add('tab-active');
        currentTab = tab.dataset.tab;
        loadTab();
    }));

    document.getElementById('dictSearch').addEventListener('input', Layout.debounce(ev => {
        dictQuery = ev.target.value; renderTab();
    }, 200));
    document.querySelectorAll('#dirFilter [data-dir]').forEach(btn => btn.addEventListener('click', () => {
        dictDir = btn.dataset.dir;
        document.querySelectorAll('#dirFilter [data-dir]').forEach(b => b.classList.toggle('btn-active', b === btn));
        renderTab();
    }));

    document.getElementById('dictBody').addEventListener('click', ev => {
        const btn = ev.target.closest('[data-edit]');
        if (btn) openForm(rows.find(r => r.id === btn.dataset.edit));
    });

    document.getElementById('dictForm').addEventListener('submit', submitForm);
    await loadTab();
}

window.FinDicts = { openAdd: () => openForm(null) };
init();
})();
