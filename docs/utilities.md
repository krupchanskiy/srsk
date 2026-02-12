# Утилиты

## Глобальные объекты

| Объект | Файл | Описание |
|--------|------|----------|
| `Layout` | layout.js | Хедер, меню, i18n, утилиты |
| `Utils` | utils.js | Вспомогательные функции |
| `Cache` | cache.js | localStorage кэширование |
| `CrmUtils` | crm-utils.js | Утилиты CRM модуля |
| `VaishnavasUtils` | vaishnavas-utils.js | Списки людей |
| `Translit` | translit.js | Транслитерация |
| `AutoTranslate` | auto-translate.js | Автоперевод |

---

## Layout (layout.js)

### Инициализация

```javascript
await Layout.init({
    module: 'housing',         // kitchen | housing | crm | admin
    menuId: 'placement',       // секция меню
    itemId: 'timeline',        // активный пункт
    showLocationSwitcher: true // переключатель локаций
});
```

### Supabase клиент

```javascript
// Доступ к БД
Layout.db.from('recipes').select('*');

// С конкретными полями (рекомендуется)
Layout.db
    .from('recipes')
    .select('id, name_ru, name_en, recipe_categories(id, name_ru)')
    .order('name_ru');
```

### Локализация

```javascript
// Получить перевод
Layout.t('nav_recipes')  // → "Рецепты" (ru) | "Recipes" (en)

// Получить локализованное имя объекта
Layout.getName(recipe)   // → recipe.name_ru | name_en | name_hi

// Текущий язык
Layout.currentLang       // → 'ru' | 'en' | 'hi'
```

**HTML атрибуты:**
```html
<!-- Автоперевод текста -->
<span data-i18n="save">Сохранить</span>

<!-- Автоперевод placeholder -->
<input data-i18n-placeholder="search_placeholder">
```

### Склонение слов

```javascript
const RECIPE_FORMS = {
    ru: ['рецепт', 'рецепта', 'рецептов'],
    en: ['recipe', 'recipes'],
    hi: 'व्यंजन'  // не склоняется
};

Layout.pluralize(5, RECIPE_FORMS)  // → "5 рецептов"
Layout.pluralize(1, RECIPE_FORMS)  // → "1 рецепт"
```

### Прелоадер

```javascript
Layout.showLoader();  // Показать спиннер
Layout.hideLoader();  // Скрыть спиннер
```

### Уведомления

```javascript
// Типы: 'info', 'success', 'warning', 'error'
Layout.showNotification('Сохранено', 'success');
Layout.showNotification('Проверьте данные', 'warning');
Layout.showNotification('Ошибка загрузки', 'error');
```

### Обработка ошибок

```javascript
const { data, error } = await Layout.db.from('recipes').select('*');

if (error) {
    Layout.handleError(error, 'Загрузка рецептов');
    // → Toast: "Ошибка: Загрузка рецептов"
    // → console.error(error)
    return;
}
```

### Форматирование количеств

```javascript
// Округление вверх с учётом единицы
Layout.formatQuantity(0.123, 'g')   // → "0.2"
Layout.formatQuantity(0.123, 'kg')  // → "0.13"
Layout.formatQuantity(0.123, 'pcs') // → "0.13"
```

### Защита от XSS

```javascript
// Экранирование HTML
Layout.escapeHtml('<script>alert("xss")</script>')
// → "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"

// Использование в шаблонах
const html = `<td>${Layout.escapeHtml(user.name)}</td>`;
```

### Debounce

```javascript
// Задержка выполнения (для поиска)
const debouncedSearch = Layout.debounce(() => {
    searchProducts(input.value);
}, 300);

input.addEventListener('input', debouncedSearch);
```

---

## Utils (utils.js)

### Валидация цвета

```javascript
Utils.isValidColor('#ff5500')   // → true
Utils.isValidColor('#f50')      // → false (нужен полный формат)
Utils.isValidColor('red')       // → false
Utils.isValidColor('javascript:alert(1)')  // → false
```

**Использование:**
```javascript
// Защита от XSS через style
const bgColor = Utils.isValidColor(item.color) ? item.color : '#cccccc';
element.style.backgroundColor = bgColor;
```

---

## Cache (cache.js)

### Кэширование с TTL

```javascript
// Загрузить из кэша или выполнить функцию
const translations = await Cache.getOrLoad(
    'translations',           // ключ
    () => loadFromDB(),       // функция загрузки
    1000 * 60 * 60 * 24       // TTL: 24 часа
);

// Сбросить кэш
Cache.invalidate('translations');

// Полная очистка
Cache.clear();
```

### Структура в localStorage

```javascript
{
    "cache_translations": {
        "data": [...],
        "expires": 1706745600000
    }
}
```

---

## CrmUtils (crm-utils.js)

### Константы

```javascript
// Статусы воронки (порядок важен!)
CrmUtils.STATUSES  // ['lead', 'contacted', 'invoice_sent', ...]

// Цвета статусов
CrmUtils.STATUS_COLORS  // { lead: '#ef4444', contacted: '#f97316', ... }

// SVG иконки
CrmUtils.STATUS_SVG_ICONS  // { lead: '<svg>...', ... }
CrmUtils.UI_ICONS          // { edit: '<svg>...', trash: '<svg>...', ... }
CrmUtils.COMM_SVG_ICONS    // { call: '<svg>...', whatsapp: '<svg>...', ... }

// Справочники
CrmUtils.WORK_MODES           // ['active', 'long_term', 'paused']
CrmUtils.SERVICE_CATEGORIES   // ['accommodation', 'meals', 'transport', 'other']
CrmUtils.PAYMENT_TYPES        // ['org_fee', 'accommodation', 'meals', 'deposit', 'other']
CrmUtils.PAYMENT_METHODS      // ['cash', 'card', 'transfer']
CrmUtils.COMMUNICATION_TYPES  // ['call', 'whatsapp', 'telegram', 'email', 'note']
CrmUtils.TASK_PRIORITIES      // ['low', 'normal', 'high', 'urgent']
```

### Форматирование

```javascript
// Деньги
CrmUtils.formatMoney(1500, 'INR')  // → "₹ 1 500"
CrmUtils.formatMoney(100, 'USD')   // → "$ 100"

// Даты (локальное время!)
CrmUtils.formatDate('2026-02-04')      // → "04.02.2026"
CrmUtils.formatDateTime('2026-02-04T10:30:00')  // → "04.02.2026 10:30"
CrmUtils.formatRelativeTime('2026-02-04T09:00:00')  // → "1 ч назад"
```

### Проверки

```javascript
// Заявка без контакта > 24ч
CrmUtils.isOverdue(deal)      // → true/false

// Задача просрочена
CrmUtils.isTaskOverdue(task)  // → true/false

// Сделка активна (не отменена и не завершена)
CrmUtils.isActive(deal)       // → true/false
```

### Работа с гостями

```javascript
// Имя гостя (spiritual_name → first_name last_name → email)
CrmUtils.getGuestName(vaishnava)       // → "Говинда дас"
CrmUtils.getGuestShortName(vaishnava)  // → "Говинда д."
CrmUtils.getGuestContact(vaishnava)    // → "+7999..." или email

// Заполненность профиля
CrmUtils.getProfileCompleteness(vaishnava)  // → 67 (процент)
```

### Статусы

```javascript
// Индекс в воронке
CrmUtils.getStatusIndex('contacted')  // → 1

// Следующий статус
CrmUtils.getNextStatus('contacted')   // → 'invoice_sent'

// Допустимые переходы
CrmUtils.getAllowedTransitions('contacted')  // → ['invoice_sent', 'prepaid', ...]

// Локализованное название
CrmUtils.getStatusLabel('lead')  // → "Новая заявка"

// HTML badge
CrmUtils.getStatusBadge('lead', 'sm')  // → '<span class="badge...">'
```

### Баланс сделки

```javascript
// Расчёт баланса
CrmUtils.getBalance(deal)      // → -5000 (долг)

// HTML с цветом
CrmUtils.getBalanceHtml(deal)  // → '<span class="text-error">-₹ 5 000</span>'
```

### Буфер обмена

```javascript
await CrmUtils.copyToClipboard('Текст для копирования');
// → toast "Скопировано"
```

---

## Translit (translit.js)

### Кириллица → латиница

```javascript
Translit.ru('Привет')  // → "Privet"
Translit.ru('Говинда дас')  // → "Govinda das"
```

### Деванагари → IAST

```javascript
Translit.hi('कृष्ण')   // → "kṛṣṇa"
Translit.hi('राधा')    // → "rādhā"
```

---

## AutoTranslate (auto-translate.js)

### Перевод текста

```javascript
const translated = await AutoTranslate.translate('Привет', 'ru', 'en');
// → "Hello"
```

### Автоперевод формы

Автоматический перевод из _ru полей в _en и _hi:

```javascript
// Настройка для формы
AutoTranslate.setup('#myForm', ['name', 'description']);

// В форме:
// name_ru → автоматически переводится в name_en и name_hi
// description_ru → автоматически переводится в description_en и description_hi
```

**HTML:**
```html
<form id="myForm">
    <input name="name_ru" placeholder="Название (рус)">
    <input name="name_en" placeholder="Name (eng)">
    <input name="name_hi" placeholder="नाम (हिंदी)">
</form>
```

---

## VaishnavasUtils (vaishnavas-utils.js)

### Рендер списков

```javascript
// Рендер строки таблицы
VaishnavasUtils.renderPersonRow(person, options)

// Открыть модалку добавления
VaishnavasUtils.openAddModal()

// Сохранить нового человека
await VaishnavasUtils.saveNewPerson(formData)
```

### Поиск и фильтрация

```javascript
// Загрузка пребываний
const stays = await VaishnavasUtils.loadStays()

// Проверка присутствия
VaishnavasUtils.isPresent(personId, stays)  // → true/false
```

---

## Связанная документация

- [Архитектура](./architecture.md)
- [Паттерны кода](./patterns.md)
