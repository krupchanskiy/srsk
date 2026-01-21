# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ШРСК Кухня** (Sri Rupa Seva Kunja Kitchen) — веб-приложение для управления кухней ашрама. Мультиязычный интерфейс (русский, английский, хинди) с динамической сменой локаций (кухонь).

## Technology Stack

- **Frontend**: Vanilla JS + DaisyUI + Tailwind CSS (CDN)
- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **Fonts**: Noto Sans + Noto Sans Devanagari (для хинди)
- **No build step** — HTML файлы открываются напрямую или через локальный сервер

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
- `recipes`, `recipe_categories` — рецепты и категории
- `products`, `product_categories` — продукты
- `units` — единицы измерения (справочник)
- `translations` — переводы интерфейса
- `menu_days`, `menu_items` — меню на дни
- `stock`, `stock_requests` — склад и заявки
- `team_members`, `retreats`, `holidays` — команда и события

### SQL Migrations

Файлы в `supabase/` выполняются последовательно:
```
001_schema.sql      — основная схема
002_seed_recipes.sql — тестовые рецепты
003_translations.sql — таблица переводов + базовые данные
004_translations_pages.sql — доп. переводы
005_missing_translations.sql — недостающие переводы
006_units_table.sql — справочник единиц измерения
```

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
