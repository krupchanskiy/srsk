// ==================== KITCHEN-DATA-CHECK.JS ====================
// Кухня → Проверка данных: все упущения кухни в одном месте (ВГ 04.11.2026).
// Каждый пункт — ссылкой туда, где его исправить. Расчёт — тот же, что у Себестоимости
// (js/kitchen-cost.js), за окно «прошлый месяц — неделя вперёд»; рецепты и люди — вообще, без периода.

const tr = (key, ru) => { const v = Layout.t(key); return v === key ? ru : v; };
const e = s => Layout.escapeHtml(s == null ? '' : String(s));

// Дорогой приём пищи: стоимость порции во столько раз выше обычной (медиана того же приёма в окне)
const MEAL_OUTLIER_RATIO = 3;

let locationId = null;
let canEditRecipes = false;
let data = null;          // всё, что показываем
const amountsShowChecked = { on: false };
const unitShort = new Map();   // код единицы → «кг», «л» на языке интерфейса
const us = code => unitShort.get(code) || code;

const fmtRatio = r => r >= 10 ? String(Math.round(r)) : r.toFixed(1).replace('.', ',');
const money = v => `₹${Math.round(v).toLocaleString('ru-RU')}`;
const fmtDay = d => DateUtils.parseDate(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', weekday: 'short' });
const mealName = m => m === 'breakfast' ? tr('breakfast', 'Завтрак') : tr('lunch', 'Обед');
const addDays = (iso, n) => { const d = DateUtils.parseDate(iso); d.setDate(d.getDate() + n); return DateUtils.toISO(d); };

// ==================== ЗАГРУЗКА ====================
async function fetchAll(makeQuery) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
        const { data: part, error } = await makeQuery().range(off, off + 999);
        if (error) throw error;
        rows.push(...(part || []));
        if (!part || part.length < 1000) break;
    }
    return rows;
}

// Ингредиенты тяжелее выхода блюда — по всем рецептам кухни, не только из меню
async function loadAmounts() {
    const [recipes, ings, unitRows, densRows] = await Promise.all([
        fetchAll(() => Layout.db.from('recipes').select('id, name_ru, name_en, name_hi, output_amount, output_unit').eq('location_id', locationId).order('id')),
        fetchAll(() => Layout.db.from('recipe_ingredients')
            .select('id, recipe_id, product_id, amount, unit, checked_amount, checked_unit, products(name_ru, name_en, name_hi, unit)').order('id')),
        fetchAll(() => Layout.db.from('units').select('code, type, to_base_ratio, short_ru, short_en, short_hi').order('code')),
        fetchAll(() => Layout.db.from('product_densities').select('*').order('product_id'))
    ]);
    const units = Object.fromEntries(unitRows.map(u => [u.code, { type: u.type, ratio: Number(u.to_base_ratio) }]));
    unitRows.forEach(u => unitShort.set(u.code, u[`short_${Layout.currentLang}`] || u.short_ru || u.code));
    const densities = Object.fromEntries(densRows.map(d => [d.product_id, d]));
    const byId = new Map(recipes.map(r => [r.id, r]));
    const out = [];
    for (const ing of ings) {
        const recipe = byId.get(ing.recipe_id);
        if (!recipe) continue;
        const one = { ...ing, unit: ing.unit || ing.products?.unit || 'g' };
        const s = KitchenCost.amountVsOutput(one, recipe, densities, units);
        if (!s) continue;
        out.push({ id: ing.id, recipe, product: ing.products, amount: Number(ing.amount), unit: one.unit,
                   ratio: s.ratio, level: s.level, checked: KitchenCost.amountChecked(one) });
    }
    return out.sort((a, b) => b.ratio - a.ratio);
}

// Команда и волонтёры, которые живут сейчас или заедут, — без департамента на месте и в карточке
async function loadNoDept(today) {
    const { data: cats } = await Layout.db.from('resident_categories').select('id, slug');
    const catIds = (cats || []).filter(c => c.slug === 'team' || c.slug === 'volunteer').map(c => c.id);
    const rows = await fetchAll(() => Layout.db.from('residents')
        .select('id, vaishnava_id, guest_name, check_in, check_out, category_id, department_id, vaishnavas(spiritual_name, first_name, last_name)')
        .in('category_id', catIds).eq('status', 'confirmed').gte('check_out', today).is('department_id', null).order('check_in'));
    const vids = [...new Set(rows.map(r => r.vaishnava_id).filter(Boolean))];
    const hist = new Map();
    for (let i = 0; i < vids.length; i += 150) {
        const { data: h } = await Layout.db.from('vaishnava_departments').select('vaishnava_id, date_from, date_to').in('vaishnava_id', vids.slice(i, i + 150));
        (h || []).forEach(x => (hist.get(x.vaishnava_id) || hist.set(x.vaishnava_id, []).get(x.vaishnava_id)).push(x));
    }
    const team = new Set((cats || []).filter(c => c.slug === 'team').map(c => c.id));
    return rows.filter(r => {
        const d = r.check_in > today ? r.check_in : today;
        return !(hist.get(r.vaishnava_id) || []).some(x => (!x.date_from || x.date_from <= d) && (!x.date_to || x.date_to >= d));
    }).map(r => ({ ...r, isTeam: team.has(r.category_id),
                   name: r.vaishnavas ? (r.vaishnavas.spiritual_name || `${r.vaishnavas.first_name || ''} ${r.vaishnavas.last_name || ''}`.trim()) : (r.guest_name || '—') }));
}

async function load() {
    const today = DateUtils.toISO(new Date());
    // окно: с 1-го числа прошлого месяца по неделю вперёд
    const start = DateUtils.parseDate(today); start.setDate(1); start.setMonth(start.getMonth() - 1);
    const from = DateUtils.toISO(start);
    const to = addDays(today, 7);
    const [amounts, cost, noDept] = await Promise.all([
        loadAmounts(),
        KitchenCost.calculate(Layout.db, locationId, from, to),
        loadNoDept(today)
    ]);
    const w = cost.warnings;

    // Дорогие приёмы пищи: порция (продукты + посуда + готовое) против медианы того же приёма в окне
    const recs = cost.mealRecords.filter(r => !r.unallocated && r.eaters > 0 && r.date <= today)
        .map(r => ({ ...r, perPortion: (r.food + r.external) / r.eaters + r.dishwarePerEater }));
    const median = list => { const a = list.map(x => x.perPortion).filter(v => v > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
    const med = { breakfast: median(recs.filter(r => r.meal === 'breakfast')), lunch: median(recs.filter(r => r.meal === 'lunch')) };
    const expensive = recs.filter(r => med[r.meal] > 0 && r.perPortion >= med[r.meal] * MEAL_OUTLIER_RATIO)
        .map(r => {
            const top = Object.entries(r.foodByProduct || {}).sort((a, b) => b[1] - a[1])[0];
            const topName = top ? (top[0].startsWith('own_cook:') ? top[0].slice(9) : cost.productNames[top[0]] || '—') : null;
            return { ...r, ratio: r.perPortion / med[r.meal], median: med[r.meal], top: top ? { name: topName, sum: top[1] } : null };
        })
        .sort((a, b) => b.ratio - a.ratio);

    // Рецепты без выхода — имена
    const noOutputIds = [...w.recipesNoOutput];
    let noOutput = [];
    if (noOutputIds.length) {
        const { data: rr } = await Layout.db.from('recipes').select('id, name_ru, name_en, name_hi').in('id', noOutputIds);
        noOutput = rr || [];
    }

    data = {
        from, to, today, amounts, expensive, med, noDept, noOutput,
        missingPrices: [...w.missingPrices.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, name: cost.productNames[id] || id, n })),
        unresolved: [...w.unresolvedUnits.entries()].map(([k, n]) => { const [p, a, b] = k.split('|'); return { p, a, b, n }; }),
        noMenu: w.noMenu.map(s => { const [d, m] = s.split(' '); return { d, m }; }).filter(x => x.d <= today)
    };
}

// ==================== ОТРИСОВКА ====================
function section(id, title, items, body, opts = {}) {
    const n = items.length;
    const cls = !n ? 'border-success/40' : opts.error ? 'border-error' : 'border-warning';
    return `<details id="${id}" class="bg-base-100 rounded-xl shadow-sm border-l-4 ${cls}" ${n && opts.open !== false ? 'open' : ''}>
        <summary class="cursor-pointer list-none flex items-center gap-3 p-4">
            <svg class="w-4 h-4 details-chevron transition-transform opacity-50 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
            <span class="font-semibold flex-1">${e(title)}</span>
            ${n ? `<span class="badge ${opts.error ? 'badge-error text-white' : 'badge-warning'}">${n}</span>`
                : `<span class="badge badge-success badge-outline">${e(tr('dc_all_ok', 'всё в порядке'))}</span>`}
        </summary>
        ${n ? `<div class="px-4 pb-4">${opts.hint ? `<p class="text-sm opacity-70 mb-2">${opts.hint}</p>` : ''}${body}</div>` : ''}
    </details>`;
}

function renderAmounts() {
    const list = data.amounts.filter(x => amountsShowChecked.on || !x.checked);
    const checkedCount = data.amounts.filter(x => x.checked).length;
    // строками, а не таблицей: на телефоне шесть колонок не помещаются
    const rows = list.map(x => `<div class="py-2 px-2 rounded-lg flex flex-wrap items-center gap-x-3 gap-y-1 ${x.checked ? 'opacity-50' : x.level === 'error' ? 'bg-error/10' : ''}">
        <div class="flex-1 min-w-[14rem]">
            <a class="link font-medium" href="recipe-edit.html?id=${encodeURIComponent(x.recipe.id)}">${e(Layout.getName(x.recipe))}</a>
            <div class="text-sm">${e(Layout.getName(x.product || {}))}: <b>${e(x.amount.toLocaleString('ru-RU'))} ${e(us(x.unit))}</b>
                <span class="opacity-70">· ${e(tr('dc_output', 'Выход'))} ${e(Number(x.recipe.output_amount).toLocaleString('ru-RU'))} ${e(us(x.recipe.output_unit))}</span>
                · <span class="font-mono ${x.level === 'error' && !x.checked ? 'text-error font-semibold' : ''}">×${fmtRatio(x.ratio)}</span></div>
        </div>
        ${x.checked ? `<span class="text-xs">✓ ${e(tr('dc_checked', 'проверено'))}</span>`
            : canEditRecipes ? `<button class="btn btn-xs btn-ghost border-base-300 whitespace-nowrap" data-action="check-amount" data-id="${x.id}">${e(tr('dc_mark_checked', 'Так и должно быть'))}</button>` : ''}
    </div>`).join('');
    return `<div class="space-y-1">${rows}</div>
        ${checkedCount ? `<label class="label cursor-pointer justify-start gap-2 mt-2"><input type="checkbox" class="checkbox checkbox-xs" data-action="toggle-checked" ${amountsShowChecked.on ? 'checked' : ''}>
            <span class="label-text text-sm">${e(tr('dc_show_checked', 'Показать проверенные'))} (${checkedCount})</span></label>` : ''}`;
}

function render() {
    const d = data;
    const amountsOpen = d.amounts.filter(x => !x.checked);
    const amountsBad = amountsOpen.some(x => x.level === 'error');
    const period = `${DateUtils.parseDate(d.from).toLocaleDateString('ru-RU')} – ${DateUtils.parseDate(d.today).toLocaleDateString('ru-RU')}`;

    const blocks = [
        section('amounts', tr('dc_amounts', 'Ингредиента больше, чем выходит готового блюда'), amountsOpen, renderAmounts(), {
            error: amountsBad,
            hint: e(tr('dc_amounts_hint', 'От 3 раз и больше (красным) почти наверняка перепутаны граммы и килограммы. Меньше бывает нормой: уварка, чистка, вода. Если всё верно — «Так и должно быть», и строка уйдёт из списка, пока количество не поменяют.'))
        }),
        section('expensive', tr('dc_expensive', 'Необычно дорогие приёмы пищи'), d.expensive,
            `<div class="space-y-1">${d.expensive.map(r => `<div class="py-2 px-2 rounded-lg ${r.ratio >= 10 ? 'bg-error/10' : ''}">
                <a class="link font-medium" href="menu.html#day/${r.date}/${r.meal}">${e(fmtDay(r.date))} · ${e(mealName(r.meal))}</a>
                <div class="text-sm">${e(tr('dc_portion', 'Порция'))} <b class="font-mono">${money(r.perPortion)}</b>
                    <span class="opacity-70">· ${e(tr('dc_usual', 'Обычно'))} ${money(r.median)}</span> · <span class="font-mono">×${fmtRatio(r.ratio)}</span></div>
                ${r.top ? `<div class="text-sm opacity-70">${e(tr('dc_main_cost', 'Больше всего ушло на'))}: ${e(r.top.name)} — ${money(r.top.sum)}</div>` : ''}
            </div>`).join('')}</div>`,
            { error: d.expensive.some(r => r.ratio >= 10),
              hint: e(tr('dc_expensive_hint', 'Порция (продукты, посуда, готовое) в 3 раза и больше дороже обычной за этот приём пищи — ошибка в рецепте, в цене продукта или большая покупка. Нажмите дату — откроется меню этого дня.')) + ` ${e(tr('dc_period', 'Период'))}: ${e(period)}.` }),
        section('prices', tr('dc_prices', 'Нет цены на продукт — расход по нему не учтён'), d.missingPrices,
            `<ul class="list-disc ml-5 text-sm columns-1 md:columns-2">${d.missingPrices.map(p => `<li>${e(p.name)} <span class="opacity-60">(${p.n})</span></li>`).join('')}</ul>
             <a class="btn btn-sm mt-3" href="prices.html">${e(tr('nav_prices', 'Цены'))} →</a>`,
            { hint: `${e(tr('dc_prices_hint', 'Продукты из меню за период; в скобках — сколько раз встретился'))}. ${e(tr('dc_period', 'Период'))}: ${e(period)}.` }),
        section('units', tr('dc_units', 'Единица ингредиента не переводится в единицу продукта — ингредиент не учтён'), d.unresolved,
            `<ul class="list-disc ml-5 text-sm">${d.unresolved.map(u => `<li>${e(u.p)}: ${e(us(u.a))} → ${e(us(u.b))} <span class="opacity-60">(${u.n})</span></li>`).join('')}</ul>
             <a class="btn btn-sm mt-3" href="products.html">${e(tr('nav_products', 'Продукты'))} →</a>`,
            { hint: e(tr('dc_units_hint', 'Нужна плотность (граммы в ложке, стакане, литре) или вес одной штуки в карточке продукта.')) }),
        section('output', tr('dc_output_missing', 'У рецепта не указан выход — масштаб не посчитан'), d.noOutput,
            `<ul class="list-disc ml-5 text-sm">${d.noOutput.map(r => `<li><a class="link" href="recipe-edit.html?id=${encodeURIComponent(r.id)}">${e(Layout.getName(r))}</a></li>`).join('')}</ul>`),
        section('nomenu', tr('dc_nomenu', 'Люди ели, а меню не заведено — продукты не посчитаны'), d.noMenu,
            `<div class="flex flex-wrap gap-2">${d.noMenu.map(x => `<a class="btn btn-xs btn-ghost border-base-300" href="menu.html#day/${x.d}/${x.m}">${e(fmtDay(x.d))} · ${e(mealName(x.m))}</a>`).join('')}</div>`,
            { hint: `${e(tr('dc_period', 'Период'))}: ${e(period)}.` }),
        section('nodept', tr('dc_nodept', 'Команда и волонтёры без департамента — питание не отнесено ни на один департамент'), d.noDept,
            `<div class="overflow-x-auto"><table class="table table-sm"><tbody>${d.noDept.map(r => `<tr>
                <td>${r.vaishnava_id ? `<a class="link" href="../vaishnavas/person.html?id=${encodeURIComponent(r.vaishnava_id)}">${e(r.name)}</a>` : `<a class="link" href="../placement/timeline.html">${e(r.name)}</a>`}</td>
                <td class="text-sm opacity-70">${e(r.isTeam ? tr('status_team', 'Команда') : tr('category_volunteer', 'Волонтёр'))}</td>
                <td class="text-sm opacity-70 whitespace-nowrap">${e(DateUtils.parseDate(r.check_in).toLocaleDateString('ru-RU'))} – ${e(DateUtils.parseDate(r.check_out).toLocaleDateString('ru-RU'))}</td></tr>`).join('')}</tbody></table></div>`,
            { hint: e(tr('dc_nodept_hint', 'Живут сейчас или заедут. Департамент указывается в карточке человека (история служения) или у брони в шахматке.')) })
    ];

    const total = amountsOpen.length + d.expensive.length + d.missingPrices.length + d.unresolved.length + d.noOutput.length + d.noMenu.length + d.noDept.length;
    Layout.$('#dcSummary').innerHTML = total
        ? `<div class="alert ${amountsBad || d.expensive.some(r => r.ratio >= 10) ? 'alert-error' : 'alert-warning'} text-sm"><div class="font-semibold">⚠ ${e(tr('dc_total', 'Упущений в данных кухни'))}: ${total}</div></div>`
        : `<div class="alert alert-success text-sm">${e(tr('dc_all_ok_total', 'Упущений не найдено'))}</div>`;
    Layout.$('#dcBlocks').innerHTML = blocks.join('');
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ block: 'start' });
}

// ==================== ДЕЙСТВИЯ ====================
async function markChecked(id) {
    const x = data.amounts.find(a => a.id === id);
    if (!x) return;
    const { error } = await Layout.db.from('recipe_ingredients').update({ checked_amount: x.amount, checked_unit: x.unit }).eq('id', id);
    if (error) { Layout.handleError(error, tr('dc_mark_checked', 'Так и должно быть')); return; }
    x.checked = true;
    render();
}

document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'check-amount') markChecked(btn.dataset.id);
});
document.addEventListener('change', ev => {
    if (ev.target.matches('[data-action="toggle-checked"]')) { amountsShowChecked.on = ev.target.checked; render(); document.getElementById('amounts').open = true; }
});

// ==================== СТАРТ ====================
async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'data_check' });
    Layout.showLoader();
    try {
        const { data: loc } = await Layout.db.from('locations').select('id').eq('slug', Layout.currentLocation).single();
        locationId = loc?.id;
        canEditRecipes = !!window.hasPermission?.('edit_recipe');
        await load();
        render();
    } catch (err) {
        Layout.handleError(err, tr('nav_data_check', 'Проверка данных'));
    } finally {
        Layout.hideLoader();
    }
}
init();
