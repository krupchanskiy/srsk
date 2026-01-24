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
  - Обёрнут в IIFE для изоляции переменных

- **css/common.css** — Общие стили, CSS-переменная `--current-color` для динамического цвета локации

### Page Structure

Каждая страница:
```html
<div id="header-placeholder"></div>
<main>...</main>
<div id="footer-placeholder"></div>
<script src="js/layout.js"></script>
<script>
    const t = key => Layout.t(key);
    async function init() {
        await Layout.init({ menuId: 'kitchen', itemId: 'recipes' });
        // load page data...
    }
    init();
</script>
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
- `team_members`, `retreats`, `holidays` — команда и события

### SQL Migrations

Файлы в `supabase/` выполняются последовательно по номерам (001-045):
- `001-010` — основная схема, seed-данные, рецепты
- `011-030` — переводы, RLS-политики, склад, команда
- `031-045` — инвентаризация, меню-шаблоны, справочники

Применять через Supabase SQL Editor последовательно.

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

### Цвет локации
CSS-переменная `--current-color` автоматически меняется при выборе локации. Использовать для:
- Кнопок: `.btn-primary`
- Активных табов
- Подменю

### Supabase запросы
```javascript
const { data, error } = await Layout.db
    .from('recipes')
    .select('*, recipe_categories(*)')
    .order('name_ru');
```

## Menu Structure

```javascript
menuConfig = [
    { id: 'kitchen', items: ['menu', 'recipes', 'products'] },
    { id: 'stock', items: ['inventory', 'requests'] },
    { id: 'ashram', items: ['retreats', 'team'] },
    { id: 'settings', items: ['general', 'dictionaries', 'holidays', 'translations'] }
]
```

Ключи переводов: `nav_kitchen`, `nav_recipes`, etc.

## Language

Весь код, комментарии и коммиты — на русском языке.

## UI/UX Rules

Обязательные правила для интерфейса:

1. **Числовые поля без стрелок** — все `input[type="number"]` должны быть без spinners (стрелок вверх/вниз). Стили уже прописаны в `common.css`.

2. **Цвет локации** — использовать `--current-color` для акцентных элементов.

3. **Трёхязычность** — все тексты должны иметь переводы (ru, en, hi).

## Common Issues

1. **Конфликт имён** — layout.js обёрнут в IIFE, но если объявить `const t` на странице до вызова `Layout.t`, может быть конфликт. Используйте `const t = key => Layout.t(key);` после загрузки layout.js.

2. **RLS на Supabase** — при update/insert с `.select().single()` может вернуть ошибку если RLS не настроен. Используйте `.select()` и берите `result.data?.[0]`.

3. **Skeleton loaders** — HTML содержит skeleton-карточки, которые заменяются после загрузки данных.

## File Locations

- Страницы: `*.html` в корне
- Прототипы (старые): `Прототипы/`
- Стили: `css/common.css`
- Скрипты: `js/layout.js`
- Миграции: `supabase/*.sql`

## Documentation

- **PRODUCT.md** — обзор продукта, статус страниц, модели данных, роадмап
