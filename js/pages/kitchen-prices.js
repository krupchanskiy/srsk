// ==================== KITCHEN-PRICES.JS ====================
// Кухня → Цены: история закупочных цен продуктов и посуды по периодам.
// Запись только через RPC kitchen_set_price / kitchen_correct_price.

(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

const REASONS = ['supplier_change', 'new_purchase', 'fix_error', 'other'];

let products = [];
let categories = [];
let units = [];
let pricesByProduct = new Map();
let locationId = null;
let caps = { view: false, edit: false, correct: false };
let currentCategory = 'all';
let searchQuery = '';
let onlyWithoutPrice = false;
let priceMode = 'direct';   // 'direct' | 'package' — второй режим сам считает цену за единицу

// ==================== HELPERS ====================
function productName(p) {
    return p['name_' + Layout.currentLang] || p.name_ru || '';
}

function unitShort(code) {
    const u = units.find(x => x.code === code);
    return u ? (u['short_' + Layout.currentLang] || u.short_ru || u.code) : (code || '');
}

function money(v) {
    return Number(v).toLocaleString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU',
        { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₹';
}

function fmtDate(iso) {
    return DateUtils.formatDisplay(DateUtils.parseDate(iso));
}

function currentPrice(productId) {
    return (pricesByProduct.get(productId) || []).find(r => !r.valid_to) || null;
}

function errorText(error) {
    return error?.details || error?.message || t('error');
}

// ==================== ЦЕНА ПО УПАКОВКЕ ====================
// Вес/объём упаковки в закупочной единице продукта (только та же природа: вес↔вес, объём↔объём —
// штучные продукты этот режим не используют). Возвращает null, если посчитать нечем.
function unitRatio(code) {
    const u = units.find(x => x.code === code);
    return u ? Number(u.to_base_ratio) : null;
}

function packageUnitOptions(productUnit) {
    const baseType = units.find(u => u.code === productUnit)?.type;
    return units.filter(u => u.type === baseType);
}

function computePackagePrice(amount, packageUnit, productUnit, packagePrice) {
    const ru = unitRatio(packageUnit), rp = unitRatio(productUnit);
    if (!(amount > 0) || !ru || !rp || !(packagePrice >= 0)) return null;
    const qtyInProductUnit = (amount * ru) / rp;
    return qtyInProductUnit > 0 ? packagePrice / qtyInProductUnit : null;
}

// ==================== DATA ====================
async function loadCaps() {
    const { data: { session } } = await Layout.db.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const check = async code => {
        const { data } = await Layout.db.rpc('kitchen_has_permission', { p_user: uid, p_code: code });
        return data === true;
    };
    const [view, edit, correct] = await Promise.all([check('view_prices'), check('edit_prices'), check('edit_archived_prices')]);
    caps = { view: view || edit || correct, edit, correct };
}

async function loadReference() {
    categories = await Cache.getOrLoad('product_categories', async () => {
        const { data } = await Layout.db.from('product_categories').select('*').order('name_ru');
        return data;
    }) || [];
    units = await Cache.getOrLoad('units', async () => {
        const { data } = await Layout.db.from('units').select('*').order('sort_order');
        return data;
    }) || [];
    const main = (Layout.locations || []).find(l => l.slug === 'main');
    locationId = main?.id || null;
}

async function loadProducts() {
    const { data, error } = await Layout.db
        .from('products')
        .select('id, name_ru, name_en, name_hi, unit, category_id, product_categories(slug, name_ru, name_en, name_hi)')
        .order('name_ru');
    if (error) { Layout.handleError(error, t('loading')); return; }
    products = data || [];
}

async function loadPrices() {
    pricesByProduct = new Map();
    let from = 0;
    const size = 1000;
    while (true) {
        const { data, error } = await Layout.db
            .from('kitchen_prices')
            .select('id, product_id, price, valid_from, valid_to, reason_category, comment, created_at')
            .eq('location_id', locationId)
            .order('valid_from', { ascending: false })
            .range(from, from + size - 1);
        if (error) { Layout.handleError(error, t('loading')); return; }
        (data || []).forEach(r => {
            if (!pricesByProduct.has(r.product_id)) pricesByProduct.set(r.product_id, []);
            pricesByProduct.get(r.product_id).push(r);
        });
        if (!data || data.length < size) break;
        from += size;
    }
}

// ==================== RENDER ====================
function renderCategoryFilters() {
    const counts = { all: products.length };
    products.forEach(p => {
        const slug = p.product_categories?.slug;
        if (slug) counts[slug] = (counts[slug] || 0) + 1;
    });
    let html = `<button class="btn btn-sm ${currentCategory === 'all' ? 'btn-neutral' : 'btn-ghost'}" data-action="filter-category" data-category="all">${t('all')}<sup class="ml-1 opacity-60">${counts.all}</sup></button>`;
    categories.forEach(cat => {
        html += `<button class="btn btn-sm ${currentCategory === cat.slug ? 'btn-neutral' : 'btn-ghost'}" data-action="filter-category" data-category="${e(cat.slug)}">${e(Layout.getName(cat))}<sup class="ml-1 opacity-60">${counts[cat.slug] || 0}</sup></button>`;
    });
    Layout.$('#categoryFilters').innerHTML = html;
}

function renderTable() {
    const q = searchQuery.toLowerCase();
    const filtered = products.filter(p => {
        if (currentCategory !== 'all' && p.product_categories?.slug !== currentCategory) return false;
        if (onlyWithoutPrice && currentPrice(p.id)) return false;
        if (!q) return true;
        return [p.name_ru, p.name_en, p.name_hi].some(n => n && n.toLowerCase().includes(q));
    });

    const withPrice = products.filter(p => currentPrice(p.id)).length;
    Layout.$('#pricesCount').textContent =
        `${t('prices_products_total')}: ${products.length} · ${t('prices_without_price')}: ${products.length - withPrice}`;

    const tbody = Layout.$('#pricesTable');
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center opacity-60 py-6">${t('prices_nothing_found')}</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(p => {
        const cur = currentPrice(p.id);
        const hasHistory = (pricesByProduct.get(p.id) || []).length > 0;
        const priceCell = cur
            ? `<span class="font-semibold">${e(money(cur.price))}</span>`
            : `<span class="badge badge-warning badge-sm">${t('prices_no_price')}</span>`;
        const since = cur ? fmtDate(cur.valid_from) : '—';
        return `
            <tr class="hover:bg-base-200/40">
                <td class="font-medium">${e(productName(p))}</td>
                <td class="hidden sm:table-cell text-sm opacity-70">${p.product_categories ? e(Layout.getName(p.product_categories)) : ''}</td>
                <td class="text-sm">${e(unitShort(p.unit))}</td>
                <td class="text-right">${priceCell}</td>
                <td class="hidden sm:table-cell text-sm opacity-70">${e(since)}</td>
                <td class="text-right whitespace-nowrap">
                    ${hasHistory ? `<button class="btn btn-ghost btn-xs" data-action="history" data-id="${p.id}">${t('prices_history')}</button>` : ''}
                    ${caps.edit ? `<button class="btn btn-primary btn-xs" data-action="new-price" data-id="${p.id}">${cur ? t('prices_change') : t('prices_set')}</button>` : ''}
                </td>
            </tr>`;
    }).join('');
}

function reasonLabel(code) {
    return t('prices_reason_' + code);
}

// ==================== MODALS ====================
function setPriceMode(mode) {
    priceMode = mode;
    Layout.$('#priceModeTabs').querySelectorAll('[data-price-mode]').forEach(tab =>
        tab.classList.toggle('tab-active', tab.dataset.priceMode === mode));
    Layout.$('#directPriceField').classList.toggle('hidden', mode !== 'direct');
    Layout.$('#packageFields').classList.toggle('hidden', mode !== 'package');
}

function renderPackageComputed() {
    const form = Layout.$('#priceForm');
    const p = products.find(x => x.id === form.product_id.value);
    if (!p) return;
    const price = computePackagePrice(
        parseFloat(form.package_amount.value), form.package_unit.value, p.unit, parseFloat(form.package_price.value));
    Layout.$('#packageComputed').innerHTML = price === null
        ? `<span class="opacity-50">${t('prices_package_fill_hint')}</span>`
        : `${t('prices_package_result')}: <span class="font-semibold">${money(price)} / ${e(unitShort(p.unit))}</span>`;
}

function openPriceModal(productId) {
    const p = products.find(x => x.id === productId);
    if (!p) return;
    const form = Layout.$('#priceForm');
    form.reset();
    form.product_id.value = productId;
    const today = DateUtils.toISO(new Date());
    form.valid_from_direct.value = today;
    form.valid_from_package.value = today;
    const cur = currentPrice(productId);
    if (cur) form.price.value = cur.price;
    Layout.$('#priceModalProduct').textContent = `${productName(p)} (${unitShort(p.unit)})`;
    Layout.$('#firstPriceHint').classList.toggle('hidden', (pricesByProduct.get(productId) || []).length > 0);
    Layout.$('#reasonSelect').innerHTML = REASONS.map(r => `<option value="${r}">${e(reasonLabel(r))}</option>`).join('');

    const packageUnits = packageUnitOptions(p.unit);
    Layout.$('#packageUnitSelect').innerHTML = packageUnits.map(u =>
        `<option value="${u.code}" ${u.code === p.unit ? 'selected' : ''}>${e(u['short_' + Layout.currentLang] || u.short_ru)}</option>`).join('');
    setPriceMode('direct');
    Layout.$('#priceModeTabs').classList.toggle('hidden', packageUnits.length < 2);
    renderPackageComputed();
    Layout.$('#priceModal').showModal();
}

async function savePrice(ev) {
    ev.preventDefault();
    const form = ev.target;
    const p = products.find(x => x.id === form.product_id.value);

    let price, validFrom, comment = form.comment.value.trim() || null;
    if (priceMode === 'package') {
        const amount = parseFloat(form.package_amount.value);
        const packageUnit = form.package_unit.value;
        const packagePrice = parseFloat(form.package_price.value);
        price = computePackagePrice(amount, packageUnit, p.unit, packagePrice);
        if (price === null) { Layout.showNotification(t('prices_package_incomplete'), 'error'); return; }
        validFrom = form.valid_from_package.value;
        if (!comment) comment = `${t('prices_package_label')}: ${amount} ${unitShort(packageUnit)} × ${money(packagePrice)}`;
    } else {
        price = parseFloat(form.price.value);
        validFrom = form.valid_from_direct.value;
        if (!(price >= 0)) { Layout.showNotification(t('prices_price_required'), 'error'); return; }
    }
    if (!validFrom) { Layout.showNotification(t('prices_date_required'), 'error'); return; }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { error } = await Layout.db.rpc('kitchen_set_price', {
        p_product_id: form.product_id.value,
        p_location_id: locationId,
        p_price: price,
        p_valid_from: validFrom,
        p_reason_category: form.reason_category.value,
        p_comment: comment
    });
    btn.disabled = false;
    if (error) {
        Layout.showNotification(errorText(error), 'error');
        return;
    }
    Layout.$('#priceModal').close();
    Layout.showNotification(t('saved'), 'success');
    await loadPrices();
    renderTable();
}

async function openHistory(productId) {
    const p = products.find(x => x.id === productId);
    if (!p) return;
    Layout.$('#historyProduct').textContent = `${productName(p)} (${unitShort(p.unit)})`;
    const rows = pricesByProduct.get(productId) || [];

    let corrections = [];
    if (rows.length) {
        const { data } = await Layout.db
            .from('kitchen_price_corrections')
            .select('price_id, old_price, new_price, reason, corrected_at')
            .in('price_id', rows.map(r => r.id))
            .order('corrected_at');
        corrections = data || [];
    }

    Layout.$('#historyBody').innerHTML = rows.map(r => {
        const period = r.valid_to
            ? `${fmtDate(r.valid_from)} — ${fmtDate(r.valid_to)}`
            : `${t('prices_col_since')} ${fmtDate(r.valid_from)}`;
        const log = corrections.filter(c => c.price_id === r.id).map(c =>
            `<div class="text-xs opacity-60">${t('prices_was')} ${e(money(c.old_price))} → ${t('prices_became')} ${e(money(c.new_price))}: ${e(c.reason)}</div>`).join('');
        return `
            <div class="border border-base-200 rounded-lg p-3 flex justify-between items-start gap-3 ${r.valid_to ? '' : 'bg-base-200/40'}">
                <div>
                    <div class="font-semibold">${e(money(r.price))}
                        ${r.valid_to ? '' : `<span class="badge badge-success badge-sm ml-1">${t('prices_current')}</span>`}</div>
                    <div class="text-sm opacity-70">${e(period)}</div>
                    <div class="text-xs opacity-60">${e(reasonLabel(r.reason_category))}${r.comment ? ' · ' + e(r.comment) : ''}</div>
                    ${log}
                </div>
                ${caps.correct ? `<button class="btn btn-ghost btn-xs" data-action="correct" data-id="${r.id}" data-product="${productId}">${t('prices_correct')}</button>` : ''}
            </div>`;
    }).join('');
    Layout.$('#historyModal').showModal();
}

function openCorrect(priceId, productId) {
    const row = (pricesByProduct.get(productId) || []).find(r => r.id === priceId);
    if (!row) return;
    const form = Layout.$('#correctForm');
    form.reset();
    form.price_id.value = priceId;
    form.new_price.value = row.price;
    Layout.$('#correctInfo').textContent =
        `${money(row.price)} · ${fmtDate(row.valid_from)}${row.valid_to ? ' — ' + fmtDate(row.valid_to) : ''}`;
    Layout.$('#historyModal').close();
    Layout.$('#correctModal').showModal();
}

async function saveCorrection(ev) {
    ev.preventDefault();
    const form = ev.target;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { error } = await Layout.db.rpc('kitchen_correct_price', {
        p_price_id: form.price_id.value,
        p_new_price: parseFloat(form.new_price.value),
        p_reason: form.reason.value
    });
    btn.disabled = false;
    if (error) {
        Layout.showNotification(errorText(error), 'error');
        return;
    }
    Layout.$('#correctModal').close();
    Layout.showNotification(t('saved'), 'success');
    await loadPrices();
    renderTable();
}

// ==================== EVENTS ====================
document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
        case 'filter-category':
            currentCategory = btn.dataset.category;
            renderCategoryFilters();
            renderTable();
            break;
        case 'new-price': openPriceModal(btn.dataset.id); break;
        case 'history': openHistory(btn.dataset.id); break;
        case 'correct': openCorrect(btn.dataset.id, btn.dataset.product); break;
        case 'close-modal': Layout.$('#' + btn.dataset.modal).close(); break;
    }
    const modeTab = ev.target.closest('[data-price-mode]');
    if (modeTab) setPriceMode(modeTab.dataset.priceMode);
});

document.addEventListener('input', ev => {
    if (['package_amount', 'package_unit', 'package_price'].includes(ev.target.name)) renderPackageComputed();
});
document.addEventListener('change', ev => {
    if (ev.target.name === 'package_unit') renderPackageComputed();
});

function updateUI() {
    Layout.updateAllTranslations();
    renderCategoryFilters();
    renderTable();
}
window.onLanguageChange = () => updateUI();

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'prices' });
    await loadCaps();

    if (!caps.view) {
        Layout.$('#noAccess').classList.remove('hidden');
        Layout.$('#pricesContent').classList.add('hidden');
        Layout.$('#pricesCount').textContent = '';
        return;
    }

    await loadReference();
    if (!locationId) {
        Layout.showNotification(t('error'), 'error');
        return;
    }
    await Promise.all([loadProducts(), loadPrices()]);

    Layout.$('#priceForm').addEventListener('submit', savePrice);
    Layout.$('#correctForm').addEventListener('submit', saveCorrection);
    Layout.$('#searchInput').addEventListener('input', Layout.debounce(ev => {
        searchQuery = ev.target.value.trim();
        renderTable();
    }, 200));
    Layout.$('#onlyWithoutPrice').addEventListener('change', ev => {
        onlyWithoutPrice = ev.target.checked;
        renderTable();
    });

    updateUI();
}

init();

})();
