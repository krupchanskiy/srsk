# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ШРСК** (Sri Rupa Seva Kunja) — веб-приложение для управления ашрамом: кухня, проживание и другие сервисы. Мультиязычный интерфейс (русский, английский, хинди) с динамической сменой локаций.

## Technology Stack

- **Frontend**: Vanilla JS + DaisyUI + Tailwind CSS (CDN)
- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **Fonts**: Noto Sans + Noto Sans Devanagari (для хинди)
- **No build step** — HTML файлы открываются напрямую или через локальный сервер

## Development

Сборка не требуется. Для локальной разработки:
```bash
# Простой вариант — открыть HTML напрямую в браузере
open index.html

# Или локальный сервер (для корректной работы с Supabase)
npx serve .
```

## Supabase MCP

Настроен MCP-сервер для прямого доступа к БД. Project ID: `llttmftapmwebidgevmg`

Доступные операции:
- `mcp__supabase__execute_sql` — выполнение SQL-запросов
- `mcp__supabase__apply_migration` — применение миграций
- `mcp__supabase__list_tables` — просмотр схемы
- `mcp__supabase__get_logs` — логи сервисов
- `mcp__supabase__get_advisors` — проверка безопасности

## Architecture

### Core Files

- **js/layout.js** — Единая точка входа для всех страниц:
  - Хедер, футер, навигация
  - Переключение языков и локаций
  - Supabase клиент (`Layout.db`)
  - Функция перевода `Layout.t(key)`
  - Утилиты: `Layout.getName()`, `Layout.pluralize()`, `Layout.debounce()`
  - Прелоадер: `Layout.showLoader()`, `Layout.hideLoader()`
  - Обёрнут в IIFE для изоляции переменных

- **css/common.css** — Общие стили, CSS-переменная `--current-color` для динамического цвета локации

### Page Structure

Каждая страница:
```html
<head>
    <!-- Предзагрузка цвета модуля (предотвращает мигание) -->
    <script>(function(){var c={kitchen:'#f49800',housing:'#8b5cf6'};var m=localStorage.getItem('srsk_module')||'kitchen';document.documentElement.style.setProperty('--current-color',c[m]||c.kitchen);})();</script>
</head>
<body>
    <div id="header-placeholder"></div>
    <main>...</main>
    <div id="footer-placeholder"></div>
    <script src="js/layout.js"></script>
    <script>
        const t = key => Layout.t(key);
        async function init() {
            await Layout.init({ module: 'housing', menuId: 'housing', itemId: 'timeline' });
            Layout.showLoader();
            // load page data...
            Layout.hideLoader();
        }
        init();
    </script>
</body>
```

### i18n System

- Переводы хранятся в таблице `translations` (key → ru, en, hi)
- `Layout.t('key')` возвращает перевод для текущего языка
- `data-i18n="key"` атрибут для автоматического перевода элементов
- `data-i18n-placeholder="key"` для placeholder'ов
- `window.onLanguageChange(lang)` — колбэк при смене языка

### Database Tables

Основные:
- `locations` — кухни (main, cafe, guest) с цветами
- `recipes`, `recipe_categories`, `recipe_ingredients` — рецепты
- `products`, `product_categories`, `product_densities` — продукты и плотности для конвертации единиц
- `units` — единицы измерения (справочник)
- `translations` — переводы интерфейса
- `menu_days`, `menu_items`, `menu_templates` — меню
- `stock`, `stock_requests`, `stock_inventories` — склад и инвентаризация
- `retreats`, `holidays` — ретриты и праздники

Вайшнавы (люди):
- `vaishnavas` — единая таблица для всех людей (гости + команда)
  - `spiritual_teacher` — духовный учитель (для всех)
  - `is_team_member` — флаг принадлежности к команде
  - `department_id` — отдел (для команды)
  - `service` — служение (для команды)
  - `senior_id` → `vaishnavas` — старший (для команды)
- `vaishnava_stays` — периоды пребывания членов команды
- `departments` — отделы (кухня, пуджари и т.д.)

Housing (модуль проживания):
- `buildings`, `building_types` — здания
- `rooms`, `room_types` — комнаты
- `residents`, `resident_categories` — проживающие (связь через `vaishnava_id`)
- `bookings` — бронирования
- `room_cleanings`, `cleaning_tasks` — уборка
- `floor_plans` — планы этажей (SVG)

Регистрации на ретриты:
- `retreat_registrations` — регистрации (связь через `vaishnava_id`)
- `guest_visas`, `guest_payments`, `guest_accommodations`, `guest_transfers` — детали регистрации
- `guest_notes` — заметки о гостях

### SQL Migrations

Файлы в `supabase/` выполняются последовательно по номерам (001-075):
- `001-010` — основная схема, seed-данные, рецепты
- `011-030` — переводы, RLS-политики, склад, команда
- `031-050` — инвентаризация, меню-шаблоны, справочники
- `051-066` — модуль Housing (здания, комнаты, бронирования, уборка)
- `067-075` — модуль Гостей (guests, retreat_registrations, визы, платежи, трансферы)

Применять через MCP `mcp__supabase__apply_migration` или Supabase SQL Editor.

## Key Patterns

### Локализованные имена объектов
```javascript
Layout.getName(item)  // возвращает item.name_ru / name_en / name_hi
```

### Склонение слов
```javascript
const FORMS = {
    ru: ['рецепт', 'рецепта', 'рецептов'],
    en: ['recipe', 'recipes'],
    hi: 'व्यंजन'  // не склоняется
};
Layout.pluralize(5, FORMS)  // "5 рецептов"
```

### Цвет модуля
CSS-переменная `--current-color` определяет акцентный цвет:
- **Kitchen**: `#f49800` (оранжевый)
- **Housing**: `#8b5cf6` (фиолетовый)

Использовать для кнопок, активных табов, подменю. Цвет устанавливается в `<head>` inline-скриптом для предотвращения мигания при загрузке.

### Supabase запросы
```javascript
const { data, error } = await Layout.db
    .from('recipes')
    .select('*, recipe_categories(*)')
    .order('name_ru');
```

## Menu Structure

Два модуля с разными меню (см. `js/layout.js`):

**Kitchen** (кухня):
- kitchen: menu, menu_templates, recipes, products
- stock: stock_balance, requests, receive, issue, inventory, stock_settings
- ashram: retreats, vaishnavas_team
- settings: dictionaries, translations, festivals

**Housing** (проживание):
- housing: timeline, bookings, cleaning
- vaishnavas: vaishnavas_all, vaishnavas_guests, vaishnavas_team
- ashram: retreats
- settings: buildings, rooms, housing_dictionaries

Ключи переводов: `nav_kitchen`, `nav_vaishnavas_team`, etc.

## Language

Весь код, комментарии и коммиты — на русском языке.

## UI/UX Rules

Обязательные правила для интерфейса:

1. **Числовые поля без стрелок** — все `input[type="number"]` должны быть без spinners (стрелок вверх/вниз). Стили уже прописаны в `common.css`.

2. **Цвет локации** — использовать `--current-color` для акцентных элементов.

3. **Трёхязычность** — все тексты должны иметь переводы (ru, en, hi).

## Storage Buckets

Supabase Storage buckets с публичным доступом:
- `vaishnava-photos` — фотографии вайшнавов
- `floor-plans` — планы этажей (SVG)
- `guest-photos` — устаревший, использовать vaishnava-photos

Для каждого bucket должны быть RLS-политики (SELECT, INSERT, UPDATE, DELETE).

## Common Issues

1. **Конфликт имён** — layout.js обёрнут в IIFE, но если объявить `const t` на странице до вызова `Layout.t`, может быть конфликт. Используйте `const t = key => Layout.t(key);` после загрузки layout.js.

2. **RLS на Supabase** — при update/insert с `.select().single()` может вернуть ошибку если RLS не настроен. Используйте `.select()` и берите `result.data?.[0]`.

3. **Storage RLS** — при ошибке "new row violates row-level security policy" для загрузки файлов — проверить RLS-политики для storage.objects.

4. **Skeleton loaders** — HTML содержит skeleton-карточки, которые заменяются после загрузки данных.

5. **N+1 запросы** — избегать циклов с await внутри. Загружать все данные одним запросом с `.in()` и группировать на клиенте:
```javascript
// Плохо: N+1 запросов
for (const booking of bookings) {
    const { data } = await Layout.db.from('residents').select('*').eq('booking_id', booking.id);
}

// Хорошо: 1 запрос
const { data: allResidents } = await Layout.db.from('residents').select('*').in('booking_id', bookingIds);
const grouped = allResidents.reduce((acc, r) => { (acc[r.booking_id] ||= []).push(r); return acc; }, {});
```

## File Locations

```
/                   # корень (index.html, login.html)
├── kitchen/        # рецепты, меню, продукты
├── stock/          # склад, заявки, инвентаризация
├── ashram/         # ретриты, праздники
├── housing/        # проживание, бронирования, уборка
├── vaishnavas/     # люди (команда + гости)
├── settings/       # переводы, пользователи
├── css/            # common.css
├── js/             # layout.js
├── supabase/       # SQL-миграции (001-075)
└── docs/           # документация
```

## Словарь страниц

Быстрый поиск: что где находится.

### vaishnavas/ (Вайшнавы)
| Термин | Файл |
|--------|------|
| Список вайшнавов | `vaishnavas/index.html` |
| Профиль вайшнава | `vaishnavas/person.html` |

### housing/ (Проживание)
| Термин | Файл |
|--------|------|
| Шахматка / Таймлайн | `housing/timeline.html` |
| Бронирования | `housing/bookings.html` |
| Уборка | `housing/cleaning.html` |
| Здания | `housing/buildings.html` |
| Комнаты | `housing/rooms.html` |
| Заполненность | `housing/occupancy.html` |
| Планы этажей | `housing/floor-plan.html` |
| Справочники (housing) | `housing/dictionaries.html` |

### kitchen/ (Кухня)
| Термин | Файл |
|--------|------|
| Рецепты (список) | `kitchen/recipes.html` |
| Рецепт (карточка) | `kitchen/recipe.html` |
| Редактор рецепта | `kitchen/recipe-edit.html` |
| Меню | `kitchen/menu.html` |
| Шаблоны меню | `kitchen/menu-templates.html` |
| Продукты | `kitchen/products.html` |
| Справочники (кухня) | `kitchen/dictionaries.html` |

### stock/ (Склад)
| Термин | Файл |
|--------|------|
| Склад / Остатки | `stock/stock.html` |
| Заявки | `stock/requests.html` |
| Поступление | `stock/receive.html` |
| Выдача / Отпуск | `stock/issue.html` |
| Инвентаризация | `stock/inventory.html` |
| Настройки склада | `stock/stock-settings.html` |

### ashram/ (Ашрам)
| Термин | Файл |
|--------|------|
| Ретриты | `ashram/retreats.html` |
| Праздники | `ashram/festivals.html` |

### settings/ (Настройки)
| Термин | Файл |
|--------|------|
| Переводы | `settings/translations.html` |
| Пользователи | `settings/users.html` |

### Корень
| Термин | Файл |
|--------|------|
| Главная | `index.html` |
| Логин | `login.html` |

## View/Edit Mode Pattern

Страницы профилей (person.html) используют паттерн view/edit:
```html
<div id="profileContainer" class="view-mode">
    <span class="view-only">Значение</span>
    <input class="edit-only" value="...">
</div>
```

```css
.view-mode .edit-only { display: none; }
.edit-mode .view-only { display: none; }
```

```javascript
function enterEditMode() {
    document.getElementById('profileContainer').classList.replace('view-mode', 'edit-mode');
}
```

## Documentation

- **PRODUCT.md** — обзор продукта (частично устарел)
- **docs/guests-plan.md** — план модуля гостей
