# Настройка прав доступа к фотогалерее

## Общая информация

Модуль фотогалереи использует стандартную систему ролей и прав ШРСК.

**Permission:** `upload_photos`
**Модуль:** `admin`
**Назначение:** Загрузка и управление фотографиями ретритов

---

## Порядок настройки прав (пошагово)

### Шаг 1: Убедиться, что permission `upload_photos` существует

```sql
-- Проверить наличие permission
SELECT
    p.id,
    p.code,
    p.name_ru,
    m.code as module_code
FROM permissions p
JOIN modules m ON m.id = p.module_id
WHERE p.code = 'upload_photos';
```

**Ожидаемый результат:** одна строка с `upload_photos`

Если permission НЕТ → создать вручную или через миграцию (см. раздел "Создание permission" ниже).

---

### Шаг 2: Выбрать способ назначения прав

Есть **3 способа** назначить право пользователю:

| Способ | Когда использовать | Плюсы | Минусы |
|--------|-------------------|-------|--------|
| **А. Через роль** | Несколько пользователей с одинаковыми правами | Легко управлять группой, стандартный подход | Нужно создать роль |
| **Б. Индивидуальное право** | Один пользователь или временный доступ | Быстро, не нужна роль | Сложнее отслеживать |
| **В. Суперпользователь** | Полный доступ ко всей системе | Все права автоматически | Слишком широкий доступ |

**Рекомендация:** Используй **способ А** (через роль) для production.

---

## Способ А: Назначение через роль (рекомендуется)

### 1. Создать роль "Фотограф"

```sql
DO $$
DECLARE
  v_module_id UUID;
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  -- Найти модуль admin
  SELECT id INTO v_module_id FROM modules WHERE code = 'admin';

  IF v_module_id IS NULL THEN
    RAISE EXCEPTION 'Module admin not found';
  END IF;

  -- Создать роль
  INSERT INTO roles (module_id, code, name_ru, name_en, description_ru, color, is_system)
  VALUES (
    v_module_id,
    'photographer',
    'Фотограф',
    'Photographer',
    'Загрузка и управление фотографиями ретритов',
    '#f59e0b',
    false
  )
  ON CONFLICT (module_id, code) DO UPDATE
  SET name_ru = EXCLUDED.name_ru,
      description_ru = EXCLUDED.description_ru
  RETURNING id INTO v_role_id;

  -- Получить ID роли, если уже существовала
  IF v_role_id IS NULL THEN
    SELECT id INTO v_role_id FROM roles
    WHERE module_id = v_module_id AND code = 'photographer';
  END IF;

  -- Найти permission upload_photos
  SELECT id INTO v_perm_id FROM permissions WHERE code = 'upload_photos';

  IF v_perm_id IS NULL THEN
    RAISE EXCEPTION 'Permission upload_photos not found';
  END IF;

  -- Связать роль с правом
  INSERT INTO role_permissions (role_id, permission_id)
  VALUES (v_role_id, v_perm_id)
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  RAISE NOTICE 'Role "photographer" created and linked to upload_photos permission';
END $$;
```

### 2. Назначить роль пользователю

**По email:**

```sql
DO $$
DECLARE
  v_role_id UUID;
  v_user_id UUID;
  v_email TEXT := 'user@example.com';  -- ЗАМЕНИ НА НУЖНЫЙ EMAIL
BEGIN
  -- Найти пользователя
  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', v_email;
  END IF;

  -- Найти роль
  SELECT r.id INTO v_role_id
  FROM roles r
  JOIN modules m ON m.id = r.module_id
  WHERE r.code = 'photographer' AND m.code = 'admin';

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Role photographer not found';
  END IF;

  -- Назначить роль
  INSERT INTO user_roles (user_id, role_id, is_active)
  VALUES (v_user_id, v_role_id, true)
  ON CONFLICT (user_id, role_id) DO UPDATE
  SET is_active = true;

  RAISE NOTICE 'Role photographer assigned to %', v_email;
END $$;
```

**Текущему пользователю (при выполнении из приложения):**

```sql
DO $$
DECLARE
  v_role_id UUID;
BEGIN
  SELECT r.id INTO v_role_id
  FROM roles r
  JOIN modules m ON m.id = r.module_id
  WHERE r.code = 'photographer' AND m.code = 'admin';

  INSERT INTO user_roles (user_id, role_id, is_active)
  VALUES (auth.uid(), v_role_id, true)
  ON CONFLICT (user_id, role_id) DO UPDATE SET is_active = true;
END $$;
```

---

## Способ Б: Индивидуальное право

Назначить право напрямую, **без роли**.

**По email:**

```sql
DO $$
DECLARE
  v_perm_id UUID;
  v_user_id UUID;
  v_email TEXT := 'user@example.com';  -- ЗАМЕНИ НА НУЖНЫЙ EMAIL
BEGIN
  -- Найти пользователя
  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', v_email;
  END IF;

  -- Найти permission
  SELECT id INTO v_perm_id FROM permissions WHERE code = 'upload_photos';

  IF v_perm_id IS NULL THEN
    RAISE EXCEPTION 'Permission upload_photos not found';
  END IF;

  -- Назначить право напрямую
  INSERT INTO user_permissions (user_id, permission_id, is_granted, reason)
  VALUES (v_user_id, v_perm_id, true, 'Temporary photographer access')
  ON CONFLICT (user_id, permission_id)
  DO UPDATE SET
    is_granted = true,
    reason = EXCLUDED.reason;

  RAISE NOTICE 'Permission upload_photos granted to %', v_email;
END $$;
```

---

## Способ В: Суперпользователь (НЕ рекомендуется)

⚠️ **Внимание:** Суперпользователь получает **ВСЕ** права в системе, включая удаление данных, управление пользователями и т.д.

**Используй только для тестирования или главного администратора.**

```sql
-- Сделать пользователя суперпользователем
UPDATE vaishnavas
SET is_superuser = true
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'admin@example.com');
```

---

## Проверка назначенных прав

### 1. Проверить роли пользователя

```sql
SELECT
    u.email,
    r.code as role_code,
    r.name_ru as role_name,
    m.code as module_code,
    ur.is_active
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
JOIN modules m ON m.id = r.module_id
JOIN auth.users u ON u.id = ur.user_id
WHERE u.email = 'user@example.com';  -- ЗАМЕНИ НА НУЖНЫЙ EMAIL
```

### 2. Проверить индивидуальные права

```sql
SELECT
    u.email,
    p.code as permission_code,
    p.name_ru as permission_name,
    up.is_granted,
    up.reason
FROM user_permissions up
JOIN permissions p ON p.id = up.permission_id
JOIN auth.users u ON u.id = up.user_id
WHERE u.email = 'user@example.com';  -- ЗАМЕНИ НА НУЖНЫЙ EMAIL
```

### 3. Проверить итоговые права (через функцию)

```sql
-- Проверить все права пользователя (роли + индивидуальные)
SELECT permission_code
FROM get_user_permissions(
    (SELECT id FROM auth.users WHERE email = 'user@example.com')
)
ORDER BY permission_code;
```

**Должен быть в списке:** `upload_photos`

---

## Отзыв прав

### Отозвать роль

```sql
-- Деактивировать роль (мягкое удаление)
UPDATE user_roles
SET is_active = false
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'user@example.com')
  AND role_id = (SELECT id FROM roles WHERE code = 'photographer');

-- ИЛИ удалить полностью
DELETE FROM user_roles
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'user@example.com')
  AND role_id = (SELECT id FROM roles WHERE code = 'photographer');
```

### Отозвать индивидуальное право

```sql
-- Отметить как отозванное (явный запрет)
UPDATE user_permissions
SET is_granted = false
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'user@example.com')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'upload_photos');

-- ИЛИ удалить полностью
DELETE FROM user_permissions
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'user@example.com')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'upload_photos');
```

---

## Создание permission (если его нет)

Если permission `upload_photos` не существует, создай его:

```sql
DO $$
DECLARE
  v_module_id UUID;
BEGIN
  -- Найти модуль admin
  SELECT id INTO v_module_id FROM modules WHERE code = 'admin';

  IF v_module_id IS NULL THEN
    RAISE EXCEPTION 'Module admin not found';
  END IF;

  -- Создать permission
  INSERT INTO permissions (module_id, code, name_ru, name_en, category)
  VALUES (
    v_module_id,
    'upload_photos',
    'Загрузка фото',
    'Upload Photos',
    'photos'
  )
  ON CONFLICT (module_id, code) DO NOTHING;

  RAISE NOTICE 'Permission upload_photos created';
END $$;
```

---

## Проверка доступа в браузере

После назначения прав:

1. **Перезагрузи страницу** (Ctrl+Shift+R или Cmd+Shift+R)
2. Открой консоль браузера (F12)
3. Выполни:

```javascript
console.log('Has upload_photos:', window.hasPermission('upload_photos'));
console.log('All permissions:', window.currentUser?.permissions);
```

**Ожидаемый результат:**
```
Has upload_photos: true
All permissions: ["upload_photos", "view_retreats", ...]
```

4. Открой `/photos/upload.html` — должна открыться **БЕЗ** ошибки

---

## Типичные проблемы

### ❌ "У вас нет прав для загрузки фотографий"

**Причины:**
1. Permission не назначен → проверь через `get_user_permissions()`
2. Кеш браузера → жёсткая перезагрузка (Ctrl+Shift+R)
3. Скрипт проверяет права до загрузки пользователя → исправлено в `upload.js` (функция `waitForAuth`)

### ❌ Пункт меню "Фото" не появляется

**Причины:**
1. Нет перевода `nav_photos` → выполни миграцию `110_photos_translations.sql`
2. Нет прав `upload_photos` → назначь через один из способов выше
3. Кеш переводов → перезагрузи страницу

### ❌ Permission не возвращается функцией `get_user_permissions`

**Причины:**
1. Роль не связана с permission → проверь `role_permissions`
2. Роль деактивирована → проверь `user_roles.is_active = true`
3. Функция `get_user_permissions` не обновлена → пересоздай функцию из миграции `099_get_user_permissions_function.sql`

---

## Рекомендуемый workflow

### Для production (несколько фотографов):

1. Создай роль `photographer` (один раз)
2. Свяжи роль с `upload_photos` (один раз)
3. Для каждого нового фотографа: назначь роль через `user_roles`

### Для разработки/тестирования:

1. Используй индивидуальное право (способ Б)
2. Или временно сделай себя суперпользователем (способ В)

---

## См. также

- [docs/auth.md](auth.md) — Общая система авторизации
- [docs/database.md](database.md) — Структура таблиц прав
- [supabase/099_get_user_permissions_function.sql](../supabase/099_get_user_permissions_function.sql) — Функция загрузки прав
- [supabase/110_photos_translations.sql](../supabase/110_photos_translations.sql) — Переводы для фотогалереи
