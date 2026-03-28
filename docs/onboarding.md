# Онбординг нового разработчика

## Что такое ШРСК?

**ШРСК** (Sri Rupa Seva Kunja) — веб-приложение для управления ашрамом в Индии. Ашрам принимает гостей на ретриты, обеспечивает проживание, питание и логистику. Приложение автоматизирует все эти процессы.

**Production**: https://in.rupaseva.com

---

## Стек технологий

| Компонент | Технология |
|-----------|-----------|
| **Frontend** | Vanilla JS (без фреймворков, без сборки) |
| **UI** | DaisyUI 4.x + Tailwind CSS (CDN) |
| **Backend/БД** | Supabase (PostgreSQL + Auth + Storage) |
| **Тесты** | Playwright (E2E) |
| **Деплой** | GitHub Pages из ветки `main` |
| **Фото** | AWS Rekognition (распознавание лиц) |
| **Шрифты** | Noto Sans + Noto Sans Devanagari |
| **Языки** | Русский, английский, хинди |

**Ключевое**: сборки нет. HTML-файлы работают напрямую, все зависимости подключаются через CDN. Деплой — это просто пуш в `main`.

---

## Быстрый старт

```bash
# 1. Клонируем репозиторий
git clone <repo-url>
cd ШРСК

# 2. Ставим зависимости (только для тестов)
npm install
npx playwright install

# 3. Запускаем локальный сервер
npm run serve
# → http://localhost:3000

# 4. Запускаем тесты
npm test                    # все тесты
npm run test:headed         # с видимым браузером
npm run test:ui             # с UI-интерфейсом Playwright
npm run test:kitchen        # только тесты кухни
npm run test:housing        # только тесты размещения
```

---

## Модули приложения

Приложение разделено на 5 модулей. Каждый модуль имеет свой цвет (отображается в навигации) и набор страниц.

### Kitchen (Кухня) — оранжевый `#f49800`

Управление питанием: рецепты, планирование меню, продукты, склад (заявки, поступления, выдачи, инвентаризация).

| Папка | Назначение |
|-------|-----------|
| `kitchen/` | Меню, рецепты, продукты, шаблоны меню |
| `stock/` | Складской учёт (остатки, заявки, поступления, выдачи, инвентаризация) |

### Housing (Проживание) — фиолетовый `#8b5cf6`

Самый большой модуль. Люди, размещение по комнатам, заезды/выезды, трансферы, ресепшен.

| Папка | Назначение |
|-------|-----------|
| `vaishnavas/` | База людей — все гости и команда ашрама |
| `placement/` | Шахматка размещения, бронирования, приезды, отъезды, трансферы |
| `reception/` | Здания, комнаты, планы этажей, уборка, список проживающих |

### CRM — зелёный `#10b981`

Воронка продаж для привлечения гостей на ретриты: сделки, задачи, шаблоны сообщений, аналитика.

### Admin (Управление) — серый `#374151`

Только для суперпользователей: ретриты, праздники, переводы интерфейса, управление пользователями.

| Папка | Назначение |
|-------|-----------|
| `ashram/` | Ретриты, расписание, праздники |
| `settings/` | Переводы, управление пользователями |

### Guest Portal (Портал гостя) — отдельное мини-приложение

Гости видят информацию о ретрите, меню, трансферы, фотографии. **Полностью отдельная инфраструктура** — свои `portal-layout.js`, `portal-auth.js` и т.д. Не использует `Layout`, `auth-check.js` и другие глобальные объекты основного приложения.

| Папка | Назначение |
|-------|-----------|
| `guest-portal/` | Все страницы и JS портала гостя |
| `guest-portal/js/` | `portal-layout.js`, `portal-auth.js`, `portal-data.js`, `portal-index.js` |

---

## Структура проекта

```
ШРСК/
├── index.html                # Главная (выбор модуля)
├── login.html                # Вход
├── guest-signup.html         # Регистрация гостей
├── team-signup.html          # Регистрация команды
│
├── js/                       # Ядро системы (15 файлов)
│   ├── config.js             # Supabase credentials
│   ├── color-init.js         # Цвет модуля (загружается первым)
│   ├── cache.js              # Кэширование в localStorage
│   ├── utils.js              # Общие утилиты
│   ├── layout.js             # Центральный хаб: хедер, меню, i18n, утилиты
│   ├── auth-check.js         # Авторизация, права, роли
│   ├── date-utils.js         # ВАЖНО: работа с датами
│   ├── modal-utils.js        # Модальные окна
│   ├── crm-utils.js          # Утилиты CRM
│   ├── vaishnavas-utils.js   # Утилиты для списков людей
│   ├── eating-utils.js       # Утилиты питания
│   ├── translit.js           # Транслитерация (ru→lat, hi→IAST)
│   ├── auto-translate.js     # Автоперевод через MyMemory API
│   ├── permissions-ui.js     # UI управления правами
│   └── pages/                # JS для тяжёлых страниц (11 файлов)
│       ├── timeline.js       # Шахматка размещения
│       ├── preliminary.js    # Управление регистрациями
│       ├── person.js         # Профиль вайшнава
│       ├── bookings.js       # Бронирования
│       ├── departures.js     # Логистика отъездов
│       ├── retreat-guests.js # Гости ретрита
│       ├── kitchen-menu.js   # Планирование меню
│       ├── kitchen-menu-board.js # Доска меню
│       ├── stock-requests.js # Заявки на склад
│       ├── groups.js         # Группы гостей
│       └── retreat-prasad.js # Прасад для ретрита
│
├── css/
│   └── common.css            # Общие стили, переменная --current-color
│
├── kitchen/                  # 8 HTML-страниц
├── stock/                    # 6 HTML-страниц
├── vaishnavas/               # 9 HTML-страниц
├── placement/                # 5 HTML-страниц
├── reception/                # 8 HTML-страниц
├── crm/                      # 11 HTML-страниц
├── ashram/                   # 4 HTML-страницы
├── settings/                 # 3 HTML-страницы
├── guest-portal/             # 8 HTML-страниц + свои JS/CSS
├── photos/                   # 3 HTML-страницы + свои JS
│
├── supabase/                 # 141 SQL-миграция
├── tests/                    # 3 Playwright spec-файла
├── docs/                     # Документация
└── package.json
```

**Всего**: ~90 HTML-страниц, ~37 JS-файлов, 141 SQL-миграция, 7 Edge Functions.

---

## Архитектура: как устроена страница

Каждая HTML-страница — самостоятельная. Нет роутера, нет SPA. Скрипты загружаются в строгом порядке:

```html
<head>
    <script src="js/color-init.js"></script>   <!-- 0. Цвет модуля (предотвращает мерцание) -->
</head>
<body>
    <div id="header-placeholder"></div>        <!-- Хедер (вставляется из layout.js) -->
    <main class="container mx-auto px-4 py-6">
        <!-- Контент страницы -->
    </main>
    <div id="footer-placeholder"></div>

    <!-- Порядок загрузки ВАЖЕН! -->
    <script src="js/config.js"></script>        <!-- 1. Supabase credentials -->
    <script src="js/cache.js"></script>         <!-- 2. Кэширование -->
    <script src="js/utils.js"></script>         <!-- 3. Утилиты -->
    <script src="js/layout.js"></script>        <!-- 4. Layout (хедер, меню, i18n) -->
    <script src="js/date-utils.js"></script>    <!-- 5. Даты (опционально) -->
    <script src="js/auth-check.js"></script>    <!-- 6. Авторизация (опционально) -->
    <script src="js/pages/timeline.js"></script><!-- 7. Page-specific (опционально) -->

    <script>
        async function init() {
            // Инициализация: загружает хедер, меню, переводы
            await Layout.init({
                module: 'housing',
                menuId: 'placement',
                itemId: 'timeline'
            });

            // Загрузка данных страницы
            Layout.showLoader();
            await loadData();
            Layout.hideLoader();
        }

        init();
    </script>
</body>
```

### Порядок инициализации

1. `color-init.js` — устанавливает CSS-переменную `--current-color` по текущему модулю (предотвращает FOUC)
2. `config.js` — создаёт `window.supabaseClient`
3. `cache.js` — `Cache.getOrLoad()`, `Cache.invalidate()`
4. `utils.js` — `Utils.isValidColor()`, `escapeHtml()`
5. `layout.js` — `Layout.init()` загружает хедер, меню, переводы; экспортирует `Layout.db`, `Layout.t()`, `Layout.getName()`, `Layout.handleError()`, `Layout.showNotification()` и т.д.
6. `auth-check.js` — проверяет сессию, загружает профиль и права → `window.currentUser`, `window.hasPermission(code)`
7. `init()` — вызывается на странице, запускает загрузку данных

---

## Глобальные объекты

После инициализации доступны:

| Объект | Что делает | Примеры |
|--------|-----------|---------|
| `Layout.db` | Supabase-клиент | `Layout.db.from('vaishnavas').select('*')` |
| `Layout.t(key)` | Перевод строки | `Layout.t('save')` → `"Сохранить"` |
| `Layout.getName(obj)` | Локализованное имя | `Layout.getName(recipe)` → `recipe.name_ru` |
| `Layout.currentLang` | Текущий язык | `'ru'` / `'en'` / `'hi'` |
| `Layout.showNotification(msg, type)` | Уведомление | `Layout.showNotification('Сохранено', 'success')` |
| `Layout.handleError(err, context)` | Обработка ошибок | `Layout.handleError(error, 'Загрузка')` |
| `Layout.escapeHtml(str)` | XSS-защита | `Layout.escapeHtml(user.name)` |
| `Layout.pluralize(n, forms)` | Склонение | `Layout.pluralize(5, {ru: ['день', 'дня', 'дней']})` |
| `Layout.debounce(fn, ms)` | Дебаунс | Для поиска |
| `DateUtils.parseDate(str)` | Парсинг дат | `DateUtils.parseDate('2026-02-09')` |
| `DateUtils.toISO(date)` | Дата → `YYYY-MM-DD` | `DateUtils.toISO(new Date())` |
| `DateUtils.formatDate(date)` | Дата → отображение | По текущей локали |
| `Cache.getOrLoad(key, fn, ttl)` | Кэш с загрузкой | `Cache.getOrLoad('rooms', loadRooms, 60000)` |
| `Cache.invalidate(key)` | Сброс кэша | `Cache.invalidate('buildings')` |
| `window.currentUser` | Текущий пользователь | `.spiritual_name`, `.is_superuser`, `.permissions` |
| `window.hasPermission(code)` | Проверка права | `hasPermission('edit_products')` |

---

## Работа с базой данных

### Чтение данных

```javascript
const { data, error } = await Layout.db
    .from('vaishnavas')
    .select('id, spiritual_name, first_name, last_name')
    .eq('is_deleted', false)
    .order('spiritual_name');

if (error) {
    Layout.handleError(error, 'Загрузка вайшнавов');
    return;
}
```

### Запись данных

```javascript
const { data, error } = await Layout.db
    .from('recipes')
    .upsert({ id: recipeId, name_ru: 'Дал', ...recipeData })
    .select()
    .single();

if (error) {
    Layout.handleError(error, 'Сохранение');
    return;
}

Layout.showNotification(t('saved'), 'success');
```

### Удаление

```javascript
if (!confirm(t('confirm_delete'))) return;

const { error } = await Layout.db
    .from('recipes')
    .delete()
    .eq('id', id);
```

### Связанные данные (JOIN)

```javascript
// Supabase использует PostgREST — join через скобки
const { data } = await Layout.db
    .from('residents')
    .select(`
        id, check_in, check_out,
        vaishnavas (spiritual_name, first_name, last_name),
        rooms (number, buildings (name_ru))
    `)
    .eq('status', 'active');
```

### Лимит 1000 записей

Supabase по умолчанию возвращает максимум 1000 строк. Если данных больше — используй `.range()`:

```javascript
const { data } = await Layout.db
    .from('vaishnavas')
    .select('*')
    .range(0, 999);  // первая тысяча
```

---

## Ключевые паттерны

### 1. Имена людей (вайшнавов)

У человека может быть духовное имя, а может — только мирское:

```javascript
const name = vaishnava.spiritual_name ||
    `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim();
```

Для многоязычных сущностей (здания, рецепты и т.д.):
```javascript
Layout.getName(building)  // → building.name_ru | name_en | name_hi
```

### 2. Даты — КРИТИЧЕСКИ ВАЖНО

**Главная ловушка**: `new Date('2026-02-09')` парсит дату как UTC, что сдвигает на -1 день в Индии (UTC+5:30).

```javascript
// ПРАВИЛЬНО — парсит как локальное время
const d = DateUtils.parseDate('2026-02-09');

// НЕПРАВИЛЬНО — парсит как UTC, сдвиг на -1 день!
const d = new Date('2026-02-09');  // ❌ НИКОГДА ТАК!
```

**Правило**: все колонки типа `DATE` (`check_in`, `check_out`, `start_date`, `end_date`, `birth_date` и т.д.) — только через `DateUtils.parseDate()`.

**Timestamps** (`created_at`, `flight_datetime`) — можно через `new Date()`, но для TIMESTAMPTZ используй `.slice(0, 16)` перед парсингом:

```javascript
// TIMESTAMPTZ из БД приходит как '2026-02-09T10:30:00+00:00'
// new Date() сдвинет на таймзону браузера
// .slice(0, 16) убирает ложную таймзону
const localDate = new Date(dateFromDb.slice(0, 16));
```

### 3. Event delegation

Вместо навешивания слушателей на каждую кнопку — один слушатель на контейнер:

```html
<!-- В HTML -->
<button data-action="edit" data-id="${item.id}">Ред.</button>
<button data-action="delete" data-id="${item.id}">Удалить</button>
```

```javascript
// В JS
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
        case 'edit': handleEdit(btn.dataset.id); break;
        case 'delete': handleDelete(btn.dataset.id); break;
    }
});
```

### 4. Кэширование

```javascript
// Загрузить с кэшем на 60 секунд
const buildings = await Cache.getOrLoad('buildings', () =>
    Layout.db.from('buildings').select('*').order('sort_order').then(r => r.data),
60000);

// Сбросить кэш после изменения
Cache.invalidate('buildings');
```

Стандартные ключи кэша: `buildings`, `buildings_with_rooms`, `rooms`, `retreats`, `translations`.

### 5. Права доступа

В HTML:
```html
<!-- Показать только если есть право -->
<button data-permission="edit_products">Редактировать</button>

<!-- Показать только если НЕТ права (обратная логика) -->
<div data-no-permission="edit_products">Только для чтения</div>
```

В JS:
```javascript
if (!window.hasPermission?.('edit_products')) return;
if (window.currentUser?.is_superuser) { /* полный доступ */ }
```

### 6. Локализация

В HTML (автоматическая замена текста при смене языка):
```html
<span data-i18n="save">Сохранить</span>
<input data-i18n-placeholder="search_placeholder">
```

В JS:
```javascript
const t = key => Layout.t(key);
t('save')  // → "Сохранить" / "Save" / "सहेजें"
```

### 7. XSS-защита

Всегда экранируй пользовательские данные в шаблонах:

```javascript
Layout.escapeHtml(vaishnava.spiritual_name)
// Или короткий алиас:
e(vaishnava.spiritual_name)
```

### 8. Иконки — только SVG

В проекте используются inline SVG (Heroicons-стиль). **Эмодзи в интерфейсе не используются** — только SVG-иконки:

```html
<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M12 4v16m8-8H4"/>
</svg>
```

---

## Авторизация

### Типы пользователей

| Тип | Регистрация | Доступ |
|-----|-------------|--------|
| **Гость** | `guest-signup.html` | Гостевой портал + свой профиль |
| **Команда** | `team-signup.html` (требуется одобрение) | Согласно ролям |
| **Суперпользователь** | `is_superuser = true` в БД | Полный доступ ко всему |

### Система прав (RBAC)

```
roles (роли: повар, ресепшионист, менеджер...)
  └─ role_permissions (какие права у роли)

vaishnavas (пользователь)
  └─ user_roles (какие роли у пользователя)
  └─ user_permissions (индивидуальные переопределения)
```

Итоговые права = (права из ролей) + (добавленные индивидуально) - (отобранные индивидуально).

---

## Структура базы данных

### Главные сущности

```
vaishnavas              # Все люди (гости + команда)
├── retreat_registrations    # Регистрация на ретрит (статус, питание, даты)
│   └── guest_transfers      # Трансферы (4 направления)
├── residents                # Размещение в комнате (check_in/check_out)
└── crm_deals               # Сделки в CRM

retreats                # Ретриты (start_date, end_date)
buildings → rooms       # Здания → комнаты
recipes → recipe_ingredients → products  # Рецепты → ингредиенты → продукты
```

### Ключевые таблицы

| Таблица | Описание |
|---------|----------|
| `vaishnavas` | Все люди: духовное имя, контакты, фото, отдел |
| `retreats` | Ретриты: даты, название, описание |
| `retreat_registrations` | Кто зарегистрирован на какой ретрит, статус, питание |
| `guest_transfers` | Трансферы: аэропорт ↔ ашрам, рейсы, время |
| `residents` | Кто в какой комнате живёт (check_in/check_out) |
| `buildings` / `rooms` | Здания и комнаты (вместимость, этаж, тип) |
| `recipes` | Рецепты с ингредиентами |
| `products` | Продукты (единицы, категории) |
| `menu_items` / `menu_days` | Меню на дни |
| `stock_*` | Складской учёт |
| `crm_deals` | Сделки CRM |
| `permissions` / `roles` | Система прав |

### Статусы регистраций

```
retreat_registrations.status: 'guest' | 'team' | 'volunteer' | 'vip' | 'cancelled'
retreat_registrations.meal_type: 'prasad' | 'self' | 'child'
```

Отправка других значений вызовет ошибку CHECK constraint.

### Воронка CRM

```
lead → contacted → paid → ready → completed (+ cancelled)
```

### Трансферы (4 направления)

```
arrival           ← из аэропорта
arrival_retreat   ← на ретрит (если не сразу из аэропорта)
departure_retreat ← с ретрита (если не сразу в аэропорт)
departure         ← в аэропорт
```

---

## Миграции БД

141 SQL-миграция в папке `supabase/`. Имена: `001_schema.sql`, `002_recipes.sql`, ..., `141_*.sql`.

Новые миграции применяются через Supabase CLI или MCP:

```bash
# Через CLI (нужен .env.local с токеном)
supabase db push --project-ref mymrijdfqeevoaocbzfy
```

---

## Тесты

3 файла Playwright E2E тестов в `tests/`:

| Файл | Что тестирует |
|------|--------------|
| `kitchen.spec.js` | Кухня: рецепты, меню, продукты |
| `vaishnavas.spec.js` | Люди: создание, редактирование |
| `housing.spec.js` | Размещение: шахматка, комнаты |

```bash
npm test                          # все тесты
npm run test:kitchen              # только кухня
npx playwright test --grep "текст" # один тест по имени
```

Конфиг: `playwright.config.js`, base URL `http://localhost:3000`, locale `ru-RU`.

---

## Edge Functions (Supabase)

7 серверных TypeScript-функций в `supabase/functions/`:

| Функция | Назначение |
|---------|-----------|
| `send-notification` | Push-уведомления |
| `send-invite` | Email-приглашения |
| `telegram-webhook` | Обработка Telegram-бота |
| `daily-photo-notifications` | Ежедневная рассылка о фото |
| `index-faces` | Индексация лиц через AWS Rekognition |
| `search-face` | Поиск по лицу |
| `delete-photos` | Пакетное удаление фото |

Деплой:
```bash
supabase functions deploy <name> --project-ref mymrijdfqeevoaocbzfy --no-verify-jwt
```

---

## Документация

Подробная документация в `docs/`:

| Документ | Содержание |
|----------|------------|
| `architecture.md` | Структура проекта, модули, инициализация |
| `auth.md` | Авторизация, права, роли |
| `database.md` | Все таблицы БД, ключевые поля |
| `utilities.md` | Все глобальные объекты и их API |
| `patterns.md` | Паттерны кода: шаблон страницы, формы, таблицы, модалки |
| `roles-permissions.md` | Матрица ролей и прав |
| `modules/kitchen.md` | Детали модуля Кухня |
| `modules/housing.md` | Детали модуля Проживание |
| `modules/crm.md` | Детали модуля CRM |
| `modules/guest-portal.md` | Детали портала гостя |
| `modules/photos.md` | Модуль фотографий |

---

## Типичные задачи

### Добавить новую страницу

1. Скопируй шаблон из `docs/patterns.md` (раздел «Минимальный шаблон»)
2. Укажи `module`, `menuId`, `itemId` в `Layout.init()`
3. Добавь пункт меню в `layout.js` → `modules` → `menuConfig`
4. Если нужна авторизация — добавь `<script src="js/auth-check.js">` и запись в `pagePermissions`

### Добавить перевод

Переводы хранятся в таблице `translations` в Supabase. Добавь через UI (`settings/translations.html`) или SQL:

```sql
INSERT INTO translations (key, ru, en, hi) VALUES ('my_key', 'Текст', 'Text', 'पाठ');
```

Использование: `Layout.t('my_key')` или `<span data-i18n="my_key">`.

### Добавить новое право

1. Добавь запись в таблицу `permissions` (код, описание, категория)
2. Привяжи к ролям через `role_permissions`
3. В HTML: `data-permission="my_permission"`
4. В JS: `window.hasPermission('my_permission')`
5. В навигации: добавь в `pagePermissions` в `layout.js`

---

## Частые ошибки

| Проблема | Причина и решение |
|----------|-------------------|
| Дата сдвигается на -1 день | Используешь `new Date('YYYY-MM-DD')` → замени на `DateUtils.parseDate()` |
| Не все записи загрузились | Лимит 1000 строк → используй `.range()` для пагинации |
| Переводы не обновляются | Кэш → вызови `Cache.invalidate('translations')` |
| RLS-ошибка (403) | `.single()` не работает с RLS → используй `.select()` + `data[0]` |
| N+1 запросов | Загружай всё через `.in()`, группируй на клиенте |
| JS не обновился после деплоя | Кэш браузера → обнови `?v=N` в `<script src="...js?v=N">` |

---

## Язык

Весь код, комментарии, имена переменных, коммиты — на **русском языке**.
