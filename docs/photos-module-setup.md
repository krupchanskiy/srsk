# Модуль Photos — настройка и доступ

## Обзор

Модуль **Photos** выделен в отдельный раздел системы (наравне с Kitchen, Housing, CRM) и доступен пользователям с permission `upload_photos` **без прав суперпользователя**.

---

## Архитектура

### 1. Модуль в `js/layout.js`

```javascript
photos: {
    id: 'photos',
    nameKey: 'module_photos',
    icon: '📸',
    hasLocations: false,
    defaultPage: 'photos/upload.html',
    menuConfig: [
        { id: 'photos', items: [
            { id: 'upload_photos', href: 'photos/upload.html' },
            { id: 'manage_photos', href: 'photos/manage.html' }
        ]}
    ]
}
```

### 2. Цвет модуля

- **Цвет:** `#ec4899` (розовый)
- **Файл:** `photos/js/color-init.js` (загружается ПЕРВЫМ в `<head>`)

### 3. Кнопка в хедере

Кнопка "Фото" отображается в выпадающем меню хедера только для пользователей с permission `upload_photos`:

```javascript
if (window.hasPermission && window.hasPermission('upload_photos')) {
    // показать кнопку Photos
}
```

---

## Миграции

### 1. Таблица `retreat_photos`

**Файл:** `supabase/108_face_recognition_tables.sql`

Основные поля:
- `id`, `retreat_id`, `storage_path`
- `uploaded_by` → ссылка на `auth.users(id)`
- `day_number`, `caption` (опциональные)
- `index_status`: `pending | processing | indexed | failed`

**RLS-политики:**
- **SELECT:** только участники ретрита (через `retreat_registrations`)
- **INSERT/DELETE:** пользователи с `upload_photos` (через роли ИЛИ индивидуальные права)

### 2. Storage bucket `retreat-photos`

**Файл:** `supabase/109_retreat_photos_storage_policies.sql`

**RLS-политики:**
- **SELECT:** участники ретрита (зарегистрированные + команда)
- **INSERT/DELETE:** пользователи с `upload_photos` (через роли ИЛИ индивидуальные права)
- **UPDATE:** запрещено (immutable storage)

### 3. Переводы

**Файл:** `supabase/110_photos_translations.sql`

Ключи:
- `module_photos` — название модуля
- `nav_photos`, `upload_photos`, `manage_photos` — пункты меню
- Переводы страницы загрузки (upload_photos_title, select_retreat, и т.д.)

### 4. Добавление недостающих полей

**Файл:** `supabase/111_retreat_photos_add_fields_and_fix_policies.sql`

Добавляет поля `uploaded_by`, `day_number`, `caption` и обновляет RLS-политики для проверки прав через **роли И индивидуальные permissions**.

---

## Права доступа

### Permission: `upload_photos`

**Модуль:** `admin`
**Назначение:** Загрузка и управление фотографиями ретритов

### Назначение прав

**Способ 1 (рекомендуется):** Через роль `photographer`

```sql
-- Создать роль (если нет)
-- см. docs/photo-permissions-setup.md

-- Назначить роль пользователю
INSERT INTO user_roles (user_id, role_id, is_active)
VALUES (
    (SELECT id FROM auth.users WHERE email = 'user@example.com'),
    (SELECT id FROM roles WHERE code = 'photographer'),
    true
)
ON CONFLICT (user_id, role_id) DO UPDATE SET is_active = true;
```

**Способ 2:** Индивидуальное право

```sql
INSERT INTO user_permissions (user_id, permission_id, is_granted)
VALUES (
    (SELECT id FROM auth.users WHERE email = 'user@example.com'),
    (SELECT id FROM permissions WHERE code = 'upload_photos'),
    true
);
```

### Проверка прав

**В браузере (консоль):**
```javascript
console.log('Has upload_photos:', window.hasPermission('upload_photos'));
```

**В БД:**
```sql
SELECT permission_code
FROM get_user_permissions(
    (SELECT id FROM auth.users WHERE email = 'user@example.com')
);
```

---

## Файлы модуля

### HTML
- `photos/upload.html` — страница загрузки фото
- `photos/manage.html` — управление фото (TODO)

### JavaScript
- `photos/js/color-init.js` — цвет модуля (#ec4899)
- `photos/js/upload.js` — логика загрузки фото

### CSS
- `photos/css/upload.css` — стили страницы загрузки

---

## Логика загрузки фото

1. **Проверка auth:** `waitForAuth()` ждёт загрузки `window.currentUser` (до 5 сек)
2. **Проверка прав:** `window.hasPermission('upload_photos')`
3. **Выбор ретрита:** загрузка из таблицы `retreats` (с правами `anon`)
4. **Выбор файлов:** drag-and-drop или file input (до 50 МБ на файл)
5. **Загрузка:**
   - Storage: `db.storage.from('retreat-photos').upload(fileName, file)`
   - БД: `db.from('retreat_photos').insert({ retreat_id, storage_path, mime_type, file_size, uploaded_by, day_number })`
6. **Retry:** 3 попытки с exponential backoff
7. **Индексация лиц (автоматически):**
   - Вызов Edge Function `index-faces` (батчами по 20 фото)
   - **Фотограф может закрыть страницу** — индексация продолжится в фоне
   - Прогресс-бар обновляется каждые 3 секунды через polling БД
   - Показывает: проиндексировано фото, процент, найдено лиц

---

## Структура данных

### Путь к файлу в Storage

```
{retreat_id}/{uuid}.{extension}
```

Пример: `4b8f2d38-31e9-44ed-97ca-0592109eedf1/176391c8-d5f3-4174-aced-94d52b1426af.jpg`

### Запись в БД

```javascript
{
    retreat_id: '4b8f2d38-31e9-44ed-97ca-0592109eedf1',
    storage_path: '4b8f2d38-.../176391c8-....jpg',
    mime_type: 'image/jpeg',
    file_size: 1234567,
    uploaded_by: 'user-uuid',
    day_number: 3,
    index_status: 'pending'
}
```

---

## Типичные проблемы

### ❌ Кнопка "Фото" не появляется в хедере

**Причины:**
1. Нет permission `upload_photos` → назначь через роль или напрямую
2. Кеш браузера → жёсткая перезагрузка (Ctrl+Shift+R)
3. Не выполнена миграция переводов `110_photos_translations.sql`

### ❌ Ошибка 400 при загрузке фото в Storage

**Причины:**
1. RLS-политики Storage не применены → выполни `109_retreat_photos_storage_policies.sql`
2. Permission проверяется только через `user_permissions`, но права назначены через роль → выполни `111_retreat_photos_add_fields_and_fix_policies.sql`

### ❌ Ошибка 400 при записи в таблицу `retreat_photos`

**Причины:**
1. RLS-политики таблицы не обновлены → выполни `111_retreat_photos_add_fields_and_fix_policies.sql`
2. Отсутствуют поля `uploaded_by`, `day_number` → выполни миграцию 111

---

## Edge Functions (Фаза 2)

### CORS Configuration

**Важно:** Все Edge Functions должны иметь обработку CORS preflight (OPTIONS запросов).

**Пример:**
```typescript
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  // ... остальная логика
});
```

И CORS заголовки в ответах:
```typescript
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}
```

### ❌ Ошибка: OPTIONS 405 Method Not Allowed

**Симптом:** При вызове Edge Function из браузера ошибка `405 Method Not Allowed` на OPTIONS запрос.

**Причина:** Отсутствует обработка CORS preflight в функции.

**Решение:** Добавить обработку OPTIONS в начале `serve()` (см. пример выше).

### Деплой функций

```bash
# Индексация лиц
supabase functions deploy index-faces --project-ref <project-id> --no-verify-jwt

# Поиск лиц
supabase functions deploy search-face --project-ref <project-id> --no-verify-jwt

# Удаление с каскадом
supabase functions deploy delete-photos --project-ref <project-id> --no-verify-jwt
```

### Проверка логов

```bash
supabase functions logs index-faces --project-ref <project-id>
supabase functions logs search-face --project-ref <project-id>
supabase functions logs delete-photos --project-ref <project-id>
```

---

## См. также

- [docs/photo-permissions-setup.md](photo-permissions-setup.md) — Пошаговая настройка прав
- [docs/photos-module-deployment.md](photos-module-deployment.md) — Полная инструкция по развёртыванию (Фаза 2)
- [docs/photos-module-usage.md](photos-module-usage.md) — Инструкция для пользователей
- [docs/architecture.md](architecture.md) — Архитектура системы
- [supabase/108_face_recognition_tables.sql](../supabase/108_face_recognition_tables.sql) — Таблицы фотогалереи
- [supabase/109_retreat_photos_storage_policies.sql](../supabase/109_retreat_photos_storage_policies.sql) — Политики Storage
- [supabase/110_photos_translations.sql](../supabase/110_photos_translations.sql) — Переводы модуля
- [supabase/111_retreat_photos_add_fields_and_fix_policies.sql](../supabase/111_retreat_photos_add_fields_and_fix_policies.sql) — Обновление политик
