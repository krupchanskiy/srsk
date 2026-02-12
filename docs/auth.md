# Авторизация и права доступа

## Обзор системы

Система использует кросс-модульные роли с комбинируемыми правами.

### Типы пользователей

| Тип | Регистрация | Одобрение | Доступ |
|-----|-------------|-----------|--------|
| **Guest** (гость) | guest-signup.html | Автоматическое | Только свой профиль |
| **Staff** (команда) | team-signup.html | Требуется | Согласно ролям |
| **Superuser** | Вручную в БД | — | Полный доступ |

---

## Таблицы авторизации

```
modules              # Модули системы (kitchen, housing) — для категоризации
permissions          # Атомарные права (edit_products, manage_cleaning)
roles                # Роли (team_member, cook, chef, receptionist)
role_permissions     # Связь ролей и прав
user_roles           # Роли пользователей (комбинируются)
user_permissions     # Индивидуальные переопределения
superusers           # UUID суперпользователей (без RLS!)
profiles             # Статус одобрения (approval_status)
vaishnavas           # Профили людей
```

### Категории прав (permissions.category)

| Категория | Описание |
|-----------|----------|
| kitchen | Рецепты, меню, продукты |
| stock | Склад, заявки, инвентаризация |
| placement | Размещение гостей |
| reception | Комнаты, здания, уборка |
| ashram | Ретриты, праздники |
| vaishnavas | База людей |
| settings | Настройки системы |
| profile | Профиль пользователя |

---

## Флоу авторизации

### auth-check.js

Файл подключается на всех защищённых страницах:

```javascript
// 1. Проверка сессии
const { data: { session } } = await supabaseClient.auth.getSession();
if (!session) → редирект на login.html

// 2. Загрузка профиля
const profile = await db.from('profiles').select('*').eq('user_id', userId);

// 3. Проверка статуса
if (profile.approval_status === 'pending') → редирект на pending-approval.html
if (profile.approval_status === 'rejected') → редирект на login.html
if (profile.approval_status === 'blocked') → редирект на login.html

// 4. Загрузка прав
const permissions = await getUserPermissions(userId);

// 5. Установка глобальных объектов
window.currentUser = { ...profile, permissions };
window.hasPermission = (code) => permissions.includes(code);

// 6. Отправка события готовности
window.dispatchEvent(new CustomEvent('authReady', { detail: window.currentUser }));
```

### Ожидание авторизации

Для страниц, которым нужно дождаться загрузки прав:

```javascript
function waitForAuth(maxWait = 3000) {
    return new Promise(resolve => {
        if (window.currentUser) { resolve(); return; }

        const handler = () => resolve();
        window.addEventListener('authReady', handler, { once: true });

        setTimeout(() => {
            window.removeEventListener('authReady', handler);
            resolve();
        }, maxWait);
    });
}

// Использование
await waitForAuth();
if (window.currentUser?.is_superuser) {
    // показать админ-функции
}
```

---

## Проверка прав

### 1. HTML атрибут (скрытие элементов)

```html
<button data-permission="edit_products" onclick="openAddModal()">
    Добавить
</button>
```

Layout.js автоматически скрывает элементы без соответствующего права.

### 2. CSS классы на body

```css
/* Автоматически добавляются auth-check.js */
body.user-type-guest [data-hide-for-guests] { display: none !important; }
body.user-type-guest .edit-action { display: none !important; }
body.is-superuser .admin-only { display: block; }
```

### 3. JS проверка в функциях

```javascript
function openAddModal() {
    if (!window.hasPermission?.('edit_products')) {
        Layout.showNotification('Недостаточно прав', 'error');
        return;
    }
    // открыть модалку...
}
```

### 4. Условный рендеринг

```javascript
function renderTable() {
    const canEdit = window.hasPermission?.('edit_products');

    return items.map(item => `
        <tr>
            <td>${Layout.escapeHtml(item.name)}</td>
            ${canEdit ? `<td><button onclick="edit('${item.id}')">✏️</button></td>` : '<td></td>'}
        </tr>
    `).join('');
}
```

---

## Роли и права

### Встроенные роли

| Роль | Права |
|------|-------|
| `team_member` | Базовый доступ для команды |
| `cook` | Работа с меню и рецептами |
| `chef` | Полный доступ к кухне |
| `warehouse_manager` | Склад и заявки |
| `receptionist` | Комнаты, уборка, здания |
| `organizer` | Размещение, гости, трансферы |
| `guest` | Только свой профиль |

### Основные права

**Kitchen:**
- `edit_products` — редактирование продуктов
- `edit_recipes` — редактирование рецептов
- `edit_menu` — редактирование меню
- `edit_kitchen_dictionaries` — справочники кухни

**Stock:**
- `view_stock` — просмотр склада
- `edit_stock` — редактирование склада
- `manage_requests` — работа с заявками

**Housing:**
- `edit_housing_dictionaries` — справочники проживания
- `edit_floor_plan` — редактирование планов
- `manage_cleaning` — управление уборкой
- `edit_preliminary` — распределение гостей
- `manage_transfers` — управление трансферами

**Profile:**
- `edit_own_profile` — редактирование своего профиля
- `edit_vaishnava` — редактирование любых профилей

**Settings:**
- `edit_translations` — редактирование переводов

---

## Суперпользователи

Суперпользователи:
- Имеют доступ ко всем модулям включая Admin
- Обходят все проверки прав
- Видят всё меню без фильтрации

### Проверка суперпользователя

```javascript
// В auth-check.js
const { data: superuser } = await db
    .from('superusers')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

window.currentUser.is_superuser = !!superuser;
document.body.classList.toggle('is-superuser', !!superuser);
```

### Добавление суперпользователя

```sql
INSERT INTO superusers (user_id) VALUES ('uuid-пользователя');
```

---

## RLS политики

Большинство таблиц используют простые политики:

```sql
-- Полный доступ для authenticated
CREATE POLICY "all_access" ON table_name
FOR ALL USING (true);

-- Справочники: чтение для всех
CREATE POLICY "public_read" ON reference_table
FOR SELECT USING (true);
```

**Важно:** Таблица `superusers` имеет **RLS disabled** для избежания рекурсии.

---

## Страницы авторизации

| Страница | Назначение |
|----------|------------|
| `login.html` | Вход в систему |
| `guest-signup.html` | Регистрация гостей |
| `team-signup.html` | Регистрация команды |
| `pending-approval.html` | Ожидание одобрения |
| `reset-password/` | Сброс пароля |
| `auth-callback/` | Callback OAuth |

---

## Фильтрация меню

Layout.js автоматически фильтрует меню по правам:

```javascript
// js/layout.js
const pagePermissions = {
    'products': 'edit_products',
    'recipes': 'edit_recipes',
    'floor-plan': 'edit_floor_plan',
    // ...
};

function filterMenuByPermissions(menuItems) {
    // Суперпользователи видят всё
    if (currentUser?.is_superuser) return menuItems;

    return menuItems.filter(item => {
        const required = pagePermissions[item.id];
        if (!required) return true;  // Нет ограничений
        return hasPermission(required);
    });
}
```

---

## Связанная документация

- [Архитектура](./architecture.md)
- [Утилиты](./utilities.md)
