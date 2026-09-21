const assert = require('node:assert/strict');
const test = require('node:test');
const { computeCosts, convert, priceOn } = require('../js/kitchen-cost.js');

const UNITS = {
    kg: { type: 'weight', ratio: 1000 }, g: { type: 'weight', ratio: 1 },
    l: { type: 'volume', ratio: 1000 }, ml: { type: 'volume', ratio: 1 },
    tsp: { type: 'volume', ratio: 5 }, tbsp: { type: 'volume', ratio: 15 }, cup: { type: 'volume', ratio: 250 },
    pcs: { type: 'count', ratio: 1 }, pack: { type: 'count', ratio: 1 }
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const D = '2026-09-10';
const bucket = (o = {}) => ({ team: 0, volunteers: 0, vips: 0, guests: 0, groups: 0, expected: 0, ...o });
const counts = (byEvent, meal = 'lunch') => ({ [D]: { byEvent: { breakfast: meal === 'breakfast' ? byEvent : {}, lunch: meal === 'lunch' ? byEvent : {} } } });

function base(over = {}) {
    return {
        from: D, to: D,
        meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 100, dishes: [{ recipe_id: 'r1', portion_size: null }] }],
        recipes: { r1: { output_amount: 10, output_unit: 'kg', portion_amount: 150, ingredients: [{ product_id: 'rice', amount: 2, unit: 'kg' }] } },
        products: { rice: { name: 'Рис', unit: 'kg', waste_percent: null } },
        densities: {}, units: UNITS,
        prices: { rice: [{ price: 100, valid_from: '2026-01-01', valid_to: null }] },
        kits: { breakfast: [], lunch: [] }, externals: {},
        counts: counts({ 'retreat:R': bucket({ team: 40, guests: 60 }) }),
        ...over
    };
}
const sumCells = r => Object.values(r.cells).flatMap(e => Object.values(e))
    .reduce((s, c) => s + c.food + c.dishware + c.external, 0);

test('продукты по рецепту: масштаб на порции, цена, разбивка по категориям', () => {
    const r = computeCosts(base());
    // множитель = 100 порций × 150 г / 10 000 г = 1,5; рис 2 кг × 1,5 = 3 кг × 100 = 300
    near(r.totals.food, 300);
    near(r.cells['retreat:R'].team.food, 120);
    near(r.cells['retreat:R'].guests.food, 180);
    assert.equal(r.cells['retreat:R'].guests.personMeals, 60);
    near(sumCells(r), 300);
});

test('порция блюда в меню важнее порции рецепта', () => {
    const r = computeCosts(base({ meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 100, dishes: [{ recipe_id: 'r1', portion_size: 300 }] }] }));
    near(r.totals.food, 600);
});

test('отходы: закупать нужно больше, чем очищенный вес', () => {
    const r = computeCosts(base({ products: { rice: { name: 'Рис', unit: 'kg', waste_percent: 20 } } }));
    near(r.totals.food, 375);   // 300 / 0,8
});

test('конвертация единиц', () => {
    near(convert(4, 'tbsp', 'kg', { tbsp_grams: 12 }, UNITS), 0.048);
    near(convert(1, 'l', 'kg', { liter_grams: 1030 }, UNITS), 1.03);
    near(convert(1, 'l', 'kg', null, UNITS), 1);
    near(convert(2, 'kg', 'g', null, UNITS), 2000);
    near(convert(500, 'ml', 'l', null, UNITS), 0.5);
    near(convert(3, 'tbsp', 'tsp', { tbsp_grams: 12, tsp_grams: 4 }, UNITS), 9);
    near(convert(2, 'pcs', 'pcs', null, UNITS), 2);
    assert.equal(convert(500, 'g', 'pcs', null, UNITS), null);
    assert.equal(convert(1, 'l', 'pcs', null, UNITS), null);
    assert.equal(convert(1, 'kg', 'nonsense', null, UNITS), null);
});

test('ложка без плотности считается через миллилитры', () => {
    near(convert(2, 'tbsp', 'kg', null, UNITS), 0.03);   // 30 мл ≈ 30 г
});

test('цена на дату: периоды, задним числом, нет цены', () => {
    const rows = [
        { price: 100, valid_from: '2026-01-01', valid_to: '2026-05-31' },
        { price: 120, valid_from: '2026-06-01', valid_to: null }
    ];
    assert.equal(priceOn(rows, '2025-12-01'), 100);
    assert.equal(priceOn(rows, '2026-05-31'), 100);
    assert.equal(priceOn(rows, '2026-06-01'), 120);
    assert.equal(priceOn([], D), null);
    assert.equal(priceOn([{ price: 5, valid_from: '2026-01-01', valid_to: '2026-02-01' }], '2026-03-01'), null);
});

test('нет цены: расход не теряется молча, продукт попадает в предупреждения', () => {
    const r = computeCosts(base({ prices: {} }));
    near(r.totals.food, 0);
    assert.equal(r.warnings.missingPrices.get('rice'), 1);
});

test('нельзя перевести единицы: ингредиент в предупреждениях', () => {
    const r = computeCosts(base({ recipes: { r1: { output_amount: 10, output_unit: 'kg', portion_amount: 150, ingredients: [{ product_id: 'rice', amount: 2, unit: 'pcs' }] } } }));
    near(r.totals.food, 0);
    assert.equal(r.warnings.unresolvedUnits.size, 1);
});

test('посуда: набор на каждого вкушающего', () => {
    const r = computeCosts(base({
        meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 100, dishes: [] }],
        kits: { breakfast: [], lunch: [{ product_id: 'plate', quantity: 1 }, { product_id: 'cup', quantity: 1.2 }] },
        prices: { plate: [{ price: 4, valid_from: '2026-01-01', valid_to: null }], cup: [{ price: 1.4, valid_from: '2026-01-01', valid_to: null }] }
    }));
    near(r.totals.dishware, 100 * (4 + 1.2 * 1.4));
    near(r.cells['retreat:R'].team.dishware, 40 * 5.68);
    near(sumCells(r), r.totals.dishware);
});

test('готовое со стороны: сумма делится на всех вкушающих приёма пищи', () => {
    const r = computeCosts(base({
        meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 100, dishes: [] }],
        counts: counts({ 'retreat:R': bucket({ guests: 20 }), none: bucket({ team: 10 }) }),
        externals: { m1: [{ name: 'Обед со стороны', amount: 10000, persons: null }] }
    }));
    near(r.totals.external, 10000);
    near(r.cells['retreat:R'].guests.external, 10000 * 20 / 30);
    near(r.cells.none.team.external, 10000 * 10 / 30);
    near(sumCells(r), 10000);
});

test('предупреждение о расхождении порций и вкушающих (порог 5)', () => {
    const r1 = computeCosts(base({ meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 110, dishes: [] }] }));
    assert.equal(r1.warnings.mismatch.length, 1);
    const r2 = computeCosts(base({ meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 103, dishes: [] }] }));
    assert.equal(r2.warnings.mismatch.length, 0);
});

test('вкушающие есть, приёма пищи в меню нет', () => {
    const r = computeCosts(base({ meals: [] }));
    assert.deepEqual(r.warnings.noMenu, [`${D} lunch`]);
});

test('расходы без вкушающих не размазываются, а учитываются отдельно', () => {
    const r = computeCosts(base({ counts: counts({}) }));
    near(r.totals.unallocated, 300);
    assert.equal(r.warnings.noEaters.length, 1);
    near(sumCells(r), 0);
});

test('инвариант: сумма по ячейкам равна итогу при нескольких событиях, приёмах пищи и позициях', () => {
    const input = base({
        meals: [
            { id: 'm1', date: D, meal_type: 'lunch', portions: 97, dishes: [{ recipe_id: 'r1', portion_size: null }] },
            { id: 'm2', date: D, meal_type: 'breakfast', portions: 60, dishes: [{ recipe_id: 'r1', portion_size: 120 }] }
        ],
        counts: {
            [D]: { byEvent: {
                breakfast: { none: bucket({ team: 25, expected: 3 }), 'retreat:A': bucket({ guests: 31 }) },
                lunch: { none: bucket({ team: 27 }), 'retreat:A': bucket({ guests: 40, vips: 2 }), 'group:G': bucket({ groups: 28 }) }
            } }
        },
        kits: { breakfast: [{ product_id: 'plate', quantity: 1 }], lunch: [{ product_id: 'plate', quantity: 1 }] },
        prices: { rice: [{ price: 100, valid_from: '2026-01-01', valid_to: null }], plate: [{ price: 4, valid_from: '2026-01-01', valid_to: null }] },
        externals: { m2: [{ name: 'Готовое', amount: 777, persons: null }] }
    });
    const r = computeCosts(input);
    near(sumCells(r), r.totals.food + r.totals.dishware + r.totals.external);
    assert.equal(r.totals.personMeals, 59 + 97);
});

// ---------- накладные расходы ----------
const ovItem = (o = {}) => ({ kind: 'general', amount_base: 1000, eff_from: '2026-09-01', eff_to: '2026-09-30',
    retreat_id: null, category_name: 'Статья', occurred_on: '2026-09-05', labor_unlinked: false, ...o });
const ovInput = (overhead, countsOver, extra = {}) => base({
    counts: { ...counts({ 'retreat:R': bucket({ team: 40, guests: 60 }) }), ...(countsOver || {}) },
    overhead: { payroll: [], items: [], error: null, ...overhead }, today: '2026-09-22', ...extra
});
const otherDay = (date, byEvent) => ({ [date]: { byEvent: { breakfast: {}, lunch: byEvent } } });
const cellSum = (r, f) => Object.values(r.cells).flatMap(e => Object.values(e)).reduce((s, c) => s + f(c), 0);

test('общие расходы месяца: ставка на человеко-приём всего периода, в ячейки — доля периода расчёта', () => {
    // за месяц 100 (в окне) + 200 (вне окна, «без события») = 300 человеко-приёмов, 30 000 → 100 на человека
    const r = computeCosts(ovInput({ items: [ovItem({ amount_base: 30000 })] }, otherDay('2026-09-20', { none: bucket({ guests: 200 }) })));
    near(r.totals.overheadGeneral, 10000);
    near(r.cells['retreat:R'].team.overheadGeneral, 4000);
    near(r.cells['retreat:R'].guests.overheadGeneral, 6000);
    near(r.totals.overheadUnallocated, 0);
    assert.equal(r.totals.provisional, true);   // месяц ещё не закончился
});

test('период закончился — итог не предварительный', () => {
    const r = computeCosts(ovInput({ items: [ovItem({ eff_to: '2026-09-15' })] }, null, { today: '2026-09-22' }));
    assert.equal(r.totals.provisional, false);
});

test('расход ретрита ложится только на этот ретрит', () => {
    const r = computeCosts(ovInput({ items: [ovItem({ kind: 'retreat_event', retreat_id: 'R', amount_base: 5000 })] },
        { [D]: { byEvent: { breakfast: {}, lunch: { 'retreat:R': bucket({ team: 40, guests: 60 }), 'retreat:Q': bucket({ guests: 100 }) } } } }));
    near(r.totals.overheadRetreat, 5000);
    near(r.cells['retreat:R'].guests.overheadRetreat, 3000);
    assert.equal(r.cells['retreat:Q']?.guests.overheadRetreat || 0, 0);
});

test('билет за период делится между ретритами, «без события» не участвует', () => {
    const c = { [D]: { byEvent: { breakfast: {}, lunch: { 'retreat:R': bucket({ guests: 60 }), none: bucket({ guests: 40 }) } } } };
    const r = computeCosts(ovInput({ items: [ovItem({ kind: 'retreat_period', amount_base: 3000, eff_from: D, eff_to: D })] }, c));
    near(r.totals.overheadRetreat, 3000);
    near(r.cells['retreat:R'].guests.overheadRetreat, 3000);
    assert.equal(r.cells.none.guests.overheadRetreat, 0);
});

test('расход «на ретрит», а в периоде только «без события» — уходит в общие с предупреждением', () => {
    const c = { [D]: { byEvent: { breakfast: {}, lunch: { none: bucket({ guests: 100 }) } } } };
    const r = computeCosts(ovInput({ items: [ovItem({ kind: 'retreat_period', amount_base: 800, eff_from: D, eff_to: D })] }, c));
    near(r.totals.overheadRetreat, 0);
    near(r.totals.overheadGeneral, 800);
    assert.equal(r.warnings.overheadNoBase.length, 1);
});

test('расход без вкушающих в периоде не теряется молча', () => {
    const r = computeCosts(ovInput({ items: [ovItem({ amount_base: 500, eff_from: '2026-08-01', eff_to: '2026-08-31' })] }));
    near(r.totals.overheadUnallocated, 500);
    assert.equal(r.warnings.overheadUnallocated.length, 1);
});

test('зарплата: оценка помечается, начисление — нет; чужая валюта не учитывается', () => {
    const r = computeCosts(ovInput({ payroll: [
        { month: '2026-09-01', position_title: 'Повар', amount: 33000, currency_code: 'INR', source: 'estimate' },
        { month: '2026-09-01', position_title: 'Глава', amount: 50000, currency_code: 'USD', source: 'accrual' }] }));
    near(r.totals.overheadGeneral, 33000);
    assert.deepEqual(r.warnings.payrollEstimated, ['2026-09']);
    assert.equal(r.warnings.overheadForeign, 1);
});

test('вкушающие есть, а меню нет: доля расхода уходит в нераспределённое, сумма сходится', () => {
    const r = computeCosts(ovInput({ items: [ovItem({ amount_base: 2000, eff_from: D, eff_to: '2026-09-11' })] },
        otherDay('2026-09-11', { 'retreat:R': bucket({ guests: 100 }) }), { to: '2026-09-11' }));
    near(r.totals.overheadGeneral + r.totals.overheadUnallocated, 2000);
    near(r.totals.overheadGeneral, 1000);
});

test('«на ретрит» без ретрита и назначения считается общим и отмечается; выплата вне ведомости отмечается', () => {
    const r = computeCosts(ovInput({ items: [ovItem({ kind: 'unassigned', amount_base: 700, eff_from: D, eff_to: D, labor_unlinked: true })] }));
    near(r.totals.overheadGeneral, 700);
    assert.equal(r.warnings.overheadUnassigned, 1);
    assert.equal(r.warnings.laborUnlinked.length, 1);
});

test('ошибка загрузки накладных: прямые затраты считаются, причина в предупреждении', () => {
    const r = computeCosts(ovInput({ error: 'forbidden' }));
    near(r.totals.food, 300);
    assert.equal(r.warnings.overheadError, 'forbidden');
});

test('инвариант: распределённое накладное + нераспределённое = сумме расходов при нескольких событиях', () => {
    const c = { [D]: { byEvent: { breakfast: { 'retreat:R': bucket({ team: 10 }) }, lunch: { 'retreat:R': bucket({ team: 40, guests: 60 }), 'retreat:Q': bucket({ vips: 7 }), none: bucket({ guests: 3 }) } } } };
    const items = [ovItem({ amount_base: 1234.5, eff_from: D, eff_to: D }), ovItem({ kind: 'retreat_period', amount_base: 999, eff_from: D, eff_to: D }),
        ovItem({ kind: 'retreat_event', retreat_id: 'Q', amount_base: 321, eff_from: D, eff_to: D })];
    const r = computeCosts(ovInput({ items }, c, {
        meals: [{ id: 'm1', date: D, meal_type: 'lunch', portions: 110, dishes: [] }] }));
    near(cellSum(r, x => x.overheadRetreat + x.overheadGeneral) + r.totals.overheadUnallocated, 1234.5 + 999 + 321);
    near(cellSum(r, x => x.overheadRetreat + x.overheadGeneral), r.totals.overheadRetreat + r.totals.overheadGeneral);
});
