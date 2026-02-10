// Заявки на закупку
// Генерация заявок из меню, ручное добавление продуктов, управление заявками

// ==================== STATE ====================
let recipes = [];
let products = [];
let productCategories = [];
let stockItems = [];
let requestItems = [];
let locationId = null;
let savedRequestId = null;
let savedRequestNumber = null;
let nextRequestNumber = null;
let savedRequests = [];
let viewingRequest = null; // Currently viewed request in modal
let viewingItems = []; // Editable items for the viewed request
let selectedProduct = null;
let currentProductCategory = 'all';
let highlightRequestId = null; // ID заявки для подсветки после сохранения
let buyers = []; // Список закупщиков
let addingToViewedRequest = false; // Флаг: добавляем в просматриваемую заявку
let generatedEatingCounts = null; // Кол-во едоков для отображения в шапке
let generatedPeriod = null; // Период генерации {from, to}

const t = key => Layout.t(key);

// Хелпер для переводов с fallback
function tr(key, fallback) {
    const val = t(key);
    return (val && val !== key) ? val : fallback;
}

// ==================== MODAL DIALOGS ====================
let confirmResolve = null;

function showAlert(message) {
    Layout.$('#alertMessage').textContent = message;
    Layout.$('#alertModal').showModal();
}

function closeAlert() {
    Layout.$('#alertModal').close();
}

function showConfirm(message) {
    return new Promise(resolve => {
        confirmResolve = resolve;
        Layout.$('#confirmMessage').textContent = message;
        Layout.$('#confirmModal').showModal();
    });
}

function confirmYes() {
    Layout.$('#confirmModal').close();
    if (confirmResolve) confirmResolve(true);
}

function confirmNo() {
    Layout.$('#confirmModal').close();
    if (confirmResolve) confirmResolve(false);
}

// ==================== HELPERS ====================
const UNITS = {
    kg: { ru: 'кг', en: 'kg', hi: 'किग्रा', toGrams: 1000 },
    g: { ru: 'г', en: 'g', hi: 'ग्रा', toGrams: 1 },
    l: { ru: 'л', en: 'l', hi: 'ली', toGrams: 1000 },
    ml: { ru: 'мл', en: 'ml', hi: 'मिली', toGrams: 1 },
    pcs: { ru: 'шт', en: 'pcs', hi: 'पीस', toGrams: 1 }
};

function formatQty(num, unit) {
    // Используем общую функцию из Layout
    return Layout.formatQuantity(num, unit);
}

function localizeUnit(unit) {
    const u = (unit || '').toLowerCase();
    return UNITS[u]?.[Layout.currentLang] || unit;
}


function toGrams(amount, unit) {
    const u = (unit || 'g').toLowerCase();
    return (amount || 0) * (UNITS[u]?.toGrams || 1);
}

function fromGrams(grams, preferKg = true) {
    if (preferKg && grams >= 1000) {
        return { value: grams / 1000, unit: 'kg' };
    }
    return { value: grams, unit: 'g' };
}

// Округление для закупки
// Приоритет: min_purchase продукта > стандартное округление
function roundForPurchase(value, unit, category = null, minPurchaseGrams = null) {
    // Если задана мин. закупка - округляем до неё
    if (minPurchaseGrams && minPurchaseGrams > 0) {
        const valueGrams = unit === 'kg' ? value * 1000 : value;
        const rounded = Math.ceil(valueGrams / minPurchaseGrams) * minPurchaseGrams;
        return unit === 'kg' ? rounded / 1000 : rounded;
    }

    // Стандартное округление
    const isVegetable = category === 'vegetables';

    if (isVegetable) {
        // Овощи округляем до 1 кг
        const valueKg = unit === 'kg' ? value : value / 1000;
        return Math.ceil(valueKg);
    }

    if (unit === 'kg') {
        return Math.ceil(value);
    }
    return Math.ceil(value / 50) * 50;
}

// Format number with year suffix (e.g. 4-26 for request #4 in 2026)
function formatNumberWithYear(num) {
    const year = new Date().getFullYear().toString().slice(-2);
    return `${num}-${year}`;
}

// ==================== DATA LOADING ====================
async function loadLocationId() {
    const { data } = await Layout.db
        .from('locations')
        .select('id')
        .eq('slug', Layout.currentLocation)
        .single();
    locationId = data?.id;
}

async function loadProducts() {
    const { data } = await Layout.db
        .from('products')
        .select('*, product_categories(*)');
    products = data || [];
}

async function loadProductCategories() {
    productCategories = await Cache.getOrLoad('product_categories', async () => {
        const { data } = await Layout.db
            .from('product_categories')
            .select('*')
            .order('sort_order');
        return data;
    });
    productCategories = productCategories || [];
}

async function loadBuyers() {
    const { data } = await Layout.db
        .from('buyers')
        .select('*')
        .order('sort_order');
    buyers = data || [];
}

async function loadStock() {
    const { data } = await Layout.db
        .from('stock')
        .select('*')
        .eq('location_id', locationId);
    stockItems = data || [];
}

async function loadRecipes() {
    const { data } = await Layout.db
        .from('recipes')
        .select('*, recipe_ingredients(*)');
    recipes = data || [];
}

async function loadMenuForPeriod(fromDate, toDate) {
    const { data } = await Layout.db
        .from('menu_meals')
        .select('*, dishes:menu_dishes(*, recipe:recipes(*))')
        .eq('location_id', locationId)
        .gte('date', fromDate)
        .lte('date', toDate);
    return data || [];
}

// ==================== PERIOD SELECTION ====================
function selectPeriod(period) {
    // Update button styles
    document.querySelectorAll('.period-btn').forEach(btn => {
        const isActive = btn.dataset.period === period;
        btn.classList.toggle('btn-ghost', !isActive);
        btn.classList.toggle('btn-current-color', isActive);
    });

    // Calculate dates
    const today = new Date();
    const fromDate = new Date(today);
    const toDate = new Date(today);

    const daysToAdd = { today: 0, '3days': 2, week: 6, '2weeks': 13 };
    toDate.setDate(toDate.getDate() + (daysToAdd[period] || 0));

    Layout.$('#periodFrom').value = DateUtils.toISO(fromDate);
    Layout.$('#periodTo').value = DateUtils.toISO(toDate);
}

function clearPeriodButtons() {
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.add('btn-ghost');
        btn.classList.remove('btn-current-color');
    });
}

// ==================== GENERATE REQUEST ====================
async function generateRequest() {
    const fromDate = Layout.$('#periodFrom').value;
    const toDate = Layout.$('#periodTo').value;

    if (!fromDate || !toDate) {
        showAlert(tr('select_period', 'Выберите период'));
        return;
    }

    const [menuData, eatingCounts] = await Promise.all([
        loadMenuForPeriod(fromDate, toDate),
        EatingUtils.loadCounts(fromDate, toDate)
    ]);

    // Сохраняем для отображения в шапке
    generatedEatingCounts = eatingCounts;
    generatedPeriod = { from: fromDate, to: toDate };

    if (menuData.length === 0) {
        showAlert(tr('menu_not_found', 'Меню на выбранный период не найдено'));
        return;
    }

    // Calculate required ingredients
    const ingredientTotals = {};

    menuData.forEach(meal => {
        // Актуальное количество едоков на дату и приём пищи
        const mealPortions = EatingUtils.getTotal(eatingCounts, meal.date, meal.meal_type);

        (meal.dishes || []).forEach(dish => {
            const recipe = recipes.find(r => r.id === dish.recipe_id);
            if (!recipe?.recipe_ingredients) return;

            // Calculate multiplier: (portions × portion size) / recipe output
            const baseOutputGrams = toGrams(recipe.output_amount || 1, recipe.output_unit || 'kg');
            const targetGrams = mealPortions * (recipe.portion_amount || 150);
            const multiplier = targetGrams / baseOutputGrams;

            recipe.recipe_ingredients.forEach(ing => {
                if (!ing.product_id) return;

                const qtyGrams = toGrams(ing.amount, ing.unit) * multiplier;

                if (ingredientTotals[ing.product_id]) {
                    ingredientTotals[ing.product_id] += qtyGrams;
                } else {
                    ingredientTotals[ing.product_id] = qtyGrams;
                }
            });
        });
    });

    // Calculate what needs to be purchased
    requestItems = [];

    Object.entries(ingredientTotals).forEach(([productId, neededGrams]) => {
        const product = products.find(p => p.id === productId);
        const stock = stockItems.find(s => s.product_id === productId);
        const stockGrams = toGrams(stock?.current_quantity, product?.unit);

        // Процент на очистку применяем сразу
        const wastePercent = product?.waste_percent || 0;

        // Из того что есть на складе (нечищеного), получится очищенного:
        const stockCleanedGrams = wastePercent > 0
            ? stockGrams * (1 - wastePercent / 100)
            : stockGrams;

        // Не хватает очищенного:
        const shortageCleanedGrams = Math.max(0, neededGrams - stockCleanedGrams);

        // Чтобы получить недостающее очищенное, нужно закупить нечищеного:
        const toPurchaseGrams = wastePercent > 0
            ? shortageCleanedGrams / (1 - wastePercent / 100)
            : shortageCleanedGrams;

        if (toPurchaseGrams > 0) {
            const categorySlug = product?.product_categories?.slug;
            const isVegetable = categorySlug === 'vegetables';

            // Определяем единицу - если закупить >= 1 кг или овощи, используем кг, иначе граммы
            const useKg = toPurchaseGrams >= 1000 || isVegetable;
            const unit = useKg ? 'kg' : 'g';

            // Конвертируем всё в выбранную единицу
            const needed = useKg ? neededGrams / 1000 : neededGrams;
            const inStock = useKg ? stockGrams / 1000 : stockGrams;
            const toPurchase = useKg ? toPurchaseGrams / 1000 : toPurchaseGrams;

            // Округляем количество для закупки (учитываем min_purchase)
            const roundedPurchase = roundForPurchase(toPurchase, unit, categorySlug, product?.min_purchase);

            // Get last price from stock (price per kg)
            const lastPrice = stock?.last_price || null;

            // Сумма считается по округлённому количеству (конвертируем в кг для расчёта)
            const purchaseKg = useKg ? roundedPurchase : roundedPurchase / 1000;

            requestItems.push({
                product_id: productId,
                product,
                needed: needed,
                in_stock: inStock,
                to_purchase: roundedPurchase,
                unit: unit,
                last_price: lastPrice,
                est_sum: lastPrice ? purchaseKg * lastPrice : null
            });
        }
    });

    // Sort by category
    requestItems.sort((a, b) => {
        const catA = a.product?.product_categories?.name_ru || '';
        const catB = b.product?.product_categories?.name_ru || '';
        return catA.localeCompare(catB);
    });

    // Reset saved state for new generated request
    savedRequestId = null;
    savedRequestNumber = null;
    nextRequestNumber = await getNextRequestNumber();

    renderResults();
}

// ==================== CREATE MANUAL REQUEST ====================
async function createManualRequest() {
    // Start with empty items
    requestItems = [];
    savedRequestId = null;
    savedRequestNumber = null;
    generatedEatingCounts = null;
    generatedPeriod = null;
    nextRequestNumber = await getNextRequestNumber();

    // Clear period fields for manual requests
    Layout.$('#periodFrom').value = '';
    Layout.$('#periodTo').value = '';

    // Show results section
    Layout.$('#requestChoiceSection')?.classList.add('hidden');
    Layout.$('#resultsSection').classList.remove('hidden');

    renderResults();
}

// Get next request number from database
async function getNextRequestNumber() {
    const { data } = await Layout.db
        .from('purchase_requests')
        .select('number')
        .eq('location_id', locationId)
        .order('number', { ascending: false })
        .limit(1);
    return (data?.[0]?.number || 0) + 1;
}

// ==================== RENDERING ====================
function renderResults() {
    const tbody = Layout.$('#requestItemsTable');

    // Update title
    const titleEl = Layout.$('#requestTitle');
    if (savedRequestNumber) {
        titleEl.textContent = `${tr('request', 'Заявка')} #${formatNumberWithYear(savedRequestNumber)}`;
    } else if (nextRequestNumber) {
        titleEl.textContent = `${tr('new_request_tab', 'Новая заявка')} #${formatNumberWithYear(nextRequestNumber)}`;
    } else {
        titleEl.textContent = tr('new_request_tab', 'Новая заявка');
    }

    // Информация о порциях по датам
    const portionsEl = Layout.$('#portionsInfo');
    if (generatedEatingCounts && generatedPeriod) {
        const lines = [];
        const d = DateUtils.parseDate(generatedPeriod.from);
        const end = DateUtils.parseDate(generatedPeriod.to);
        while (d <= end) {
            const ds = DateUtils.toISO(d);
            const day = generatedEatingCounts[ds];
            if (day) {
                const bTotal = day.breakfast ? day.breakfast.guests + day.breakfast.team + (day.breakfast.residents || 0) : 0;
                const lTotal = day.lunch ? day.lunch.guests + day.lunch.team + (day.lunch.residents || 0) : 0;
                const maxTotal = Math.max(bTotal, lTotal);
                const dd = d.getDate().toString().padStart(2, '0');
                const mm = (d.getMonth() + 1).toString().padStart(2, '0');
                lines.push(`${dd}.${mm} — ${maxTotal || '?'}`);
            }
            d.setDate(d.getDate() + 1);
        }
        if (lines.length > 0) {
            portionsEl.textContent = `${tr('portions_count', 'Кол-во порций')}: ${lines.join(', ')}`;
            portionsEl.classList.remove('hidden');
        } else {
            portionsEl.classList.add('hidden');
        }
    } else {
        portionsEl.classList.add('hidden');
    }

    // Always show results section (hide choice section)
    Layout.$('#requestChoiceSection')?.classList.add('hidden');
    Layout.$('#resultsSection').classList.remove('hidden');
    Layout.$('#totalItems').textContent = requestItems.length;

    // Calculate total sum
    let totalSum = 0;
    let hasAllPrices = true;

    requestItems.forEach(item => {
        if (item.est_sum !== null) {
            totalSum += item.est_sum;
        } else {
            hasAllPrices = false;
        }
    });

    // Display total (with ~ if some prices are missing)
    const totalEl = Layout.$('#totalSum');
    if (totalSum > 0) {
        totalEl.textContent = (hasAllPrices ? '' : '≈ ') + '₹' + Math.round(totalSum).toLocaleString();
    } else {
        totalEl.textContent = '—';
    }

    if (requestItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 opacity-50">
            <div class="text-2xl mb-2">📋</div>
            <div>${tr('add_products_hint', 'Добавьте продукты с помощью кнопки ниже')}</div>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = requestItems.map((item, index) => {
        const product = item.product;
        const cat = product?.product_categories;
        const unit = localizeUnit(item.unit);
        const estSum = item.est_sum !== null ? '₹' + Math.round(item.est_sum).toLocaleString() : '—';

        return `
            <tr>
                <td>
                    <div class="font-medium">${Layout.getName(product)}</div>
                    <div class="text-xs opacity-50">${product?.name_en || ''}</div>
                </td>
                <td>
                    <span class="badge badge-sm" style="background-color: ${cat?.color || '#999'}20; color: ${cat?.color || '#999'}">
                        ${Layout.getName(cat) || '—'}
                    </span>
                </td>
                <td class="text-right">${formatQty(item.needed, item.unit)} ${unit}</td>
                <td class="text-right opacity-60">${formatQty(item.in_stock, item.unit)} ${unit}</td>
                <td class="text-right">
                    <div class="join">
                        <input type="number"
                            class="input input-bordered input-sm join-item w-20 text-right font-bold"
                            style="color: var(--current-color)"
                            value="${formatQty(item.to_purchase, item.unit)}"
                            min="0"
                            step="1"
                            data-action="update-item-quantity" data-index="${index}"
                        />
                        <span class="btn btn-sm join-item no-animation pointer-events-none bg-base-200">${unit}</span>
                    </div>
                    ${product?.waste_percent ? `<div class="text-xs opacity-60 mt-1">(+${product.waste_percent}% на очистку)</div>` : ''}
                </td>
                <td class="text-right opacity-70">${estSum}</td>
                <td>
                    <button class="btn btn-ghost btn-sm btn-square text-error/60 hover:text-error hover:bg-error/10" data-action="remove-item" data-index="${index}" title="${t('remove') || 'Удалить'}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// ==================== ACTIONS ====================
async function saveRequest() {
    if (!window.hasPermission?.('manage_stock_requests')) return;
    if (requestItems.length === 0) {
        showAlert(tr('add_at_least_one', 'Нет продуктов для сохранения'));
        return;
    }

    const periodFrom = Layout.$('#periodFrom').value || null;
    const periodTo = Layout.$('#periodTo').value || null;

    const requestData = {
        location_id: locationId,
        period_from: periodFrom,
        period_to: periodTo,
        status: 'pending'
    };

    const { data: request, error } = await Layout.db
        .from('purchase_requests')
        .insert(requestData)
        .select()
        .single();

    if (error) {
        showAlert(tr('save_error', 'Ошибка сохранения'));
        return;
    }

    // Save quantities in grams for consistency, and price per kg
    const items = requestItems.map(i => ({
        request_id: request.id,
        product_id: i.product_id,
        quantity: toGrams(i.to_purchase, i.unit),
        price: i.last_price  // price per kg at time of request
    }));

    await Layout.db.from('purchase_request_items').insert(items);

    // Fetch the saved request to get the generated number
    const { data: savedReq } = await Layout.db
        .from('purchase_requests')
        .select('id, number')
        .eq('id', request.id)
        .single();

    // Update state with saved request info
    savedRequestId = savedReq?.id || request.id;
    savedRequestNumber = savedReq?.number || request.number;
    nextRequestNumber = null;

    // Сохраняем ID для подсветки
    highlightRequestId = savedRequestId;

    // Очищаем форму
    requestItems = [];

    // Переходим на вкладку сохранённых заявок
    switchTab('saved');
}

function printRequest() {
    window.print();
}

// ==================== TABS ====================
function switchTab(tab) {
    // Update tab buttons
    Layout.$$('.tab[data-tab]').forEach(btn => {
        btn.classList.toggle('tab-active', btn.dataset.tab === tab);
    });

    // Show/hide content
    Layout.$('#tabContentNew').classList.toggle('hidden', tab !== 'new');
    Layout.$('#tabContentSaved').classList.toggle('hidden', tab !== 'saved');
    Layout.$('#tabContentArchive').classList.toggle('hidden', tab !== 'archive');

    // When switching to "new" tab, show choice section
    if (tab === 'new') {
        Layout.$('#requestChoiceSection')?.classList.remove('hidden');
        Layout.$('#resultsSection')?.classList.add('hidden');
    }

    if (tab === 'saved' || tab === 'archive') {
        loadSavedRequests();
    }
}

// ==================== SAVED REQUESTS ====================
async function loadSavedRequests() {
    const { data, error } = await Layout.db
        .from('purchase_requests')
        .select('*, items:purchase_request_items(*, products(*, product_categories(*)))')
        .eq('location_id', locationId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error loading saved requests:', error);
        return;
    }

    // Добавляем данные закупщика из загруженного массива buyers
    savedRequests = (data || []).map(req => ({
        ...req,
        buyer: req.buyer_id ? buyers.find(b => b.id === req.buyer_id) : null
    }));
    renderSavedRequests();
    renderArchivedRequests();
}

function renderRequestCard(req, isArchived = false) {
    const itemsCount = req.items?.length || 0;
    const locale = Layout.currentLang === 'ru' ? 'ru-RU' : 'en-US';

    // Period (only for requests generated from menu)
    const hasPeriod = req.period_from && req.period_to;
    const periodFrom = hasPeriod ? DateUtils.parseDate(req.period_from).toLocaleDateString(locale) : '';
    const periodTo = hasPeriod ? DateUtils.parseDate(req.period_to).toLocaleDateString(locale) : '';

    // Created at with time
    const createdDate = new Date(req.created_at);
    const createdAtStr = createdDate.toLocaleDateString(locale) + ' ' + createdDate.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

    // Calculate total sum
    let totalSum = 0;
    let hasAllPrices = true;
    (req.items || []).forEach(item => {
        if (item.price && item.quantity) {
            totalSum += (item.quantity / 1000) * item.price;
        } else {
            hasAllPrices = false;
        }
    });
    const sumDisplay = totalSum > 0 ? (hasAllPrices ? '' : '≈ ') + '₹' + Math.round(totalSum).toLocaleString() : '';

    // Items list preview
    const itemsList = (req.items || []).map(item => {
        const product = item.products;
        const grams = item.quantity || 0;
        const display = fromGrams(grams);
        const name = Layout.getName(product);
        const qty = formatQty(display.value, display.unit);
        const unit = localizeUnit(display.unit);
        return `${name} ${qty}${unit}`;
    }).join(', ');

    // Подсветка новой заявки
    const isHighlighted = req.id === highlightRequestId;
    const isInProgress = req.status === 'in_progress';
    let cardStyle = '';
    if (isInProgress) {
        cardStyle = 'background-color: rgba(59, 130, 246, 0.1); border: 2px solid #3b82f6;';
    } else if (isHighlighted) {
        cardStyle = 'background-color: rgba(var(--current-color-rgb, 234, 179, 8), 0.15); border: 2px solid var(--current-color);';
    }

    return `
        <div class="bg-base-100 rounded-lg p-4 shadow-sm" style="${cardStyle}" ${isHighlighted ? 'id="highlightedRequest"' : ''}>
            ${isInProgress ? `<div class="text-sm font-medium text-blue-600 mb-4 flex items-center gap-2 flex-wrap">
                <span class="flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    ${tr('request_in_progress', 'Заявка в работе')}
                </span>
                <select class="select select-bordered select-sm" data-action="update-request-buyer" data-id="${req.id}">
                    <option value="">${tr('select_buyer', 'Выбрать закупщика')}</option>
                    ${buyers.map(b => `<option value="${b.id}" ${req.buyer_id === b.id ? 'selected' : ''}>${Layout.getName(b)}</option>`).join('')}
                </select>
            </div>` : ''}
            <div class="flex flex-col md:flex-row md:items-center gap-4">
                <div class="min-w-0 flex-shrink-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-semibold">${tr('request', 'Заявка')} #${formatNumberWithYear(req.number)}</span>
                        <span class="badge badge-sm badge border-base-300 md:hidden">${itemsCount} ${tr('items_short', 'поз.')}</span>
                        ${sumDisplay ? `<span class="badge badge-sm badge border-base-300">${sumDisplay}</span>` : ''}
                    </div>
                    ${hasPeriod ? `<div class="text-sm opacity-60 mt-1">${tr('period', 'Период')}: ${periodFrom} — ${periodTo}</div>` : ''}
                    <div class="text-xs opacity-40 mt-1">
                        ${tr('created', 'Создано')}: ${createdAtStr}
                    </div>
                </div>

                ${itemsList ? `<div class="hidden md:block flex-1 text-sm opacity-60 line-clamp-3 px-4 self-start">${itemsList}</div>` : ''}

                <div class="flex items-center gap-1 flex-shrink-0">
                    <button class="btn btn-ghost btn-sm" data-action="view-saved-request" data-id="${req.id}" title="${tr('view', 'Просмотр')}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                    </button>
                    <button class="btn btn-ghost btn-sm" data-action="print-saved-request" data-id="${req.id}" title="${tr('print', 'Печать')}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                        </svg>
                    </button>
                    ${!isArchived ? `
                        <button class="btn btn-ghost btn-sm ${isInProgress ? 'text-blue-600' : 'text-blue-400'}" data-action="toggle-in-progress" data-id="${req.id}" title="${tr('in_progress', 'В работе')}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="${isInProgress ? '2.5' : '2'}">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                        </button>
                        <button class="btn btn-ghost btn-sm text-warning" data-action="archive-request" data-id="${req.id}" title="${tr('to_archive', 'В архив')}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                            </svg>
                        </button>
                    ` : `
                        <button class="btn btn-ghost btn-sm text-success" data-action="restore-request" data-id="${req.id}" title="${tr('restore', 'Восстановить')}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                            </svg>
                        </button>
                    `}
                    <button class="btn btn-ghost btn-sm text-error" data-action="delete-request" data-id="${req.id}" title="${tr('delete', 'Удалить')}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function renderSavedRequests() {
    const container = Layout.$('#savedRequestsList');
    const filtered = savedRequests.filter(r => r.status !== 'archived');

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 opacity-50">
                <div class="text-4xl mb-2">📋</div>
                <div>${tr('no_active_requests', 'Нет сохранённых заявок')}</div>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(req => renderRequestCard(req, false)).join('');

    // Скролл к подсвеченной заявке и снятие подсветки через 3 секунды
    if (highlightRequestId) {
        const highlighted = Layout.$('#highlightedRequest');
        if (highlighted) {
            highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                highlighted.style.backgroundColor = '';
                highlighted.style.border = '';
                highlightRequestId = null;
            }, 3000);
        }
    }
}

function renderArchivedRequests() {
    const container = Layout.$('#archivedRequestsList');
    const filtered = savedRequests.filter(r => r.status === 'archived');

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 opacity-50">
                <div class="text-4xl mb-2">📦</div>
                <div>${tr('archive_empty', 'Нет заявок в архиве')}</div>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(req => renderRequestCard(req, true)).join('');
}

async function updateRequestBuyer(id, buyerId) {
    const { error } = await Layout.db
        .from('purchase_requests')
        .update({ buyer_id: buyerId || null })
        .eq('id', id);

    if (error) {
        console.error('Error updating buyer:', error);
        showAlert(tr('save_error', 'Ошибка'));
        return;
    }

    // Обновляем локально без перезагрузки
    const req = savedRequests.find(r => r.id === id);
    if (req) {
        req.buyer_id = buyerId || null;
        req.buyer = buyers.find(b => b.id === buyerId) || null;
    }
}

async function toggleInProgress(id) {
    const req = savedRequests.find(r => r.id === id);
    if (!req) return;

    const newStatus = req.status === 'in_progress' ? 'pending' : 'in_progress';

    const { error } = await Layout.db
        .from('purchase_requests')
        .update({ status: newStatus })
        .eq('id', id);

    if (error) {
        console.error('Error updating request status:', error);
        showAlert(tr('save_error', 'Ошибка'));
        return;
    }

    await loadSavedRequests();
}

async function archiveRequest(id) {
    if (!window.hasPermission?.('manage_stock_requests')) return;
    if (!await showConfirm(tr('archive_confirm', 'Переместить в архив?'))) return;

    const { error } = await Layout.db
        .from('purchase_requests')
        .update({ status: 'archived' })
        .eq('id', id);

    if (error) {
        console.error('Error archiving request:', error);
        showAlert(tr('save_error', 'Ошибка'));
        return;
    }

    await loadSavedRequests();
}

async function restoreRequest(id) {
    if (!window.hasPermission?.('manage_stock_requests')) return;
    const { error } = await Layout.db
        .from('purchase_requests')
        .update({ status: 'pending' })
        .eq('id', id);

    if (error) {
        console.error('Error restoring request:', error);
        showAlert(tr('save_error', 'Ошибка'));
        return;
    }

    await loadSavedRequests();
}

async function deleteRequest(id) {
    if (!window.hasPermission?.('manage_stock_requests')) return;
    if (!await showConfirm(tr('permanent_delete_confirm', 'Удалить заявку навсегда? Это действие нельзя отменить!'))) return;

    // Удаляем items
    await Layout.db.from('purchase_request_items').delete().eq('request_id', id);

    // Удаляем заявку
    const { error } = await Layout.db
        .from('purchase_requests')
        .delete()
        .eq('id', id);

    if (error) {
        console.error('Error deleting request:', error);
        showAlert(tr('save_error', 'Ошибка'));
        return;
    }

    await loadSavedRequests();
}

function viewSavedRequest(id) {
    const req = savedRequests.find(r => r.id === id);
    if (!req) return;

    viewingRequest = req;

    // Convert items from grams to display format
    viewingItems = (req.items || []).map(item => {
        const product = item.products;
        const grams = item.quantity || 0;
        const display = fromGrams(grams);
        const lastPrice = item.price || null;

        return {
            id: item.id,
            product_id: item.product_id,
            product,
            quantity: display.value,
            unit: display.unit,
            last_price: lastPrice,
            est_sum: lastPrice ? (grams / 1000) * lastPrice : null
        };
    });

    // Update modal header
    const periodFrom = DateUtils.parseDate(req.period_from).toLocaleDateString('ru-RU');
    const periodTo = DateUtils.parseDate(req.period_to).toLocaleDateString('ru-RU');

    Layout.$('#viewRequestTitle').textContent = `${tr('request', 'Заявка')} #${formatNumberWithYear(req.number)}`;
    Layout.$('#viewRequestPeriod').textContent = `${tr('period', 'Период')}: ${periodFrom} — ${periodTo}`;

    // Print container header
    Layout.$('#printContainerTitle').textContent = `${tr('request', 'Заявка')} #${formatNumberWithYear(req.number)}`;
    Layout.$('#printContainerPeriod').textContent = `${tr('period', 'Период')}: ${periodFrom} — ${periodTo}`;

    // Get location name and set kitchen banner
    const loc = Layout.locations?.find(l => l.slug === Layout.currentLocation);
    if (loc) {
        const kitchenBanner = Layout.$('#printKitchenBanner');
        const kitchenName = Layout.$('#printKitchenName');
        kitchenName.textContent = Layout.getName(loc);

        // Получаем цвет локации из CSS переменных
        const colors = {
            main: '#f49800',  // оранжевый
            cafe: '#10b981',  // зелёный
            guest: '#3b82f6'  // синий
        };
        const color = colors[Layout.currentLocation] || '#f49800';
        kitchenBanner.style.backgroundColor = color;
    }

    renderViewedRequest();
    viewRequestModal.showModal();
}

function renderViewedRequest() {
    const tbody = Layout.$('#viewRequestItems');

    let totalSum = 0;
    let hasAllPrices = true;

    // Группируем по категориям
    const grouped = {};
    viewingItems.forEach((item, index) => {
        const cat = item.product?.product_categories;
        const catId = cat?.id || 'uncategorized';
        if (!grouped[catId]) {
            grouped[catId] = { cat, items: [] };
        }
        grouped[catId].items.push({ ...item, originalIndex: index });
    });

    // Сортируем категории по sort_order
    const sortedGroups = Object.values(grouped).sort((a, b) =>
        (a.cat?.sort_order || 999) - (b.cat?.sort_order || 999)
    );

    let html = '';
    sortedGroups.forEach(group => {
        const cat = group.cat;
        // Заголовок категории
        html += `<tr class="print-category-header"><td colspan="4" class="font-semibold" style="background-color: ${cat?.color || '#999'}15;">${cat?.emoji || ''} ${Layout.getName(cat) || tr('uncategorized', 'Без категории')}</td></tr>`;

        group.items.forEach(item => {
            const index = item.originalIndex;
            const product = item.product;
            const unit = localizeUnit(item.unit);
            const estSum = item.est_sum !== null ? '₹' + Math.round(item.est_sum).toLocaleString() : '—';

            if (item.est_sum !== null) {
                totalSum += item.est_sum;
            } else {
                hasAllPrices = false;
            }

            const translit = product?.translit || Layout.transliterateHindi(product?.name_hi);

            html += `
                <tr>
                    <td colspan="2">
                        <div class="font-medium">${Layout.getName(product)}</div>
                        ${translit ? `<div class="text-xs opacity-50 italic">${translit}</div>` : ''}
                    </td>
                    <td class="text-right">
                        <div class="join no-print">
                            <input type="number"
                                class="input input-bordered input-sm join-item w-20 text-right font-bold"
                                style="color: var(--current-color)"
                                value="${formatQty(item.quantity, item.unit)}"
                                min="0"
                                step="1"
                                data-action="update-viewed-item-qty" data-index="${index}"
                            />
                            <span class="btn btn-sm join-item no-animation pointer-events-none bg-base-200">${unit}</span>
                        </div>
                        <span class="hidden print:inline font-bold" style="color: var(--current-color)">${formatQty(item.quantity, item.unit)} ${unit}</span>
                    </td>
                    <td class="text-right opacity-70 no-print">${estSum}</td>
                    <td class="no-print">
                        <button class="btn btn-ghost btn-sm btn-square text-error/60 hover:text-error hover:bg-error/10" data-action="remove-viewed-item" data-index="${index}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </td>
                </tr>
            `;
        });
    });

    tbody.innerHTML = html;

    // Печатная версия (две колонки) - в отдельном контейнере
    let printHtml = '';
    sortedGroups.forEach(group => {
        const cat = group.cat;
        printHtml += `<div class="print-category">`;
        printHtml += `<div class="print-category-title">${cat?.emoji || ''} ${Layout.getName(cat) || tr('uncategorized', 'Без категории')}</div>`;
        group.items.forEach(item => {
            const product = item.product;
            const unit = localizeUnit(item.unit);
            printHtml += `<div class="print-item">
                <span class="print-item-name">${Layout.getName(product)}</span>
                <span class="print-item-qty">${formatQty(item.quantity, item.unit)} ${unit}</span>
            </div>`;
        });
        printHtml += `</div>`;
    });
    Layout.$('#printContainerItems').innerHTML = printHtml;
    Layout.$('#printContainerCount').textContent = viewingItems.length;

    Layout.$('#viewRequestCount').textContent = viewingItems.length;
    Layout.$('#viewRequestTotal').textContent = totalSum > 0
        ? (hasAllPrices ? '' : '≈ ') + '₹' + Math.round(totalSum).toLocaleString()
        : '—';
}

function updateViewedItemQty(index, value) {
    const qty = parseFloat(value) || 0;
    viewingItems[index].quantity = qty;

    // Recalculate sum
    const item = viewingItems[index];
    if (item.last_price) {
        const grams = item.unit === 'kg' ? qty * 1000 : qty;
        item.est_sum = (grams / 1000) * item.last_price;
    }

    renderViewedRequest();
}

function removeViewedItem(index) {
    viewingItems.splice(index, 1);
    renderViewedRequest();
}

async function saveViewedRequest() {
    if (!viewingRequest) return;

    // Delete old items and insert new ones
    await Layout.db.from('purchase_request_items').delete().eq('request_id', viewingRequest.id);

    const items = viewingItems.map(i => ({
        request_id: viewingRequest.id,
        product_id: i.product_id,
        quantity: toGrams(i.quantity, i.unit),
        price: i.last_price
    }));

    if (items.length > 0) {
        await Layout.db.from('purchase_request_items').insert(items);
    }

    viewRequestModal.close();
    await loadSavedRequests();
}

function printViewedRequest() {
    window.print();
}

function printSavedRequest(id) {
    viewSavedRequest(id);
    setTimeout(() => window.print(), 300);
}

// ==================== EVENT LISTENERS ====================
Layout.$('#periodFrom')?.addEventListener('change', clearPeriodButtons);
Layout.$('#periodTo')?.addEventListener('change', clearPeriodButtons);

window.onLanguageChange = function() {
    Layout.updateAllTranslations();
    if (requestItems.length > 0) renderResults();
    if (savedRequests.length > 0) {
        renderSavedRequests();
        renderArchivedRequests();
    }
};

// Колбэк при смене локации
window.onLocationChange = async function() {
    await loadLocationId();
    await loadStockItems();
    await loadSavedRequests();
    // Сбрасываем текущую заявку при смене локации
    requestItems = [];
    savedRequestId = null;
    generatedEatingCounts = null;
    generatedPeriod = null;
    Layout.$('#resultsSection').classList.add('hidden');
    Layout.$('#requestChoiceSection').classList.remove('hidden');
    renderSavedRequests();
    renderArchivedRequests();
};

// ==================== PRODUCT MODAL ====================
function openProductModalForViewing() {
    openProductModal(true);
}

function openProductModal(forViewing = false) {
    selectedProduct = null;
    currentProductCategory = 'all';
    addingToViewedRequest = forViewing;

    // Reset modal
    Layout.$('#productSearch').value = '';
    Layout.$('#productDropdown').classList.add('hidden');
    Layout.$('#selectedProductDisplay').classList.add('hidden');
    Layout.$('#productQuantitySection').classList.add('hidden');
    Layout.$('#saveProductBtn').disabled = true;

    // Reset tabs
    Layout.$('#tabProductSearch').classList.add('tab-active');
    Layout.$('#tabProductBrowse').classList.remove('tab-active');
    Layout.$('#productSearchTab').classList.remove('hidden');
    Layout.$('#productBrowseTab').classList.add('hidden');

    // Build category buttons
    buildProductCategoryButtons();

    productModal.showModal();
}

function buildProductCategoryButtons() {
    const container = Layout.$('#productCategoryButtons');
    container.innerHTML = `
        <button type="button" class="btn btn-sm filter-btn ${currentProductCategory === 'all' ? 'active' : ''}" data-cat="all" data-action="filter-products-by-category" data-category="all">${t('all') || 'Все'}</button>
        ${productCategories.map(cat => `
            <button type="button" class="btn btn-sm filter-btn ${currentProductCategory === cat.slug ? 'active' : ''}" data-cat="${cat.slug}" data-action="filter-products-by-category" data-category="${cat.slug}">${cat.emoji || ''} ${Layout.getName(cat)}</button>
        `).join('')}
    `;
}

function switchProductTab(tab) {
    if (tab === 'search') {
        Layout.$('#productSearchTab').classList.remove('hidden');
        Layout.$('#productBrowseTab').classList.add('hidden');
        Layout.$('#tabProductSearch').classList.add('tab-active');
        Layout.$('#tabProductBrowse').classList.remove('tab-active');
    } else {
        Layout.$('#productSearchTab').classList.add('hidden');
        Layout.$('#productBrowseTab').classList.remove('hidden');
        Layout.$('#tabProductSearch').classList.remove('tab-active');
        Layout.$('#tabProductBrowse').classList.add('tab-active');
        filterProductsByCategory(currentProductCategory);
    }
}

function filterProducts(query) {
    const dropdown = Layout.$('#productDropdown');

    if (query.length < 1) {
        dropdown.classList.add('hidden');
        return;
    }

    const q = query.toLowerCase();
    const filtered = products.filter(p =>
        p.name_ru?.toLowerCase().includes(q) ||
        p.name_en?.toLowerCase().includes(q) ||
        p.name_hi?.includes(query)
    ).slice(0, 10);

    if (filtered.length === 0) {
        dropdown.innerHTML = `<div class="p-3 text-sm opacity-50">${t('nothing_found') || 'Ничего не найдено'}</div>`;
    } else {
        dropdown.innerHTML = filtered.map(p => {
            const cat = p.product_categories;
            return `
                <div class="p-3 hover:bg-base-200 cursor-pointer border-b border-base-200 last:border-0" data-action="select-product" data-id="${p.id}">
                    <div class="font-medium">${Layout.getName(p)}</div>
                    <div class="text-xs opacity-50">${p.name_en || ''} · ${Layout.getName(cat) || ''}</div>
                </div>
            `;
        }).join('');
    }

    dropdown.classList.remove('hidden');
}

function showProductDropdown() {
    const input = Layout.$('#productSearch');
    if (input.value.length >= 1) {
        filterProducts(input.value);
    }
}

function filterProductsByCategory(category) {
    currentProductCategory = category;
    const list = Layout.$('#productCategoryList');

    // Update buttons
    Layout.$$('#productCategoryButtons .filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.cat === category);
    });

    let filtered = products;
    if (category !== 'all') {
        filtered = products.filter(p => p.product_categories?.slug === category);
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div class="p-3 text-sm opacity-50 text-center">${t('nothing_found') || 'Ничего не найдено'}</div>`;
    } else {
        list.innerHTML = filtered.map(p => {
            const cat = p.product_categories;
            return `
                <div class="p-3 hover:bg-base-200 cursor-pointer border-b border-base-200 last:border-0" data-action="select-product" data-id="${p.id}">
                    <div class="font-medium">${Layout.getName(p)}</div>
                    <div class="text-xs opacity-50">${p.name_en || ''} · ${Layout.getName(cat) || ''}</div>
                </div>
            `;
        }).join('');
    }
}

function selectProduct(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    // Check if already in request (check correct list)
    const itemsList = addingToViewedRequest ? viewingItems : requestItems;
    if (itemsList.some(i => i.product_id === productId)) {
        showAlert(tr('product_already_added', 'Этот продукт уже добавлен в заявку'));
        return;
    }

    selectedProduct = product;

    Layout.$('#productSearchTab').classList.add('hidden');
    Layout.$('#productBrowseTab').classList.add('hidden');
    Layout.$('#productDropdown').classList.add('hidden');
    Layout.$('#selectedProductDisplay').classList.remove('hidden');
    Layout.$('#productQuantitySection').classList.remove('hidden');
    Layout.$('#selectedProductName').textContent = Layout.getName(product);
    Layout.$('#selectedProductNameEn').textContent = product.name_en || '';

    // Set default quantity and unit
    Layout.$('#productQuantity').value = 1;
    Layout.$('#productUnit').textContent = localizeUnit(product.unit || 'kg');

    Layout.$('#saveProductBtn').disabled = false;
}

function clearSelectedProduct() {
    selectedProduct = null;

    if (Layout.$('#tabProductSearch').classList.contains('tab-active')) {
        Layout.$('#productSearchTab').classList.remove('hidden');
        Layout.$('#productSearch').value = '';
    } else {
        Layout.$('#productBrowseTab').classList.remove('hidden');
    }
    Layout.$('#selectedProductDisplay').classList.add('hidden');
    Layout.$('#productQuantitySection').classList.add('hidden');
    Layout.$('#saveProductBtn').disabled = true;
}

function addProductToRequest() {
    if (!selectedProduct) return;

    const quantity = parseFloat(Layout.$('#productQuantity').value) || 1;
    const unit = selectedProduct.unit || 'kg';
    const stock = stockItems.find(s => s.product_id === selectedProduct.id);
    const lastPrice = stock?.last_price || null;

    // Загружаем реальный остаток со склада
    const stockGrams = toGrams(stock?.current_quantity, selectedProduct.unit);
    const inStockInUnit = unit === 'kg' ? stockGrams / 1000 : stockGrams;

    // Процент на очистку
    const wastePercent = selectedProduct.waste_percent || 0;

    // Из того что есть на складе (нечищеного) получится очищенного:
    const stockCleaned = wastePercent > 0
        ? inStockInUnit * (1 - wastePercent / 100)
        : inStockInUnit;

    // Не хватает очищенного:
    const shortageCleaned = Math.max(0, quantity - stockCleaned);

    // Чтобы получить недостающее очищенное, нужно закупить нечищеного:
    const quantityToPurchase = wastePercent > 0
        ? shortageCleaned / (1 - wastePercent / 100)
        : shortageCleaned;

    const quantityGrams = toGrams(quantityToPurchase, unit);

    if (addingToViewedRequest) {
        // Добавляем в просматриваемую заявку
        viewingItems.push({
            id: null, // новый элемент, будет создан при сохранении
            product_id: selectedProduct.id,
            product: selectedProduct,
            quantity: quantityToPurchase,
            unit: unit,
            last_price: lastPrice,
            est_sum: lastPrice ? (quantityGrams / 1000) * lastPrice : null
        });

        productModal.close();
        addingToViewedRequest = false;
        renderViewedRequest();
    } else {
        // Добавляем в новую заявку
        requestItems.push({
            product_id: selectedProduct.id,
            product: selectedProduct,
            needed: quantity,
            in_stock: inStockInUnit,
            to_purchase: quantityToPurchase,
            unit: unit,
            last_price: lastPrice,
            est_sum: lastPrice ? (quantityGrams / 1000) * lastPrice : null
        });

        // Mark as unsaved
        if (savedRequestId) {
            savedRequestId = null;
            Layout.$('#savedBadge').classList.add('hidden');
            Layout.$('#saveBtn').disabled = false;
            Layout.$('#saveBtn').classList.remove('btn-disabled');
        }

        productModal.close();
        renderResults();
    }
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const dropdown = Layout.$('#productDropdown');
    const input = Layout.$('#productSearch');
    if (dropdown && input && !dropdown.contains(e.target) && e.target !== input) {
        dropdown.classList.add('hidden');
    }
});

// Сбрасываем флаг при закрытии модального окна добавления продукта
document.addEventListener('DOMContentLoaded', () => {
    Layout.$('#productModal')?.addEventListener('close', () => {
        addingToViewedRequest = false;
    });
});

// ==================== ITEM EDITING ====================
function updateItemQuantity(index, value) {
    const newQty = parseFloat(value) || 0;
    if (newQty <= 0) {
        removeItem(index);
        return;
    }

    const item = requestItems[index];
    item.to_purchase = newQty;

    // Для ручных позиций (in_stock = 0) обновляем и "нужно"
    if (item.in_stock === 0) {
        item.needed = newQty;
    }

    // Recalculate estimated sum
    const quantityGrams = toGrams(newQty, item.unit);
    item.est_sum = item.last_price ? (quantityGrams / 1000) * item.last_price : null;

    // Mark as unsaved
    if (savedRequestId) {
        savedRequestId = null;
        Layout.$('#savedBadge').classList.add('hidden');
        Layout.$('#saveBtn').disabled = false;
        Layout.$('#saveBtn').classList.remove('btn-disabled');
    }

    renderResults();
}

function removeItem(index) {
    requestItems.splice(index, 1);

    // Mark as unsaved
    if (savedRequestId) {
        savedRequestId = null;
        Layout.$('#savedBadge').classList.add('hidden');
        Layout.$('#saveBtn').disabled = false;
        Layout.$('#saveBtn').classList.remove('btn-disabled');
    }

    renderResults();
}

// ==================== ДЕЛЕГИРОВАНИЕ КЛИКОВ ====================
function setupRequestDelegation(el, actions) {
    if (!el || el._delegated) return;
    el._delegated = true;
    el.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (actions[action]) actions[action](btn);
    });
}

function setupChangeDelegation(el, actions) {
    if (!el || el._changeDelegated) return;
    el._changeDelegated = true;
    el.addEventListener('change', ev => {
        const target = ev.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (actions[action]) actions[action](target);
    });
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'stock', itemId: 'requests' });
    await loadLocationId();
    await Promise.all([loadProducts(), loadProductCategories(), loadStock(), loadRecipes(), loadBuyers()]);
    selectPeriod('today');
    Layout.updateAllTranslations();

    // Делегирование для таблицы позиций заявки
    const itemsTable = Layout.$('#requestItemsTable');
    setupRequestDelegation(itemsTable, {
        'remove-item': btn => removeItem(Number(btn.dataset.index))
    });
    setupChangeDelegation(itemsTable, {
        'update-item-quantity': el => updateItemQuantity(Number(el.dataset.index), el.value)
    });

    // Делегирование для сохранённых заявок
    const savedList = Layout.$('#savedRequestsList');
    setupRequestDelegation(savedList, {
        'view-saved-request': btn => viewSavedRequest(btn.dataset.id),
        'print-saved-request': btn => printSavedRequest(btn.dataset.id),
        'toggle-in-progress': btn => toggleInProgress(btn.dataset.id),
        'archive-request': btn => archiveRequest(btn.dataset.id),
        'delete-request': btn => deleteRequest(btn.dataset.id)
    });
    setupChangeDelegation(savedList, {
        'update-request-buyer': el => updateRequestBuyer(el.dataset.id, el.value)
    });

    // Делегирование для архивных заявок
    const archivedList = Layout.$('#archivedRequestsList');
    setupRequestDelegation(archivedList, {
        'view-saved-request': btn => viewSavedRequest(btn.dataset.id),
        'print-saved-request': btn => printSavedRequest(btn.dataset.id),
        'restore-request': btn => restoreRequest(btn.dataset.id),
        'delete-request': btn => deleteRequest(btn.dataset.id)
    });

    // Делегирование для таблицы просмотра заявки (модалка)
    const viewItems = Layout.$('#viewRequestItems');
    setupRequestDelegation(viewItems, {
        'remove-viewed-item': btn => removeViewedItem(Number(btn.dataset.index))
    });
    setupChangeDelegation(viewItems, {
        'update-viewed-item-qty': el => updateViewedItemQty(Number(el.dataset.index), el.value)
    });

    // Делегирование для модалки продуктов
    const productDropdown = Layout.$('#productDropdown');
    setupRequestDelegation(productDropdown, {
        'select-product': btn => selectProduct(btn.dataset.id)
    });

    const productCatList = Layout.$('#productCategoryList');
    setupRequestDelegation(productCatList, {
        'select-product': btn => selectProduct(btn.dataset.id)
    });

    const productCatBtns = Layout.$('#productCategoryButtons');
    setupRequestDelegation(productCatBtns, {
        'filter-products-by-category': btn => filterProductsByCategory(btn.dataset.category)
    });

    // Realtime: автообновление при изменениях
    subscribeToRealtime();
}

// Realtime подписка на изменения заявок
function subscribeToRealtime() {
    Layout.db.channel('requests-realtime')
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'purchase_requests' },
            handleRealtimeChange
        )
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'stock' },
            handleStockChange
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Realtime: подключено к заявкам');
            }
        });
}

let realtimeTimeout = null;
function handleRealtimeChange(payload) {
    console.log('Realtime изменение заявок:', payload.eventType);
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadSavedRequests();
        Layout.showNotification('Заявки обновлены', 'info');
    }, 500);
}

function handleStockChange(payload) {
    console.log('Realtime изменение склада:', payload.eventType);
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadStock();
    }, 500);
}

init();
