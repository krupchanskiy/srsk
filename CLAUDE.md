# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Проект

**ШРСК** (Sri Rupa Seva Kunja) — веб-приложение для управления ашрамом.

- **Stack**: Vanilla JS + DaisyUI + Tailwind CSS + Supabase (без сборки)
- **Production**: https://in.rupaseva.com
- **Supabase Project ID**: `llttmftapmwebidgevmg`
- **Языки интерфейса**: русский, английский, хинди

---

## Команды

```bash
npm run serve          # Локальный сервер на :3000
npm test               # Все Playwright-тесты
npm run test:headed    # Тесты с браузером
npm run test:ui        # Тесты с UI-интерфейсом
npm run test:kitchen   # Только тесты кухни
npm run test:vaishnavas # Только тесты вайшнавов
npm run test:housing   # Только тесты размещения
npm run test:stock     # Только тесты склада
```

Тесты в `tests/*.spec.js`, Playwright config в `playwright.config.js`, base URL `http://localhost:3000`.

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

## Архитектура

### Структура страницы

Каждая HTML-страница загружает скрипты в строгом порядке:

```html
<head>
    <script src="js/color-init.js"></script>   <!-- ПЕРВЫМ — тема модуля -->
</head>
<body>
    <div id="header-placeholder"></div>
    <main>...</main>
    <div id="footer-placeholder"></div>

    <script src="js/config.js"></script>        <!-- Supabase credentials -->
    <script src="js/cache.js"></script>
    <script src="js/utils.js"></script>
    <script src="js/layout.js"></script>
    <script src="js/pages/timeline.js"></script> <!-- Опционально: page-specific JS -->
    <script>
        async function init() {
            await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'timeline' });
            // загрузка данных...
        }
        init();
    </script>
</body>
```

### Page-specific JS (`js/pages/`)

Тяжёлая логика страниц вынесена в отдельные файлы:

| JS-файл | HTML-страница |
|---------|--------------|
| `preliminary.js` | `vaishnavas/preliminary.html` — управление регистрациями на ретрит |
| `timeline.js` | `placement/timeline.html` — шахматка размещения |
| `person.js` | `vaishnavas/person.html` — профиль вайшнава |
| `retreat-guests.js` | `vaishnavas/retreat-guests.html` — гости ретрита |
| `bookings.js` | `placement/bookings.html` — бронирования |
| `kitchen-menu.js` | `kitchen/menu.html` — планирование меню |
| `stock-requests.js` | `stock/requests.html` — заявки на склад |
| `departures.js` | `vaishnavas/departures.html` — логистика отъездов |

### Работа с БД

```javascript
const { data, error } = await Layout.db
    .from('vaishnavas')
    .select('id, spiritual_name, first_name, last_name')
    .order('spiritual_name');

if (error) { Layout.handleError(error, 'Загрузка'); return; }

Layout.getName(item)  // item.name_ru | name_en | name_hi
Layout.t('save')      // "Сохранить" (i18n)
```

### Модули

| Модуль | Цвет | Папки |
|--------|------|-------|
| Kitchen | #f49800 | kitchen/, stock/ |
| Housing | #8b5cf6 | vaishnavas/, placement/, reception/ |
| CRM | #10b981 | crm/ |
| Admin | #374151 | ashram/, settings/ (только superuser) |

---

## Ключевые правила

### Имена вайшнавов
```javascript
// spiritual_name → first_name + last_name
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

**ВАЖНО:** datetime-local инпуты сохраняют время БЕЗ таймзоны → PostgreSQL TIMESTAMPTZ хранит его как UTC. При чтении из БД приходит `+00:00`, и `new Date()` сдвигает на таймзону браузера. Поэтому ВСЕГДА используй `.slice(0, 16)` перед `new Date()` для значений из TIMESTAMPTZ — это убирает ложную таймзону и парсит как локальное время.

### Приоритет дат размещения

Даты заезда/выезда гостя определяются цепочкой fallback (`js/pages/preliminary.js`):

```
resident.check_in/check_out       ← существующее размещение (DATE)
→ arrival/departure_datetime      ← индивидуальная дата приезда/отъезда (TIMESTAMPTZ, .slice(0,10))
→ guest_transfers.flight_datetime ← дата рейса (TIMESTAMPTZ, .slice(0,10))
→ retreat.start_date/end_date     ← даты ретрита (DATE)
```

Занятость комнат считается по **пиковой одновременной** загрузке (sweep line), а не по суммарному количеству проживавших.

### CHECK constraints в БД

```
retreat_registrations.status: 'guest' | 'team' | 'cancelled'
retreat_registrations.meal_type: 'prasad' | 'self' | 'child'
```

Отправка других значений → ошибка 400 от Supabase.

### Категории резидентов и цвета шахматки

Таблица `resident_categories` определяет цвета баров в `timeline.html`:

| Категория | Цвет | ID |
|-----------|------|----|
| Команда | #10b981 (зелёный) | `10c4c929-...` |
| Гость | #3b82f6 (синий) | `6ad3bfdd-...` |
| Участник ретрита | #8b5cf6 (фиолетовый) | `a825c26c-...` |
| Волонтёр | #f59e0b (оранжевый) | `cdb7a43e-...` |
| Важный гость | #f76a3b (красный) | `ab57efc9-...` |

При заселении `category_id` назначается автоматически через `STATUS_CATEGORY_MAP` в `preliminary.js`:
- `reg.status = 'guest'` → Участник ретрита
- `reg.status = 'team'` → Команда
- fallback → Гость

### Трансферы: 4 направления

```
arrival           ← из аэропорта (рейс прилёта)
arrival_retreat   ← на ретрит (если НЕ сразу из аэропорта, direct_arrival=false)
departure_retreat ← с ретрита (если НЕ сразу в аэропорт, direct_departure=false)
departure         ← в аэропорт (рейс вылета)
```

На одного гостя может быть от 0 до 4 трансферов.

### Иконки — только SVG, не эмодзи!

В интерфейсе используются **inline SVG** (Heroicons-стиль) — `<svg>` с `<path stroke-linecap="round">`. Эмодзи (✈️, 🚐, 🏠 и т.д.) **не использовать** — заменять на SVG-иконки. Для такси/трансфера используется фирменная иконка «шашечки» (TAXI-car SVG из `placement/transfers.html`).

### XSS защита
```javascript
Layout.escapeHtml(user.name)                    // экранировать пользовательские данные
Utils.isValidColor(color) ? color : '#ccc'      // валидировать цвета
```

### Права доступа
```javascript
if (!window.hasPermission?.('edit_products')) return;
await waitForAuth();
if (window.currentUser?.is_superuser) { ... }
```

---

## Ключевые таблицы БД

### Связь: ретрит → регистрация → трансферы → размещение

```
retreats (start_date, end_date)
  └─ retreat_registrations (vaishnava_id, arrival_datetime, departure_datetime,
                            meal_type, status, direct_arrival, direct_departure)
       └─ guest_transfers (direction, flight_datetime, flight_number, needs_transfer)
            direction: 'arrival' | 'arrival_retreat' | 'departure_retreat' | 'departure'

vaishnavas (spiritual_name, first_name, last_name, gender, phone, email, ...)
  └─ residents (room_id, retreat_id, check_in DATE, check_out DATE, status, category_id)
       └─ rooms (number, capacity, building_id, floor)
            └─ buildings (name_ru, name_en, name_hi)
```

---

## Миграции

SQL-миграции в `supabase/` нумеруются `001_` — `107_`. Новые миграции через MCP:

```javascript
mcp__supabase__apply_migration({ project_id: 'llttmftapmwebidgevmg', name: '108_description', query: 'SQL...' })
```

Другие MCP-операции:
```javascript
mcp__supabase__execute_sql({ project_id, query })
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
| Tailwind desktop | `tailwind.config = { theme: { extend: { screens: { 'desktop': '1200px' } } } }` |
| Кэш JS после деплоя | Обновить `?v=N` в `<script src="...js?v=N">` |

---

## Деплой

- GitHub Pages автоматически из main
- После коммита ~1-2 минуты
- Нет шага сборки — статические HTML/JS/CSS
- Cache busting: `script.js?v=2`

---

## Язык

Весь код, комментарии и коммиты — на русском языке.
