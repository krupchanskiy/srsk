# CLAUDE.md

## Проект

**ШРСК** (Sri Rupa Seva Kunja) — веб-приложение для управления ашрамом.

- **Stack**: Vanilla JS + DaisyUI + Tailwind CSS + Supabase
- **Production**: https://in.rupaseva.com
- **Supabase Project ID**: `llttmftapmwebidgevmg`
- **Языки**: русский, английский, хинди

---

## Документация

### Ядро системы
| Файл | Содержание |
|------|------------|
| [docs/architecture.md](docs/architecture.md) | Структура проекта, модули, инициализация |
| [docs/auth.md](docs/auth.md) | Авторизация, права, роли |
| [docs/utilities.md](docs/utilities.md) | Layout.*, Utils.*, Cache.*, CrmUtils.* |
| [docs/patterns.md](docs/patterns.md) | Паттерны кода: формы, таблицы, модалки |
| [docs/database.md](docs/database.md) | Таблицы БД, связи, типичные запросы |

### Модули
| Файл | Содержание |
|------|------------|
| [docs/modules/kitchen.md](docs/modules/kitchen.md) | Рецепты, меню, продукты, склад |
| [docs/modules/housing.md](docs/modules/housing.md) | Люди, размещение, ресепшен |
| [docs/modules/crm.md](docs/modules/crm.md) | Воронка продаж, сделки, задачи |
| [docs/modules/guest-portal.md](docs/modules/guest-portal.md) | Портал гостя (отдельный дизайн) |

---

## Быстрый старт

### Структура страницы

```html
<head>
    <script src="js/color-init.js"></script>
</head>
<body>
    <div id="header-placeholder"></div>
    <main>...</main>
    <div id="footer-placeholder"></div>

    <script src="js/config.js"></script>
    <script src="js/cache.js"></script>
    <script src="js/utils.js"></script>
    <script src="js/layout.js"></script>
    <script>
        async function init() {
            await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'timeline' });
            // загрузка данных...
        }
        init();
    </script>
</body>
```

### Работа с БД

```javascript
// Загрузка данных
const { data, error } = await Layout.db
    .from('vaishnavas')
    .select('id, spiritual_name, first_name, last_name')
    .order('spiritual_name');

if (error) {
    Layout.handleError(error, 'Загрузка');
    return;
}

// Локализованное имя
Layout.getName(item)  // item.name_ru | name_en | name_hi

// Перевод интерфейса
Layout.t('save')  // "Сохранить"
```

---

## Ключевые правила

### Имена вайшнавов
```javascript
// Правильно: spiritual_name → first_name + last_name
const name = vaishnava.spiritual_name ||
             `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim();
```

### ⚠️ ДАТЫ И ВРЕМЯ — ВСЕГДА ЛОКАЛЬНОЕ ВРЕМЯ! НИКОГДА НЕ UTC!
```javascript
// Правильно
const d = new Date(date);
return `${d.getDate()}.${d.getMonth()+1}.${d.getFullYear()}`;

// Неправильно (сдвигает дату в UTC!)
date.toISOString().split('T')[0];  // ❌
```

**ВАЖНО:** При работе с TIMESTAMPTZ из Supabase — НЕ обрезать строку через `.slice(0, 16)` перед `new Date()`. Таймзона из БД должна сохраняться, чтобы `new Date()` корректно привёл к локальному времени. Все расчёты (приезд = рейс + 4ч, отъезд = рейс − 7ч) — в локальном времени.

### XSS защита
```javascript
// Экранировать пользовательские данные
Layout.escapeHtml(user.name)

// Валидировать цвета
Utils.isValidColor(color) ? color : '#ccc'
```

### Права доступа
```javascript
// Проверка права
if (!window.hasPermission?.('edit_products')) return;

// Ожидание авторизации
await waitForAuth();
if (window.currentUser?.is_superuser) { ... }
```

---

## Модули

| Модуль | Цвет | Папки |
|--------|------|-------|
| Kitchen | #f49800 | kitchen/, stock/ |
| Housing | #8b5cf6 | vaishnavas/, placement/, reception/ |
| CRM | #10b981 | crm/ |
| Admin | #374151 | ashram/, settings/ (только superuser) |

---

## MCP операции

```javascript
mcp__supabase__execute_sql({ project_id, query })
mcp__supabase__apply_migration({ project_id, name, query })
mcp__supabase__list_tables({ project_id, schemas: ['public'] })
mcp__supabase__get_logs({ project_id, service: 'auth' })
```

---

## Частые проблемы

| Проблема | Решение |
|----------|---------|
| Лимит 1000 записей | Пагинация через `.range()` |
| Кэш переводов устарел | `Cache.invalidate('translations')` |
| RLS ошибка | Использовать `.select()` вместо `.single()` |
| N+1 запросы | Загрузить всё через `.in()`, группировать на клиенте |
| Tailwind desktop | Добавить `tailwind.config = { theme: { extend: { screens: { 'desktop': '1200px' } } } }` |

---

## Деплой

- GitHub Pages автоматически из main
- После коммита ~1-2 минуты
- Cache busting: `script.js?v=2`

---

## Язык

Весь код, комментарии и коммиты — на русском языке.
