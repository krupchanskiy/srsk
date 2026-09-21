// ==================== KITCHEN-COST.JS ====================
// Прямые затраты питания (ТЗ «Учёт затрат кухни», п. 3.6, часть 1):
// продукты по рецептам + одноразовая посуда + строки «Готовое со стороны».
//
// Стоимость приёма пищи = продукты на приготовленные порции + посуда + готовое,
// делится на фактических вкушающих (EatingUtils.loadCounts → byEvent).
// Суммы по ячейкам «событие × категория» всегда равны сумме по приёмам пищи.

const KitchenCost = (function () {

const BUCKETS = ['team', 'volunteers', 'vips', 'guests', 'groups', 'expected'];
const MEALS = ['breakfast', 'lunch'];
const MISMATCH_LIMIT = 5;   // порций больше/меньше числа вкушающих на столько и более — предупреждение

// ---------- цена на дату (то же правило, что kitchen_price_on в базе) ----------
function priceOn(rows, date) {
    if (!rows || !rows.length) return null;
    const hit = rows.find(r => r.valid_from <= date && (!r.valid_to || r.valid_to >= date));
    if (hit) return Number(hit.price);
    const earliest = rows.reduce((a, b) => (a.valid_from <= b.valid_from ? a : b));
    return date < earliest.valid_from ? Number(earliest.price) : null;
}

// ---------- единицы ----------
// Количество в единице ингредиента → в единице, в которой у продукта цена.
// Ложки и стаканы переводятся через плотность продукта (граммы на ложку/стакан),
// литры — через плотность (граммы на литр), при её отсутствии считаем 1 г = 1 мл.
// Вес ↔ штуки и объём ↔ штуки не переводятся: возвращаем null.
function convert(amount, ingUnit, productUnit, density, units) {
    const ui = units[ingUnit], up = units[productUnit];
    if (!ui || !up) return null;

    const gramsPerMl = density?.liter_grams ? Number(density.liter_grams) / 1000 : 1;
    let kind = ui.type, value = amount * ui.ratio;   // value в базовой единице типа (г / мл / шт)

    // ложки и стаканы с известной плотностью → граммы
    const direct = { tsp: 'tsp_grams', tbsp: 'tbsp_grams', cup: 'cup_grams' }[ingUnit];
    if (direct && density?.[direct]) { kind = 'weight'; value = amount * Number(density[direct]); }

    // цена задана за ложку/стакан — обратно через ту же плотность
    const upDirect = { tsp: 'tsp_grams', tbsp: 'tbsp_grams', cup: 'cup_grams' }[productUnit];
    if (kind === 'weight' && upDirect && density?.[upDirect]) return value / Number(density[upDirect]);

    if (kind === 'count' || up.type === 'count') {
        return kind === up.type && ingUnit === productUnit ? amount : null;
    }
    if (kind === up.type) return value / up.ratio;
    if (kind === 'volume' && up.type === 'weight') return (value * gramsPerMl) / up.ratio;
    if (kind === 'weight' && up.type === 'volume') return (value / gramsPerMl) / up.ratio;
    return null;
}

// ---------- расчёт ----------
// input: { meals, recipes, products, densities, units, prices, kits, externals, counts, from, to }
//   meals:      menu_meals с dishes[{recipe_id, portion_size}]
//   recipes:    { [id]: {output_amount, output_unit, portion_amount, ingredients:[{product_id, amount, unit}]} }
//   products:   { [id]: {name, unit, waste_percent} }
//   densities:  { [product_id]: {tsp_grams, tbsp_grams, cup_grams, liter_grams} }
//   units:      { [code]: {type, ratio} }
//   prices:     { [product_id]: [{price, valid_from, valid_to}] }
//   kits:       { breakfast: [{product_id, quantity}], lunch: [...] }
//   externals:  { [meal_id]: [{name, amount, persons}] }
//   counts:     результат EatingUtils.loadCounts
function computeCosts(input) {
    const { meals, recipes, products, densities, units, prices, kits, externals, counts } = input;

    const cells = {};       // cells[eventKey][bucket] = { personMeals, food, dishware, external }
    const warn = {
        missingPrices: new Map(),     // product_id → сколько раз не нашлась цена
        unresolvedUnits: new Map(),   // 'продукт|ед. рецепта|ед. продукта' → раз
        recipesNoOutput: new Set(),
        noEaters: [],                 // приёмы пищи с расходами, но без вкушающих
        mismatch: [],                 // порции в меню сильно отличаются от числа вкушающих
        noMenu: []                    // есть вкушающие, но приём пищи в меню не заведён
    };
    const totals = { personMeals: 0, food: 0, dishware: 0, external: 0, unallocated: 0 };

    const cell = (ev, bucket) => {
        const e = cells[ev] || (cells[ev] = {});
        return e[bucket] || (e[bucket] = { personMeals: 0, food: 0, dishware: 0, external: 0 });
    };
    const note = (map, key) => map.set(key, (map.get(key) || 0) + 1);

    // стоимость продукта в нужном количестве на дату; null = нет цены
    function productCost(productId, qtyInProductUnit, date) {
        const p = products[productId];
        const price = priceOn(prices[productId], date);
        if (price === null) { note(warn.missingPrices, productId); return 0; }
        const waste = Number(p?.waste_percent) || 0;
        const purchased = waste > 0 && waste < 100 ? qtyInProductUnit / (1 - waste / 100) : qtyInProductUnit;
        return purchased * price;
    }

    const seen = new Set();
    for (const meal of meals) {
        if (!MEALS.includes(meal.meal_type)) continue;
        seen.add(`${meal.date}|${meal.meal_type}`);

        const byEvent = counts?.[meal.date]?.byEvent?.[meal.meal_type] || {};
        const eaters = Object.values(byEvent).reduce((s, b) => s + BUCKETS.reduce((x, k) => x + (b[k] || 0), 0), 0);
        const portions = meal.portions || eaters;

        // --- продукты по рецептам на приготовленные порции ---
        let food = 0;
        for (const dish of (meal.dishes || [])) {
            const recipe = recipes[dish.recipe_id];
            if (!recipe) continue;
            const portionSize = Number(dish.portion_size) || Number(recipe.portion_amount) || 100;
            const output = (Number(recipe.output_amount) || 0) * (recipe.output_unit === 'kg' ? 1000 : 1);
            if (output <= 0) warn.recipesNoOutput.add(dish.recipe_id);
            const multiplier = output > 0 ? (portions * portionSize) / output : 1;

            for (const ing of (recipe.ingredients || [])) {
                if (!ing.product_id || !products[ing.product_id]) continue;
                const p = products[ing.product_id];
                const qty = convert((Number(ing.amount) || 0) * multiplier, ing.unit, p.unit, densities[ing.product_id], units);
                if (qty === null) { note(warn.unresolvedUnits, `${p.name}|${ing.unit}|${p.unit}`); continue; }
                food += productCost(ing.product_id, qty, meal.date);
            }
        }

        // --- посуда: набор на одного вкушающего ---
        let dishwarePerEater = 0;
        for (const k of (kits[meal.meal_type] || [])) {
            const price = priceOn(prices[k.product_id], meal.date);
            if (price === null) { note(warn.missingPrices, k.product_id); continue; }
            dishwarePerEater += Number(k.quantity) * price;
        }

        // --- готовое со стороны ---
        const external = (externals[meal.id] || []).reduce((s, x) => s + Number(x.amount), 0);

        if (eaters === 0) {
            if (food + external > 0) warn.noEaters.push(`${meal.date} ${meal.meal_type}`);
            totals.unallocated += food + external;
            totals.food += food; totals.external += external;
            continue;
        }
        if (Math.abs(portions - eaters) >= MISMATCH_LIMIT) {
            warn.mismatch.push({ date: meal.date, meal: meal.meal_type, portions, eaters });
        }

        // распределяем по ячейкам пропорционально числу вкушающих
        for (const [ev, b] of Object.entries(byEvent)) {
            for (const k of BUCKETS) {
                const n = b[k] || 0;
                if (!n) continue;
                const c = cell(ev, k);
                c.personMeals += n;
                c.food += food * n / eaters;
                c.dishware += dishwarePerEater * n;
                c.external += external * n / eaters;
            }
        }
        totals.personMeals += eaters;
        totals.food += food;
        totals.dishware += dishwarePerEater * eaters;
        totals.external += external;
    }

    // вкушающие есть, а приёма пищи в меню нет
    for (const [date, day] of Object.entries(counts || {})) {
        if (date < input.from || date > input.to) continue;
        for (const m of MEALS) {
            const n = Object.values(day.byEvent?.[m] || {}).reduce((s, b) => s + BUCKETS.reduce((x, k) => x + (b[k] || 0), 0), 0);
            if (n > 0 && !seen.has(`${date}|${m}`)) warn.noMenu.push(`${date} ${m}`);
        }
    }

    return { cells, totals, warnings: warn };
}

// ---------- загрузка данных ----------
async function fetchAll(makeQuery) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await makeQuery().range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}

async function load(db, locationId, from, to) {
    const meals = await fetchAll(() => db.from('menu_meals')
        .select('id, date, meal_type, portions, dishes:menu_dishes(id, recipe_id, portion_size)')
        .eq('location_id', locationId).gte('date', from).lte('date', to).order('date'));

    const mealIds = meals.map(m => m.id);
    const externalRows = mealIds.length
        ? await fetchAll(() => db.from('menu_external_items').select('id, meal_id, name, amount, persons').in('meal_id', mealIds))
        : [];
    const externals = {};
    externalRows.forEach(x => (externals[x.meal_id] = externals[x.meal_id] || []).push(x));

    const recipeIds = [...new Set(meals.flatMap(m => (m.dishes || []).map(d => d.recipe_id)).filter(Boolean))];
    const recipeRows = recipeIds.length
        ? await fetchAll(() => db.from('recipes').select('id, output_amount, output_unit, portion_amount').in('id', recipeIds))
        : [];
    const ingRows = recipeIds.length
        ? await fetchAll(() => db.from('recipe_ingredients').select('recipe_id, product_id, amount, unit').in('recipe_id', recipeIds))
        : [];
    const recipes = {};
    recipeRows.forEach(r => (recipes[r.id] = { ...r, ingredients: [] }));
    ingRows.forEach(i => recipes[i.recipe_id]?.ingredients.push(i));

    const { data: kitRows, error: kitErr } = await db.from('kitchen_portion_kits')
        .select('meal_type, product_id, quantity').eq('location_id', locationId);
    if (kitErr) throw kitErr;
    const kits = { breakfast: [], lunch: [] };
    (kitRows || []).forEach(k => kits[k.meal_type]?.push(k));

    const productIds = [...new Set([
        ...ingRows.map(i => i.product_id), ...(kitRows || []).map(k => k.product_id)].filter(Boolean))];
    const productRows = productIds.length
        ? await fetchAll(() => db.from('products').select('id, name_ru, unit, waste_percent').in('id', productIds))
        : [];
    const products = {};
    productRows.forEach(p => (products[p.id] = { name: p.name_ru, unit: p.unit, waste_percent: p.waste_percent }));

    const densityRows = productIds.length
        ? await fetchAll(() => db.from('product_densities').select('product_id, tsp_grams, tbsp_grams, cup_grams, liter_grams').in('product_id', productIds))
        : [];
    const densities = {};
    densityRows.forEach(d => (densities[d.product_id] = d));

    const unitRows = await fetchAll(() => db.from('units').select('code, type, to_base_ratio'));
    const units = {};
    unitRows.forEach(u => (units[u.code] = { type: u.type, ratio: Number(u.to_base_ratio) }));

    const priceRows = productIds.length
        ? await fetchAll(() => db.from('kitchen_prices').select('product_id, price, valid_from, valid_to')
            .eq('location_id', locationId).in('product_id', productIds))
        : [];
    const prices = {};
    priceRows.forEach(r => (prices[r.product_id] = prices[r.product_id] || []).push(r));

    const counts = await EatingUtils.loadCounts(from, to);

    return { meals, recipes, products, densities, units, prices, kits, externals, counts, from, to };
}

async function calculate(db, locationId, from, to) {
    const input = await load(db, locationId, from, to);
    const result = computeCosts(input);
    result.productNames = Object.fromEntries(Object.entries(input.products).map(([id, p]) => [id, p.name]));
    return result;
}

const api = { computeCosts, calculate, priceOn, convert, BUCKETS };
if (typeof module !== 'undefined') module.exports = api;
return api;

})();
