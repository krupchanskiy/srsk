# Архитектура ШРСК

## Обзор

**ШРСК** (Sri Rupa Seva Kunja) — веб-приложение для управления ашрамом.

- **Frontend**: Vanilla JS + DaisyUI + Tailwind CSS (CDN)
- **Backend**: Supabase (PostgreSQL + Auth + Realtime + Storage)
- **Fonts**: Noto Sans + Noto Sans Devanagari
- **No build step** — HTML файлы работают напрямую

**Production**: https://in.rupaseva.com
**Deployment**: GitHub Pages (автоматически из main)

---

## Структура папок

```
ШРСК/
├── index.html              # Главная страница (выбор модуля)
├── login.html              # Авторизация
├── guest-signup.html       # Регистрация гостей
├── team-signup.html        # Регистрация команды
│
├── js/                     # Ядро системы
│   ├── config.js           # Supabase credentials (ПЕРВЫЙ!)
│   ├── auth-check.js       # Проверка авторизации
│   ├── layout.js           # Хедер, меню, i18n, утилиты
│   ├── color-init.js       # Цвет модуля до рендера
│   ├── cache.js            # localStorage кэширование
│   ├── utils.js            # Общие утилиты
│   ├── crm-utils.js        # Утилиты CRM модуля
│   ├── vaishnavas-utils.js # Утилиты для списков людей
│   ├── date-utils.js       # Работа с датами
│   ├── modal-utils.js      # Модальные окна
│   ├── translit.js         # Транслитерация (ru→lat, hi→IAST)
│   ├── auto-translate.js   # Автоперевод через MyMemory API
│   └── pages/              # JS для отдельных страниц
│
├── css/
│   └── common.css          # Общие стили, --current-color
│
├── kitchen/                # Модуль Кухня
├── stock/                  # Склад (часть Kitchen)
├── vaishnavas/             # База людей (часть Housing)
├── placement/              # Размещение гостей (часть Housing)
├── reception/              # Ресепшен (часть Housing)
├── crm/                    # CRM модуль
├── ashram/                 # Ретриты, праздники
├── settings/               # Настройки (переводы, пользователи)
├── guest-portal/           # Портал гостя (отдельный мини-модуль)
│
├── supabase/               # SQL миграции (001-097+)
└── docs/                   # Документация
```

---

## Модули системы

### Kitchen (Кухня) — цвет #f49800
- Рецепты, меню, продукты
- Склад: остатки, заявки, поступления, выдачи, инвентаризация

### Housing (Проживание) — цвет #8b5cf6
- Вайшнавы: все люди, гости, команда
- Размещение: шахматка, распределение, заезды/выезды, трансферы
- Ресепшен: планы этажей, уборка, здания, комнаты

### CRM — цвет #10b981
- Воронка продаж, сделки, задачи
- Шаблоны сообщений, услуги, валюты

### Admin (Управление) — цвет #374151
**Только для суперпользователей!**
- Ретриты, праздники
- Переводы, управление пользователями

---

## Порядок загрузки скриптов

```html
<head>
    <script src="js/color-init.js"></script>  <!-- Цвет до FOUC -->
</head>
<body>
    <div id="header-placeholder"></div>
    <main>...</main>
    <div id="footer-placeholder"></div>

    <!-- Порядок важен! -->
    <script src="js/config.js"></script>      <!-- 1. Supabase credentials -->
    <script src="js/cache.js"></script>        <!-- 2. Кэширование -->
    <script src="js/utils.js"></script>        <!-- 3. Утилиты -->
    <script src="js/layout.js"></script>       <!-- 4. Хедер, меню, i18n -->
    <script src="js/auth-check.js"></script>   <!-- 5. Авторизация (опционально) -->

    <script>
        const t = key => Layout.t(key);

        async function init() {
            await Layout.init({
                module: 'housing',    // kitchen | housing | crm | admin
                menuId: 'placement',  // секция меню
                itemId: 'timeline'    // активный пункт
            });

            Layout.showLoader();
            // загрузка данных...
            Layout.hideLoader();
        }
        init();
    </script>
</body>
```

---

## Цвета модулей

CSS-переменная `--current-color` определяет акцентный цвет:

| Модуль | Цвет | Hex |
|--------|------|-----|
| Kitchen | Оранжевый | `#f49800` |
| Housing | Фиолетовый | `#8b5cf6` |
| CRM | Изумрудный | `#10b981` |
| Admin | Тёмно-серый | `#374151` |

Устанавливается в `color-init.js` на основе `meta[name="module-color"]` или пути страницы.

```html
<!-- Способ 1: meta-тег -->
<meta name="module-color" content="#8b5cf6">

<!-- Способ 2: автоматически по пути -->
/kitchen/* → #f49800
/crm/* → #10b981
```

---

## Инициализация страницы

### Layout.init(options)

```javascript
await Layout.init({
    module: 'housing',     // Модуль для меню
    menuId: 'placement',   // ID секции меню (для подсветки)
    itemId: 'timeline',    // ID активного пункта
    showLocationSwitcher: true  // Показывать переключатель локаций
});
```

**Что делает:**
1. Загружает переводы из БД (с кэшированием)
2. Вставляет хедер с навигацией
3. Фильтрует меню по правам пользователя
4. Устанавливает текущий язык
5. Подсвечивает активный пункт меню

---

## Supabase MCP

Для операций с БД используется MCP-сервер. Project ID: `llttmftapmwebidgevmg`

```javascript
// Выполнение SQL
mcp__supabase__execute_sql({ project_id, query })

// Применение миграций
mcp__supabase__apply_migration({ project_id, name, query })

// Просмотр таблиц
mcp__supabase__list_tables({ project_id, schemas: ['public'] })

// Логи сервисов
mcp__supabase__get_logs({ project_id, service: 'auth' })

// Проверка безопасности
mcp__supabase__get_advisors({ project_id, type: 'security' })
```

---

## Realtime

Таблицы с подпиской на изменения:
- `residents`, `bookings` — шахматка
- `room_cleanings` — уборка
- `stock`, `purchase_requests` — склад
- `guest_transfers` — трансферы
- `retreat_registrations` — регистрации

```javascript
Layout.db.channel('timeline-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'residents' }, handler)
    .subscribe();
```

---

## Storage Buckets

- `vaishnava-photos` — фотографии людей
- `floor-plans` — планы этажей (SVG)

---

## Связанная документация

- [Авторизация и права](./auth.md)
- [Утилиты](./utilities.md)
- [База данных](./database.md)
- [Паттерны кода](./patterns.md)
