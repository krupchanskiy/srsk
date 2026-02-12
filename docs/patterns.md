# Паттерны кода

## Структура страницы

### Минимальный шаблон

```html
<!DOCTYPE html>
<html lang="ru" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Название страницы</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>tailwind.config = { theme: { extend: { screens: { 'desktop': '1200px' } } } }</script>
    <link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.22/dist/full.min.css" rel="stylesheet">
    <link rel="stylesheet" href="../css/common.css">
    <script src="../js/color-init.js"></script>
</head>
<body>
    <div id="header-placeholder"></div>

    <main class="container mx-auto px-4 py-6">
        <!-- Контент страницы -->
    </main>

    <div id="footer-placeholder"></div>

    <script src="../js/config.js"></script>
    <script src="../js/cache.js"></script>
    <script src="../js/utils.js"></script>
    <script src="../js/layout.js"></script>
    <script>
        const t = key => Layout.t(key);

        async function init() {
            await Layout.init({
                module: 'housing',
                menuId: 'vaishnavas',
                itemId: 'guests'
            });

            Layout.showLoader();
            await loadData();
            Layout.hideLoader();
        }

        async function loadData() {
            const { data, error } = await Layout.db
                .from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name')
                .order('spiritual_name');

            if (error) {
                Layout.handleError(error, 'Загрузка данных');
                return;
            }

            renderTable(data);
        }

        function renderTable(items) {
            // рендер...
        }

        init();
    </script>
</body>
</html>
```

---

## Работа с данными

### Загрузка с обработкой ошибок

```javascript
async function loadRecipes() {
    const { data, error } = await Layout.db
        .from('recipes')
        .select('id, name_ru, name_en, name_hi, recipe_categories(id, name_ru)')
        .order('name_ru');

    if (error) {
        Layout.handleError(error, 'Загрузка рецептов');
        return [];
    }

    return data || [];
}
```

### Сохранение с уведомлением

```javascript
async function saveRecipe(recipeData) {
    const { data, error } = await Layout.db
        .from('recipes')
        .upsert(recipeData)
        .select()
        .single();

    if (error) {
        Layout.handleError(error, 'Сохранение рецепта');
        return null;
    }

    Layout.showNotification(t('saved'), 'success');
    return data;
}
```

### Удаление с подтверждением

```javascript
async function deleteRecipe(id) {
    if (!confirm(t('confirm_delete'))) return;

    const { error } = await Layout.db
        .from('recipes')
        .delete()
        .eq('id', id);

    if (error) {
        Layout.handleError(error, 'Удаление рецепта');
        return;
    }

    Layout.showNotification(t('deleted'), 'success');
    await loadRecipes();  // перезагрузить список
}
```

---

## Формы и модалки

### Модальное окно (DaisyUI)

```html
<dialog id="editModal" class="modal">
    <div class="modal-box">
        <form method="dialog">
            <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
        </form>
        <h3 class="font-bold text-lg" data-i18n="edit_recipe">Редактирование</h3>

        <form id="editForm" class="space-y-4 mt-4">
            <input type="hidden" name="id">

            <div class="form-control">
                <label class="label">
                    <span class="label-text" data-i18n="name_ru">Название (рус)</span>
                </label>
                <input type="text" name="name_ru" class="input input-bordered" required>
            </div>

            <div class="modal-action">
                <button type="button" class="btn" onclick="editModal.close()">
                    <span data-i18n="cancel">Отмена</span>
                </button>
                <button type="submit" class="btn btn-primary">
                    <span data-i18n="save">Сохранить</span>
                </button>
            </div>
        </form>
    </div>
    <form method="dialog" class="modal-backdrop">
        <button>close</button>
    </form>
</dialog>
```

### Открытие модалки

```javascript
function openEditModal(item = null) {
    const form = document.getElementById('editForm');
    form.reset();

    if (item) {
        form.elements.id.value = item.id;
        form.elements.name_ru.value = item.name_ru || '';
    }

    editModal.showModal();
}
```

### Обработка формы

```javascript
document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const data = {
        id: form.elements.id.value || undefined,
        name_ru: form.elements.name_ru.value.trim()
    };

    if (!data.name_ru) {
        Layout.showNotification('Заполните название', 'warning');
        return;
    }

    const saved = await saveRecipe(data);
    if (saved) {
        editModal.close();
        await loadRecipes();
    }
});
```

---

## Таблицы

### Сортировка

```javascript
let sortField = 'name';
let sortAsc = true;

function sortData(data) {
    return [...data].sort((a, b) => {
        let aVal = a[sortField];
        let bVal = b[sortField];

        // Пустые значения всегда в конец
        if (!aVal && !bVal) return 0;
        if (!aVal) return 1;
        if (!bVal) return -1;

        // Строки
        if (typeof aVal === 'string') {
            aVal = aVal.toLowerCase();
            bVal = bVal.toLowerCase();
        }

        if (aVal < bVal) return sortAsc ? -1 : 1;
        if (aVal > bVal) return sortAsc ? 1 : -1;
        return 0;
    });
}

function setSort(field) {
    if (sortField === field) {
        sortAsc = !sortAsc;
    } else {
        sortField = field;
        sortAsc = true;
    }
    renderTable();
}
```

### Заголовок с иконкой сортировки

```html
<th class="cursor-pointer" onclick="setSort('name')">
    <span data-i18n="name">Название</span>
    <span id="sortIcon_name" class="ml-1"></span>
</th>
```

```javascript
function updateSortIcons() {
    document.querySelectorAll('[id^="sortIcon_"]').forEach(el => el.textContent = '');
    const icon = document.getElementById(`sortIcon_${sortField}`);
    if (icon) icon.textContent = sortAsc ? '↑' : '↓';
}
```

### Поиск с debounce

```javascript
let searchQuery = '';
const debouncedSearch = Layout.debounce(() => {
    renderTable();
}, 300);

function onSearchInput(value) {
    searchQuery = value.toLowerCase();
    debouncedSearch();
}

function filterData(data) {
    if (!searchQuery) return data;
    return data.filter(item =>
        item.name?.toLowerCase().includes(searchQuery) ||
        item.email?.toLowerCase().includes(searchQuery)
    );
}
```

### Поле поиска с крестиком

```html
<div class="relative">
    <input
        type="text"
        id="searchInput"
        class="input input-bordered w-full pr-10"
        placeholder="Поиск..."
        oninput="onSearchInput(this.value); toggleClearBtn()">
    <button
        id="clearSearchBtn"
        class="btn btn-ghost btn-sm absolute right-1 top-1/2 -translate-y-1/2 hidden"
        onclick="clearSearch()">
        ✕
    </button>
</div>
```

```javascript
function toggleClearBtn() {
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('clearSearchBtn');
    btn.classList.toggle('hidden', !input.value);
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    toggleClearBtn();
    onSearchInput('');
}
```

---

## Имена вайшнавов

### Правильное отображение

```javascript
// spiritual_name → first_name + last_name → "Без имени"
function getDisplayName(vaishnava) {
    if (!vaishnava) return '';
    return vaishnava.spiritual_name ||
           `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim() ||
           'Без имени';
}

// В шаблонах
const name = Layout.escapeHtml(getDisplayName(person));
```

---

## Работа с датами

### Форматирование (локальное время!)

```javascript
// ПРАВИЛЬНО — локальное время
function formatDate(date) {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
}

// НЕПРАВИЛЬНО — toISOString() конвертирует в UTC!
function formatDateWRONG(date) {
    return new Date(date).toISOString().split('T')[0];  // ❌
}
```

### Текущая дата для input

```javascript
function getTodayString() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

document.getElementById('dateInput').value = getTodayString();
```

---

## View/Edit режим

```html
<div id="profileContainer" class="view-mode">
    <div class="view-only">
        <span id="nameDisplay">Говинда дас</span>
    </div>
    <div class="edit-only hidden">
        <input type="text" id="nameInput" class="input input-bordered" value="Говинда дас">
    </div>
</div>
```

```css
.view-mode .edit-only { display: none; }
.edit-mode .view-only { display: none; }
.edit-mode .edit-only { display: block; }
```

```javascript
function enterEditMode() {
    document.getElementById('profileContainer').classList.replace('view-mode', 'edit-mode');
}

function exitEditMode() {
    document.getElementById('profileContainer').classList.replace('edit-mode', 'view-mode');
}
```

---

## Авто-расширяемый textarea

```html
<textarea
    class="textarea textarea-bordered w-full auto-resize-textarea"
    rows="1"
    oninput="autoResizeTextarea(this)"></textarea>
```

```javascript
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

// После рендера
setTimeout(() => {
    document.querySelectorAll('.auto-resize-textarea').forEach(autoResizeTextarea);
}, 0);
```

---

## Пагинация Supabase (>1000 записей)

```javascript
async function loadAllTranslations() {
    const allData = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
        const { data, error } = await Layout.db
            .from('translations')
            .select('key, ru, en, hi')
            .range(from, from + pageSize - 1);

        if (error) {
            Layout.handleError(error, 'Загрузка переводов');
            break;
        }

        if (!data || data.length === 0) break;
        allData.push(...data);

        if (data.length < pageSize) break;
        from += pageSize;
    }

    return allData;
}
```

---

## Избежание N+1 запросов

```javascript
// ПЛОХО: N+1 запросов
for (const booking of bookings) {
    const { data } = await Layout.db
        .from('residents')
        .select('*')
        .eq('booking_id', booking.id);
}

// ХОРОШО: 1 запрос
const bookingIds = bookings.map(b => b.id);
const { data: allResidents } = await Layout.db
    .from('residents')
    .select('*')
    .in('booking_id', bookingIds);

// Группировка на клиенте
const residentsByBooking = allResidents.reduce((acc, r) => {
    (acc[r.booking_id] ||= []).push(r);
    return acc;
}, {});
```

---

## Realtime подписки

```javascript
function subscribeToChanges() {
    Layout.db.channel('my-channel')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'residents'
        }, handleChange)
        .subscribe();
}

const handleChange = Layout.debounce(async (payload) => {
    console.log('Change:', payload);
    await loadData();
    renderTable();
}, 500);
```

---

## Цветовая индикация статуса

```javascript
function getStatusClass(resident) {
    const buildingId = resident?.building_id;
    const roomId = resident?.room_id;

    if (buildingId === 'self') {
        return 'bg-error/20';      // Красный — самостоятельно
    }
    if (buildingId && roomId) {
        return 'bg-success/20';    // Зелёный — заселен
    }
    return '';                     // Без цвета — не заселен
}
```

---

## Cache busting

После изменения JS файлов обновить версию:

```html
<script src="../js/pages/preliminary.js?v=2"></script>
```

---

## Связанная документация

- [Архитектура](./architecture.md)
- [Утилиты](./utilities.md)
- [Авторизация](./auth.md)
