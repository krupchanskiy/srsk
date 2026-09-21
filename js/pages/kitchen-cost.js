// ==================== KITCHEN-COST PAGE ====================
// Кухня → Себестоимость: прямые затраты по событиям и категориям за период.
// Расчёт — js/kitchen-cost.js, вкушающие — EatingUtils (byEvent).

(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов у пользователя не обновился, показываем русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

const CATEGORY_LABELS = {
    team: () => tr('status_team', 'Команда'),
    volunteers: () => tr('category_volunteer', 'Волонтёры'),
    vips: () => tr('category_vip', 'ВИП'),
    guests: () => tr('status_guest', 'Гости'),
    groups: () => tr('nav_groups', 'Группы'),
    expected: () => tr('expected_guests', 'Ожидаются')
};
const MEAL_LABELS = { breakfast: () => tr('breakfast', 'Завтрак'), lunch: () => tr('lunch', 'Обед') };

let locationId = null;
let caps = { view: false, edit: false };
let retreats = [];
let eventNames = new Map();
let lastResult = null;
let eventFilter = null;   // 'retreat:<id>' — показать только выбранный ретрит
let kits = { breakfast: [], lunch: [] };
let dishwareProducts = [];
let kitPrices = {};

// ==================== HELPERS ====================
function money(v) {
    return Number(v).toLocaleString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU',
        { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₹';
}
function money2(v) {
    return Number(v).toLocaleString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU',
        { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₹';
}
function fmtDay(iso) { return DateUtils.formatShort(DateUtils.parseDate(iso)); }
function errorText(error) { return error?.details || error?.message || t('error'); }

// ==================== ACCESS ====================
async function loadCaps() {
    const { data: { session } } = await Layout.db.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const check = async code => (await Layout.db.rpc('kitchen_has_permission', { p_user: uid, p_code: code })).data === true;
    const [view, edit, arch] = await Promise.all([check('view_prices'), check('edit_prices'), check('edit_archived_prices')]);
    caps = { view: view || edit || arch, edit };
}

// ==================== PERIOD ====================
function setPeriod(from, to) {
    Layout.$('#dateFrom').value = from;
    Layout.$('#dateTo').value = to;
}

function applyPreset(preset) {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + (preset === 'prev' ? -1 : 0), 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    Layout.$('#retreatSelect').value = '';
    eventFilter = null;
    setPeriod(DateUtils.toISO(first), DateUtils.toISO(last));
}

function renderRetreatSelect() {
    Layout.$('#retreatSelect').innerHTML = `<option value="">—</option>` + retreats.map(r =>
        `<option value="${r.id}">${e(Layout.getName(r))}</option>`).join('');
}

// ==================== CALCULATION ====================
async function loadEventNames(keys) {
    const groupIds = keys.filter(k => k.startsWith('group:')).map(k => k.slice(6));
    if (groupIds.length) {
        const { data } = await Layout.db.from('meal_groups').select('id, name').in('id', groupIds);
        (data || []).forEach(g => eventNames.set(`group:${g.id}`, g.name));
    }
    retreats.forEach(r => eventNames.set(`retreat:${r.id}`, Layout.getName(r)));
}

function eventLabel(key) {
    if (key === 'none') return tr('cost_no_event', 'Без события');
    return eventNames.get(key) || key;
}

async function calculate() {
    const from = Layout.$('#dateFrom').value;
    const to = Layout.$('#dateTo').value;
    if (!from || !to || from > to) { Layout.showNotification(tr('cost_bad_period', 'Проверьте даты периода'), 'error'); return; }
    if ((DateUtils.parseDate(to) - DateUtils.parseDate(from)) / 86400000 > 92) {
        Layout.showNotification(tr('cost_long_period', 'Период не длиннее трёх месяцев'), 'error');
        return;
    }

    Layout.showLoader();
    try {
        lastResult = await KitchenCost.calculate(Layout.db, locationId, from, to);
        await loadEventNames(Object.keys(lastResult.cells));
        renderResult();
        renderWarnings();
    } catch (err) {
        console.error('Cost calculation:', err);
        Layout.showNotification(errorText(err), 'error');
    } finally {
        Layout.hideLoader();
    }
}

// ==================== RENDER ====================
function renderResult() {
    const { cells, totals } = lastResult;
    const rows = [];
    let grand = { pm: 0, food: 0, dish: 0, ext: 0 };

    const eventKeys = Object.keys(cells).filter(k => !eventFilter || k === eventFilter).sort((a, b) => {
        if (a === 'none') return 1;
        if (b === 'none') return -1;
        return eventLabel(a).localeCompare(eventLabel(b), Layout.currentLang);
    });

    for (const key of eventKeys) {
        let sub = { pm: 0, food: 0, dish: 0, ext: 0 };
        for (const bucket of KitchenCost.BUCKETS) {
            const c = cells[key][bucket];
            if (!c || !c.personMeals) continue;
            const total = c.food + c.dishware + c.external;
            sub.pm += c.personMeals; sub.food += c.food; sub.dish += c.dishware; sub.ext += c.external;
            rows.push(`<tr>
                <td class="text-sm">${e(eventLabel(key))}</td>
                <td class="text-sm">${e(CATEGORY_LABELS[bucket]())}</td>
                <td class="text-right">${c.personMeals}</td>
                <td class="text-right">${money(c.food)}</td>
                <td class="text-right">${money(c.dishware)}</td>
                <td class="text-right">${money(c.external)}</td>
                <td class="text-right font-medium">${money(total)}</td>
                <td class="text-right">${money2(total / c.personMeals)}</td>
            </tr>`);
        }
        if (sub.pm) {
            const total = sub.food + sub.dish + sub.ext;
            rows.push(`<tr class="bg-base-200/60 font-semibold">
                <td colspan="2">${e(eventLabel(key))} — ${e(tr('cost_subtotal', 'итого'))}</td>
                <td class="text-right">${sub.pm}</td>
                <td class="text-right">${money(sub.food)}</td>
                <td class="text-right">${money(sub.dish)}</td>
                <td class="text-right">${money(sub.ext)}</td>
                <td class="text-right">${money(total)}</td>
                <td class="text-right">${money2(total / sub.pm)}</td>
            </tr>`);
        }
        grand.pm += sub.pm; grand.food += sub.food; grand.dish += sub.dish; grand.ext += sub.ext;
    }

    if (grand.pm) {
        const total = grand.food + grand.dish + grand.ext;
        rows.push(`<tr class="font-bold border-t-2 border-base-300">
            <td colspan="2">${e(tr('cost_grand_total', 'Всего за период'))}</td>
            <td class="text-right">${grand.pm}</td>
            <td class="text-right">${money(grand.food)}</td>
            <td class="text-right">${money(grand.dish)}</td>
            <td class="text-right">${money(grand.ext)}</td>
            <td class="text-right">${money(total)}</td>
            <td class="text-right">${money2(total / grand.pm)}</td>
        </tr>`);
    }
    if (totals.unallocated > 0 && !eventFilter) {
        rows.push(`<tr class="text-warning"><td colspan="6">${e(tr('cost_unallocated', 'Расходы приёмов пищи без вкушающих (не распределены)'))}</td>
            <td class="text-right">${money(totals.unallocated)}</td><td></td></tr>`);
    }

    Layout.$('#resultBody').innerHTML = rows.length ? rows.join('')
        : `<tr><td colspan="8" class="text-center opacity-60 py-6">${e(tr('cost_nothing', 'За период нет данных'))}</td></tr>`;
    Layout.$('#result').classList.remove('hidden');
}

function warningBox(title, items, cls = 'alert-warning') {
    if (!items.length) return '';
    const shown = items.slice(0, 8).map(x => `<li>${e(x)}</li>`).join('');
    const more = items.length > 8 ? `<li class="opacity-60">… ${items.length - 8}</li>` : '';
    return `<div class="alert ${cls} items-start text-sm"><div><div class="font-semibold">${e(title)}</div><ul class="list-disc ml-5 mt-1">${shown}${more}</ul></div></div>`;
}

function renderWarnings() {
    const w = lastResult.warnings;
    const names = lastResult.productNames;
    const parts = [];

    parts.push(warningBox(
        `${tr('cost_w_prices', 'Нет цены на дату приёма пищи, расход по этим продуктам не учтён')}: ${w.missingPrices.size}`,
        [...w.missingPrices.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${names[id] || id} (${n})`)));
    parts.push(warningBox(
        `${tr('cost_w_units', 'Не удалось перевести единицы (рецепт и продукт в несовместимых единицах), ингредиент не учтён')}: ${w.unresolvedUnits.size}`,
        [...w.unresolvedUnits.keys()].map(k => { const [p, a, b] = k.split('|'); return `${p}: ${a} → ${b}`; })));
    parts.push(warningBox(
        `${tr('cost_w_nomenu', 'Вкушающие есть, а приёма пищи в меню нет')}: ${w.noMenu.length}`,
        w.noMenu.map(s => { const [d, m] = s.split(' '); return `${fmtDay(d)} · ${MEAL_LABELS[m]()}`; }), 'alert-info'));
    parts.push(warningBox(
        `${tr('cost_w_mismatch', 'Порций в меню заметно больше или меньше, чем вкушающих (запас более 5)')}: ${w.mismatch.length}`,
        w.mismatch.map(x => `${fmtDay(x.date)} · ${MEAL_LABELS[x.meal]()}: ${tr('portions', 'порций')} ${x.portions}, ${tr('cost_eaters', 'вкушающих')} ${x.eaters}`), 'alert-info'));
    parts.push(warningBox(
        `${tr('cost_w_noeaters', 'Приём пищи с расходами, но без вкушающих')}: ${w.noEaters.length}`,
        w.noEaters.map(s => { const [d, m] = s.split(' '); return `${fmtDay(d)} · ${MEAL_LABELS[m]()}`; })));
    if (w.recipesNoOutput.size) {
        parts.push(warningBox(`${tr('cost_w_output', 'У рецептов не указан выход, масштаб не посчитан')}: ${w.recipesNoOutput.size}`, []));
    }
    Layout.$('#warnings').innerHTML = parts.join('');
}

// ==================== KIT ====================
async function loadKits() {
    const [{ data: kitRows }, { data: cat }] = await Promise.all([
        Layout.db.from('kitchen_portion_kits').select('meal_type, product_id, quantity').eq('location_id', locationId),
        Layout.db.from('product_categories').select('id').eq('slug', 'disposable').maybeSingle()
    ]);
    kits = { breakfast: [], lunch: [] };
    (kitRows || []).forEach(k => kits[k.meal_type]?.push(k));

    dishwareProducts = [];
    if (cat?.id) {
        const { data } = await Layout.db.from('products').select('id, name_ru, name_en, name_hi').eq('category_id', cat.id).order('name_ru');
        dishwareProducts = data || [];
    }
    const ids = dishwareProducts.map(p => p.id);
    kitPrices = {};
    if (ids.length) {
        const { data } = await Layout.db.from('kitchen_prices').select('product_id, price, valid_from, valid_to')
            .eq('location_id', locationId).in('product_id', ids);
        (data || []).forEach(r => (kitPrices[r.product_id] = kitPrices[r.product_id] || []).push(r));
    }
}

function productLabel(id) {
    const p = dishwareProducts.find(x => x.id === id);
    return p ? (p['name_' + Layout.currentLang] || p.name_ru) : id;
}

function renderKits() {
    const today = DateUtils.toISO(new Date());
    Layout.$('#kitBody').innerHTML = ['breakfast', 'lunch'].map(meal => {
        const items = kits[meal];
        const used = new Set(items.map(k => k.product_id));
        const free = dishwareProducts.filter(p => !used.has(p.id));
        const rows = items.map(k => {
            const price = KitchenCost.priceOn(kitPrices[k.product_id], today);
            return `<div class="flex items-center gap-2 py-1 border-b border-base-200">
                <span class="flex-1 text-sm">${e(productLabel(k.product_id))}</span>
                <span class="text-xs opacity-60 w-24 text-right">${price === null ? e(tr('prices_no_price', 'Нет цены')) : e(money2(price))}</span>
                <input type="number" min="0.05" step="0.05" value="${k.quantity}" class="input input-bordered input-xs w-20 text-right"
                       data-kit-qty data-meal="${meal}" data-product="${k.product_id}" ${caps.edit ? '' : 'disabled'} />
                ${caps.edit ? `<button class="btn btn-ghost btn-xs" data-action="kit-remove" data-meal="${meal}" data-product="${k.product_id}">✕</button>` : ''}
            </div>`;
        }).join('');
        const add = caps.edit && free.length ? `<div class="flex items-center gap-2 mt-2">
            <select class="select select-bordered select-xs flex-1" data-kit-add-product="${meal}">${free.map(p => `<option value="${p.id}">${e(productLabel(p.id))}</option>`).join('')}</select>
            <button class="btn btn-xs btn-outline" data-action="kit-add" data-meal="${meal}">+ ${e(tr('cost_kit_add', 'Добавить'))}</button>
        </div>` : '';
        return `<div><div class="font-medium mb-1">${e(MEAL_LABELS[meal]())}</div>${rows || `<div class="text-sm opacity-60">${e(tr('cost_kit_empty', 'Набор пуст'))}</div>`}${add}</div>`;
    }).join('');
}

async function saveKit(meal, productId, qty) {
    const { error } = await Layout.db.rpc('kitchen_set_kit_item', {
        p_location_id: locationId, p_meal_type: meal, p_product_id: productId, p_quantity: qty
    });
    if (error) { Layout.showNotification(errorText(error), 'error'); return false; }
    Layout.showNotification(t('saved'), 'success');
    await loadKits();
    renderKits();
    return true;
}

// ==================== EVENTS ====================
document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
        case 'preset': applyPreset(btn.dataset.preset); calculate(); break;
        case 'calculate': calculate(); break;
        case 'kit-remove': saveKit(btn.dataset.meal, btn.dataset.product, 0); break;
        case 'kit-add': {
            const sel = Layout.$(`[data-kit-add-product="${btn.dataset.meal}"]`);
            if (sel?.value) saveKit(btn.dataset.meal, sel.value, 1);
            break;
        }
    }
});

document.addEventListener('change', ev => {
    const input = ev.target.closest('[data-kit-qty]');
    if (input) {
        const qty = parseFloat(input.value);
        if (qty > 0) saveKit(input.dataset.meal, input.dataset.product, qty);
        return;
    }
    if (ev.target.id === 'retreatSelect') {
        const r = retreats.find(x => x.id === ev.target.value);
        if (r) { eventFilter = `retreat:${r.id}`; setPeriod(r.start_date, r.end_date); calculate(); }
        else { eventFilter = null; if (lastResult) renderResult(); }
        return;
    }
    if (ev.target.id === 'dateFrom' || ev.target.id === 'dateTo') {
        eventFilter = null;
        Layout.$('#retreatSelect').value = '';
    }
});

function updateUI() {
    Layout.updateAllTranslations();
    renderRetreatSelect();
    if (lastResult) { renderResult(); renderWarnings(); }
    renderKits();
}
window.onLanguageChange = () => updateUI();

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'cost' });
    await loadCaps();
    if (!caps.view) {
        Layout.$('#noAccess').classList.remove('hidden');
        return;
    }
    locationId = (Layout.locations || []).find(l => l.slug === 'main')?.id || null;
    if (!locationId) { Layout.showNotification(t('error'), 'error'); return; }

    const { data } = await Layout.db.from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date').order('start_date', { ascending: false });
    retreats = data || [];

    Layout.$('#costContent').classList.remove('hidden');
    await loadKits();
    applyPreset('month');
    updateUI();
    calculate();
}

init();

})();
