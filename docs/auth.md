# Авторизация и права доступа

## Обзор системы

RBAC с кросс-модульными ролями. Права определяются ролями + индивидуальными переопределениями.

### Типы пользователей

| Тип | Регистрация | Одобрение | Доступ |
|-----|-------------|-----------|--------|
| **Guest** (гость) | guest-signup.html | Автоматическое | Гостевой портал + свой профиль |
| **Staff** (команда) | team-signup.html | Требуется | Согласно ролям |
| **Superuser** | `vaishnavas.is_superuser = true` | — | Полный доступ |

---

## Таблицы авторизации

```
modules              # Модули системы (kitchen, housing, crm) — для категоризации
permissions          # Атомарные права (view_menu, edit_products, conduct_inventory)
roles                # Роли (team_member, cook, chef, receptionist, sales_head...)
role_permissions     # Связь ролей и прав
user_roles           # Роли пользователей (комбинируются, is_active)
user_permissions     # Индивидуальные переопределения (is_granted: true/false)
vaishnavas           # Профили людей (user_type, approval_status, is_superuser, is_active)
```

### Как вычисляются права

SQL-функция `get_user_permissions(p_user_id)` (миграция 099):
```
(права из role_permissions через user_roles)
UNION (индивидуально добавленные: user_permissions WHERE is_granted = true)
EXCEPT (индивидуально отобранные: user_permissions WHERE is_granted = false)
```

Суперпользователь — все права из таблицы `permissions` без фильтрации.

### Категории прав (permissions.category)

| Категория | Примеры прав |
|-----------|-------------|
| kitchen | view_menu, edit_menu, view_recipes, edit_products |
| stock | view_stock, receive_stock, issue_stock, conduct_inventory |
| placement | view_preliminary, edit_timeline, manage_arrivals |
| reception | view_rooms, edit_floor_plan, manage_cleaning |
| vaishnavas | view_vaishnavas, create_vaishnava, edit_vaishnava |
| ashram | view_retreats, edit_retreat, view_festivals |
| crm | view_crm, edit_crm, view_crm_dashboard, edit_crm_settings |
| settings | view_translations, manage_users |
| profile | view_own_profile, edit_own_profile, view_own_bookings |
| portal | edit_portal_materials |

---

## Флоу авторизации (auth-check.js)

Подключается на всех защищённых страницах ПЕРЕД layout.js.

```javascript
// 1. Публичные страницы — выход без проверки
const publicPages = ['login.html', 'team-signup.html', 'guest-signup.html', 'pending-approval.html'];
if (publicPages.includes(currentPage)) return;

// 2. Флаг для layout.js: auth запущен, ждите authReady
window._authInProgress = true;

// 3. Проверка сессии
const { data: { session } } = await db.auth.getSession();
if (!session) → редирект на login.html

// 4. Загрузка профиля из vaishnavas
const vaishnava = await db.from('vaishnavas')
    .select('id, spiritual_name, first_name, last_name, photo_url, user_type, approval_status, is_superuser, is_active')
    .eq('user_id', session.user.id).eq('is_deleted', false).single();

// 5. Проверка статуса
if (approval_status === 'pending') → pending-approval.html
if (approval_status === 'rejected' || 'blocked' || !is_active) → signOut + login.html

// 6. Загрузка прав
//    Суперпользователь: все коды из permissions
//    Обычный: RPC get_user_permissions(p_user_id)
const permissions = [...];

// 7. Установка глобальных объектов
window.currentUser = { ...session.user, vaishnava_id, name, photo_url, user_type, is_superuser, permissions };
window.hasPermission = (code) => is_superuser || permissions.includes(code);

// 8. Guest-only detection
//    Если все права ⊂ {view_own_profile, edit_own_profile, view_own_bookings}
//    → редирект на гостевой портал или свой профиль

// 9. CSS-классы на body
document.body.classList.add('user-type-' + user_type);
if (is_superuser) document.body.classList.add('is-superuser');

// 10. applyPermissions() — скрытие элементов по data-permission
//     Вызывается сразу + повторно через 500мс для динамического контента

// 11. Событие готовности
window.dispatchEvent(new CustomEvent('authReady', { detail: window.currentUser }));
```

---

## Auth-First Rendering (layout.js)

**Принцип**: `Layout.init()` ждёт завершения auth-check.js ПЕРЕД рендером навигации. Всё рендерится один раз, сразу правильно — без flash неавторизованных пунктов.

### waitForAuth()

```javascript
function waitForAuth() {
    if (window.currentUser) return Promise.resolve();     // auth уже готов
    if (!window._authInProgress) return Promise.resolve(); // нет auth-check.js (страница без auth)
    return new Promise(resolve => {
        window.addEventListener('authReady', resolve, { once: true });
    });
}
```

Без таймаута — auth-check.js либо завершается, либо делает redirect.

### Порядок инициализации Layout.init()

```
await Promise.all([loadTranslations(), waitForAuth()])   // параллельно!
→ автовыбор доступного модуля (getFirstAccessibleModule)
→ checkPageAccess()                                       // редирект если нет прав
→ getHeaderHTML() / getFooterHTML()                       // уже с фильтрацией!
→ await loadLocations()
→ buildMobileMenu(), buildSubmenuBar()
→ initHeaderEvents(), updateUserInfo()
```

### Автовыбор модуля

Если `localStorage.srsk_module = 'kitchen'`, а у пользователя нет кухонных прав:
```javascript
function getFirstAccessibleModule() {
    const order = ['kitchen', 'housing', 'crm', 'portal', 'admin'];
    // Возвращает первый модуль, где filterMenuByPermissions даёт непустое меню
}
```

---

## Фильтрация навигации по правам

### pagePermissions — карта страница→право

```javascript
const pagePermissions = {
    'kitchen/menu.html': 'view_menu',
    'kitchen/recipes.html': 'view_recipes',
    'stock/stock.html': 'view_stock',
    'stock/requests.html': 'view_requests',
    'placement/timeline.html': 'view_timeline',
    'crm/index.html': 'view_crm',
    'settings/user-management.html': 'manage_users',
    // ... 50+ записей
};
```

Полная карта — в `js/layout.js`, объект `pagePermissions`.

### filterMenuByPermissions(menuConfig)

Фильтрует секции меню модуля: для каждого item проверяет `pagePermissions[item.href]` через `hasPermission()`. Пустые секции удаляются.

**Важно**: если `!window.currentUser` — показывает всё (для страниц без auth-check.js).

### checkPageAccess()

Блокирует прямой переход по URL. Если у пользователя нет права на текущую страницу → `window.location.href = '/'`.

### Фильтрация выпадашки локаций (buildLocationOptions)

- **Кухонные локации** — только при наличии хотя бы одного кухонного права
- **Проживание** — при наличии хотя бы одного housing-права
- **CRM** — при `view_crm`
- **Профиль гостя** — при `edit_portal_materials`
- **Управление** — только `is_superuser`

### Desktop навигация (buildMainNav)

Перестраивает `#mainNav` innerHTML. Использует event delegation (обработчик на `#mainNav`, не на отдельных ссылках) — иначе `buildMainNav()` при смене языка теряет обработчики.

---

## Проверка прав в UI

### 1. HTML-атрибут data-permission (скрытие)

```html
<button data-permission="edit_products">Добавить</button>
```

`applyPermissions()` в auth-check.js скрывает элементы без нужного права. Кнопки/инпуты также получают `disabled = true`.

### 2. HTML-атрибут data-no-permission (обратная логика)

```html
<div data-no-permission="edit_products">У вас нет прав на редактирование</div>
```

Показывается когда права НЕТ, скрывается когда право ЕСТЬ.

### 3. JS проверка

```javascript
if (!window.hasPermission?.('edit_products')) return;
```

### 4. Условный рендеринг

```javascript
const canEdit = window.hasPermission?.('edit_products');
return `${canEdit ? '<button>Редактировать</button>' : ''}`;
```

---

## RLS политики

### SQL-функции для RLS (миграция 049, обновлены в 098b)

```sql
-- Проверка атомарного права
CREATE FUNCTION user_has_permission(perm_code text) RETURNS boolean
-- Логика: role_permissions UNION granted user_permissions EXCEPT revoked user_permissions

-- Проверка доступа к локации
CREATE FUNCTION user_has_location_access(loc_id uuid) RETURNS boolean
-- Проверяет таблицу user_locations
```

Политики используют эти функции для контроля доступа на уровне БД, не только на клиенте.

---

## Суперпользователи

- Флаг `vaishnavas.is_superuser` (boolean)
- Обходят все проверки: `hasPermission()` всегда true, `filterMenuByPermissions()` возвращает всё, `checkPageAccess()` пропускает
- Видят модуль Admin (ashram, settings)
- Получают CSS-класс `body.is-superuser`

---

## Страницы авторизации

| Страница | Назначение |
|----------|------------|
| `login.html` | Вход в систему |
| `guest-signup.html` | Регистрация гостей (автоодобрение) |
| `team-signup.html` | Регистрация команды (требует одобрения) |
| `pending-approval.html` | Ожидание одобрения |

---

## Связанная документация

- [Роли и права — детализация](./roles-permissions.md)
- [Архитектура](./architecture.md)
- [Утилиты](./utilities.md)
