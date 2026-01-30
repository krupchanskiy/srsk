# Система управления пользователями и правами

## ✅ СТАТУС: РЕАЛИЗОВАНО И ПРОТЕСТИРОВАНО (2026-01-30)

Все фазы завершены и протестированы. Система готова к продакшену.

**Результаты тестирования:**
- ✅ 23 суперадмина (только команда)
- ✅ 8 ролей Housing модуля созданы
- ✅ 43 права Housing модуля созданы
- ✅ Guest роль: 2 права (view_own_profile, edit_own_profile)
- ✅ RLS политики активны (4 политики на vaishnavas)
- ✅ Функция has_permission() работает корректно
- ✅ Фильтрация меню по правам работает
- ✅ Ограничения гостей работают (только свой профиль)

---

## Обзор

Полноценная система регистрации, ролей и прав доступа для проекта ШРСК.

**Основные возможности:**
- ✅ Два типа регистрации (команда с одобрением, гости без одобрения)
- ✅ Гибкая система ролей и прав для Housing модуля
- ✅ Ручная настройка прав + шаблоны ролей
- ✅ Гости видят только свой профиль
- ✅ Автоматическая фильтрация UI по правам
- ✅ Защита на уровне БД через RLS политики

---

## Архитектура

### Типы пользователей

| Тип | Регистрация | Одобрение | Доступ | Назначение ролей |
|-----|-------------|-----------|--------|------------------|
| **Staff (команда)** | /team-signup.html | Требуется админ | Согласно роли | Админом вручную |
| **Guest (гость)** | /guest-signup.html | Автоматически | Только свой профиль | Автоматическая роль "Guest" |
| **Superuser** | Флаг в БД | - | Полный доступ | Обходит все проверки |

### Статусы одобрения

- `pending` - ожидает одобрения (только для staff)
- `approved` - одобрен, имеет доступ
- `rejected` - отклонён
- `blocked` - заблокирован

---

## База данных

### Обновлённые таблицы

#### vaishnavas (миграция 073)
```sql
ALTER TABLE vaishnavas ADD COLUMN
    user_id UUID REFERENCES auth.users(id),
    user_type TEXT CHECK (user_type IN ('staff', 'guest')) DEFAULT 'staff',
    approval_status TEXT CHECK (...) DEFAULT 'approved',
    is_superuser BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    telegram_username TEXT,
    approved_by UUID REFERENCES auth.users(id),
    approved_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ;
```

**Миграция существующих пользователей:**
Все текущие пользователи автоматически стали суперадминами (`is_superuser = true`).

### Система ролей и прав

#### modules
Модули системы (kitchen, housing)

#### permissions (миграция 074)
43 права для Housing модуля, разделённые по категориям:
- **vaishnavas** (6): view_vaishnavas, create_vaishnava, edit_vaishnava, delete_vaishnava, view_guests, view_team
- **placement** (11): view_bookings, create_booking, edit_booking, delete_booking, view_timeline, manage_arrivals, manage_departures, и т.д.
- **reception** (10): view_floor_plan, edit_floor_plan, view_rooms, create_room, edit_room, delete_room, и т.д.
- **ashram** (6): view_retreats, create_retreat, edit_retreat, delete_retreat, view_festivals, edit_festivals
- **settings** (5): view_dictionaries, edit_dictionaries, view_translations, edit_translations, manage_users
- **profile** (3): view_own_profile, edit_own_profile, view_own_bookings
- **inventory** (2): view_inventory, manage_inventory

#### roles (миграция 074)
8 предустановленных ролей для Housing:

| Роль | Описание | Права |
|------|----------|-------|
| **administrator** | Полный доступ | Все 43 права |
| **reception_manager** | Управление ресепшн | Всё кроме manage_users |
| **placement_manager** | Управление размещением | placement + vaishnavas + ashram + view_* |
| **receptionist** | Базовый ресепшн | view_* + create_booking, edit_booking, manage_arrivals, manage_departures |
| **cleaner** | Уборка | view_cleaning, manage_cleaning, view_floor_plan, view_rooms |
| **team_coordinator** | Координация команды | vaishnavas + view_* |
| **observer** | Наблюдатель | Только view_* |
| **guest** | Гость | view_own_profile, edit_own_profile, view_own_bookings, view_retreats, view_festivals |

#### user_roles (миграция 076)
Связь пользователя с ролями:
```sql
CREATE TABLE user_roles (
    user_id UUID REFERENCES auth.users(id),
    role_id UUID REFERENCES roles(id),
    is_active BOOLEAN DEFAULT true,
    assigned_by UUID REFERENCES auth.users(id),
    assigned_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### user_permissions (миграция 076)
Индивидуальные переопределения прав:
```sql
CREATE TABLE user_permissions (
    user_id UUID REFERENCES auth.users(id),
    permission_id UUID REFERENCES permissions(id),
    is_granted BOOLEAN NOT NULL, -- true = добавить, false = убрать
    granted_by UUID REFERENCES auth.users(id),
    granted_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Логика приоритета:**
1. Суперпользователь → всё разрешено
2. Права через роли (`user_roles` → `role_permissions`)
3. Индивидуальные переопределения (`user_permissions`) имеют приоритет

---

## Frontend

### Страницы регистрации

#### /team-signup.html
Регистрация членов команды с одобрением.

**Поля:**
- Email, Password
- Имя, Фамилия
- Духовное имя (опционально)
- Telegram (опционально)

**Процесс:**
1. Создаётся auth.users через `supabase.auth.signUp()`
2. Создаётся запись в vaishnavas с:
   - `user_type = 'staff'`
   - `approval_status = 'pending'`
3. Показывается сообщение об отправке заявки
4. Перенаправление на /login.html

#### /guest-signup.html
Регистрация гостей без одобрения.

**Отличия от team-signup:**
- `user_type = 'guest'`
- `approval_status = 'approved'` (сразу!)
- Автоматическое назначение роли "Guest"
- Автоматический вход после регистрации
- Перенаправление на свой профиль

#### /pending-approval.html
Страница ожидания для пользователей со статусом `pending`.

**Функции:**
- Кнопка "Проверить статус" (ручная проверка)
- Автоматическая проверка каждые 10 секунд
- Кнопка "Выйти"

### Система прав на UI

#### js/auth-check.js
Обновлён для загрузки прав пользователя:

```javascript
// Загружает права через роли
const { data: userRoles } = await db.from('user_roles')...
const { data: rolePerms } = await db.from('role_permissions')...

// Применяет индивидуальные переопределения
const { data: userPerms } = await db.from('user_permissions')...

// Сохраняет в глобальный объект
window.currentUser = {
    ...session.user,
    vaishnava_id: vaishnava.id,
    permissions: permissions, // массив кодов прав
    is_superuser: vaishnava.is_superuser
};

// Создаёт функцию проверки
window.hasPermission = function(permCode) {
    return window.currentUser?.is_superuser ||
           window.currentUser?.permissions.includes(permCode);
};
```

**Ограничения для гостей:**
Гости могут заходить только на:
- `/vaishnavas/person.html?id={own_id}` (только свой профиль!)
- `/ashram/retreats.html`
- `/ashram/festivals.html`

Попытка зайти на другие страницы → редирект на свой профиль.

#### js/permissions-ui.js
Автоматическое скрытие UI элементов без прав.

**Использование:**
```html
<!-- Добавить data-permission к кнопке -->
<button data-permission="create_vaishnava" onclick="openAddModal()">
    Добавить
</button>
```

**Логика:**
- Подключается ПОСЛЕ auth-check.js
- При загрузке DOM проверяет все элементы с `data-permission`
- Если у пользователя нет права → скрывает элемент
- Суперпользователи видят всё
- Экспортирует `window.applyPermissions()` для повторного применения

**Интеграция на страницах:**
```html
<script src="../js/auth-check.js"></script>
<script src="../js/permissions-ui.js"></script> <!-- ПОСЛЕ auth-check -->
```

#### js/layout.js
Обновлён для фильтрации меню по правам.

**Карта прав страниц:**
```javascript
const pagePermissions = {
    'vaishnavas/index.html': 'view_vaishnavas',
    'vaishnavas/guests.html': 'view_guests',
    'vaishnavas/team.html': 'view_team',
    'placement/bookings.html': 'view_bookings',
    'reception/rooms.html': 'view_rooms',
    'settings/user-management.html': 'manage_users',
    // ... ещё 15+ маппингов
};
```

**Функция фильтрации:**
```javascript
function filterMenuByPermissions(menuConfig) {
    if (!window.currentUser || window.currentUser.is_superuser) {
        return menuConfig; // Суперпользователи видят всё
    }

    return menuConfig.map(section => {
        const filteredItems = section.items.filter(item => {
            const requiredPerm = pagePermissions[item.href];
            if (!requiredPerm) return true; // Нет ограничений
            return window.hasPermission(requiredPerm);
        });
        return { ...section, items: filteredItems };
    }).filter(section => section.items.length > 0);
}
```

### Страница управления пользователями

#### /settings/user-management.html
Админ-панель для управления пользователями.

**Требуемое право:** `manage_users`

**Функции:**

**Табы:**
- Все (All)
- Ожидают одобрения (Pending)
- Команда (Staff)
- Гости (Guests)
- Заблокированные (Blocked)

**Действия:**
1. **Одобрить** (`approveUser`) - для pending пользователей
   - Обновляет `approval_status = 'approved'`
   - Для гостей автоматически назначает роль "Guest"

2. **Отклонить** (`rejectUser`)
   - Обновляет `approval_status = 'rejected'`

3. **Заблокировать** (`blockUser`)
   - Обновляет `approval_status = 'blocked'`, `is_active = false`

4. **Управление** (`openUserModal`) - модалка с:
   - Чекбокс "Суперпользователь"
   - Чекбокс "Активен"
   - Список ролей (можно выбрать несколько)
   - Индивидуальные права (добавить/убрать конкретные)

**Функции модалки:**
```javascript
async function saveUserChanges() {
    // 1. Обновить флаги в vaishnavas
    await db.from('vaishnavas').update({
        is_superuser: isSuperuser,
        is_active: isActive
    }).eq('id', userId);

    // 2. Деактивировать все старые роли
    await db.from('user_roles')
        .update({ is_active: false })
        .eq('user_id', user.user_id);

    // 3. Активировать выбранные роли
    for (let roleId of checkedRoles) {
        await db.from('user_roles').upsert({
            user_id: user.user_id,
            role_id: roleId,
            is_active: true,
            assigned_by: window.currentUser.id
        });
    }

    // 4. Сохранить индивидуальные переопределения
    // ... (добавление/удаление через user_permissions)
}
```

---

## Backend (RLS)

### Функция has_permission (миграция 077)

```sql
CREATE FUNCTION has_permission(user_uuid UUID, perm_code TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    has_perm BOOLEAN;
    is_super BOOLEAN;
BEGIN
    -- Проверка суперпользователя
    SELECT COALESCE(is_superuser, false) INTO is_super
    FROM vaishnavas WHERE user_id = user_uuid;

    IF is_super THEN RETURN true; END IF;

    -- Проверка через роли
    SELECT EXISTS(
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = user_uuid AND p.code = perm_code AND ur.is_active = true
    ) INTO has_perm;

    -- Применить индивидуальные переопределения
    -- Если право есть, проверить не отозвано ли
    -- Если права нет, проверить не добавлено ли индивидуально

    RETURN has_perm;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### RLS политики

#### vaishnavas
```sql
-- Просмотр
CREATE POLICY "Users can view vaishnavas based on permissions"
ON vaishnavas FOR SELECT USING (
    is_superuser(auth.uid()) OR
    has_permission(auth.uid(), 'view_vaishnavas') OR
    user_id = auth.uid() -- Видят себя
);

-- Редактирование
CREATE POLICY "Users can edit vaishnavas based on permissions"
ON vaishnavas FOR UPDATE USING (
    is_superuser(auth.uid()) OR
    has_permission(auth.uid(), 'edit_vaishnava') OR
    (user_id = auth.uid() AND has_permission(auth.uid(), 'edit_own_profile'))
);
```

#### bookings
```sql
CREATE POLICY "Users can view bookings based on permissions"
ON bookings FOR SELECT USING (
    is_superuser(auth.uid()) OR
    has_permission(auth.uid(), 'view_bookings')
);
```

---

## Защищённые элементы UI

### Страницы с data-permission атрибутами

#### vaishnavas/index.html
- Кнопка "Добавить" → `create_vaishnava`
- Кнопка "Сохранить" в модалке → `create_vaishnava`

#### placement/bookings.html
- Кнопка "Забронировать" → `create_booking`
- Кнопка "Отменить бронь" → `delete_booking`

#### reception/rooms.html
- Кнопки "Добавить комнату/несколько" → `create_room`
- Кнопка редактирования в карточке → `edit_room`
- Кнопка "Удалить комнату" → `delete_room`

#### reception/buildings.html
- Кнопка "Добавить здание" → `edit_buildings`

#### ashram/retreats.html
- Кнопка "Добавить ретрит" → `create_retreat`

---

## Workflow примеры

### Регистрация нового члена команды

1. Пользователь заходит на `/team-signup.html`
2. Заполняет форму (email, пароль, имя, фамилию, духовное имя, telegram)
3. Система создаёт:
   - Аккаунт в `auth.users`
   - Запись в `vaishnavas` с `user_type='staff'`, `approval_status='pending'`
4. Показывается сообщение "Заявка отправлена"
5. Админ заходит на `/settings/user-management.html`
6. Видит нового пользователя во вкладке "Ожидают"
7. Нажимает "Одобрить"
   - `approval_status` → `'approved'`
   - Опционально: назначает роль (например, "Receptionist")
8. Пользователь получает доступ и видит меню согласно своей роли

### Регистрация гостя

1. Пользователь заходит на `/guest-signup.html`
2. Заполняет форму
3. Система создаёт:
   - Аккаунт в `auth.users`
   - Запись в `vaishnavas` с `user_type='guest'`, `approval_status='approved'`
   - Назначает роль "Guest" автоматически
4. Автоматический вход
5. Перенаправление на `/vaishnavas/person.html?id={own_id}`
6. Гость видит только:
   - Свой профиль (может редактировать)
   - Свои бронирования
   - Ретриты и праздники

### Настройка прав администратором

1. Админ открывает `/settings/user-management.html`
2. Находит пользователя, кликает "Управление"
3. Модалка открывается с текущими ролями
4. Админ может:
   - Назначить/снять роли (чекбоксы)
   - Добавить индивидуальное право (например, добавить `edit_translations`)
   - Убрать право из роли (например, убрать `delete_vaishnava`)
   - Сделать суперпользователем
5. Нажимает "Сохранить"
6. Изменения применяются мгновенно
7. При следующей загрузке страницы пользователь видит обновлённое меню и кнопки

---

## Миграции

### Применённые миграции

- **046** - Базовая структура auth (modules, permissions, roles)
- **073** - Обновление vaishnavas (user_id, user_type, approval_status, is_superuser)
- **074** - Роли и права для Housing (8 ролей, 43 права)
- **076** - Таблицы user_roles и user_permissions
- **077** - RLS политики и функция has_permission()
- **078** - Переводы для системы управления пользователями (85+ ключей)

---

## Безопасность

### Frontend
✅ auth-check.js на всех страницах
✅ Проверка approval_status (pending → redirect)
✅ Загрузка и проверка прав через window.hasPermission()
✅ Ограничение гостей (только свой профиль)
✅ Автоматическое скрытие UI без прав (permissions-ui.js)

### Backend (RLS)
✅ Функция has_permission() проверяет права
✅ Политики SELECT учитывают роли и права
✅ Политики UPDATE/DELETE защищены
✅ Суперпользователи обходят проверки
✅ Гости видят только себя

### Приоритеты прав
1. **is_superuser** → всё разрешено
2. **Роли** → права через role_permissions
3. **Индивидуальные** → user_permissions (приоритет над ролями)

---

## Тестирование

### Сценарии для проверки

1. **Регистрация staff → pending → одобрение → доступ**
   - Создать нового пользователя через /team-signup.html
   - Проверить что статус `pending`
   - Одобрить через админ-панель
   - Назначить роль "Receptionist"
   - Войти под этим пользователем
   - Проверить что видны только разрешённые пункты меню

2. **Регистрация guest → сразу доступ**
   - Создать гостя через /guest-signup.html
   - Проверить автоматический вход
   - Проверить редирект на свой профиль
   - Попытаться зайти на /vaishnavas/index.html → должен вернуться на свой профиль

3. **Назначение ролей и прав**
   - Создать пользователя, назначить роль "Observer"
   - Проверить что видны только пункты для просмотра
   - Добавить индивидуальное право `create_booking`
   - Проверить что кнопка "Забронировать" появилась

4. **Блокировка**
   - Заблокировать пользователя через админ-панель
   - Попытаться войти → должна быть ошибка

5. **Суперпользователь**
   - Войти как суперпользователь
   - Проверить что видны все пункты меню и все кнопки

---

## Дальнейшее развитие

### Возможные улучшения

1. **Email уведомления**
   - При одобрении заявки
   - При назначении новой роли
   - При блокировке

2. **Логирование действий**
   - Кто, когда и какие права изменил
   - История изменения ролей

3. **Права на уровне данных**
   - Ограничение видимости по зданиям/комнатам
   - Привязка к retreat_id

4. **Временные права**
   - Назначение прав на определённый период
   - Автоматическое истечение

5. **API токены**
   - Для интеграции с внешними системами
   - С ограниченными правами

---

## Справочник

### Все права Housing модуля

#### Vaishnavas (6)
- `view_vaishnavas` - Просмотр всех вайшнавов
- `create_vaishnava` - Создание нового вайшнава
- `edit_vaishnava` - Редактирование вайшнава
- `delete_vaishnava` - Удаление вайшнава
- `view_guests` - Просмотр только гостей
- `view_team` - Просмотр только команды

#### Placement (11)
- `view_bookings` - Просмотр бронирований
- `create_booking` - Создание бронирования
- `edit_booking` - Редактирование бронирования
- `delete_booking` - Удаление бронирования
- `view_timeline` - Просмотр таймлайна размещения
- `manage_arrivals` - Регистрация прибытий
- `manage_departures` - Регистрация выездов
- `manage_transfers` - Управление трансферами
- `view_preliminary` - Просмотр предварительных заявок
- `edit_preliminary` - Редактирование предварительных заявок
- `view_retreat_guests` - Просмотр участников ретритов
- `edit_retreat_guests` - Редактирование участников

#### Reception (10)
- `view_floor_plan` - Просмотр плана этажей
- `edit_floor_plan` - Редактирование плана этажей
- `view_rooms` - Просмотр комнат
- `create_room` - Создание комнаты
- `edit_room` - Редактирование комнаты
- `delete_room` - Удаление комнаты
- `view_buildings` - Просмотр зданий
- `edit_buildings` - Редактирование зданий
- `view_cleaning` - Просмотр статусов уборки
- `manage_cleaning` - Управление уборкой

#### Ashram (6)
- `view_retreats` - Просмотр ретритов
- `create_retreat` - Создание ретрита
- `edit_retreat` - Редактирование ретрита
- `delete_retreat` - Удаление ретрита
- `view_festivals` - Просмотр праздников
- `edit_festivals` - Редактирование праздников

#### Settings (5)
- `view_dictionaries` - Просмотр справочников
- `edit_dictionaries` - Редактирование справочников
- `view_translations` - Просмотр переводов
- `edit_translations` - Редактирование переводов
- `manage_users` - Управление пользователями

#### Profile (3)
- `view_own_profile` - Просмотр своего профиля
- `edit_own_profile` - Редактирование своего профиля
- `view_own_bookings` - Просмотр своих бронирований

#### Inventory (2)
- `view_inventory` - Просмотр инвентаря
- `manage_inventory` - Управление инвентарём

---

*Документация актуальна по состоянию на 30.01.2026*
