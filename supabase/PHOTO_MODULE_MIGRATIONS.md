# Миграции модуля фотографий

## Порядок применения для PROD (чистая база)

Если применяются миграции на **чистую** базу данных (нет retreat_photos):

### 1. Миграция 108: Основные таблицы и триггеры
```sql
-- Файл: 108_face_recognition_tables.sql
-- Создаёт:
-- - retreat_photos (с uploaded_at и updated_at)
-- - photo_faces
-- - face_tags
-- - face_search_log
-- - Функцию set_updated_at() и триггеры для retreat_photos и face_tags
-- - RLS политики
```

### 2. Миграция 109: Storage политики
```sql
-- Файл: 109_retreat_photos_storage_policies.sql
-- Настраивает Storage bucket 'retreat-photos'
-- Примечание: политики Storage настраиваются через Supabase Dashboard, а не SQL
```

### 3. Миграция 110: Переводы
```sql
-- Файл: 110_photos_translations.sql
-- Добавляет переводы для модуля фотографий (ru, en, hi)
```

### 4. Миграция 111: Патч для старых баз (ОПЦИОНАЛЬНО)
```sql
-- Файл: 111_retreat_photos_add_fields_and_fix_policies.sql
-- Нужна ТОЛЬКО если retreat_photos создана БЕЗ миграции 108
-- Добавляет недостающие поля:
-- - uploaded_by (IF NOT EXISTS)
-- - updated_at (IF NOT EXISTS)
-- - day_number (IF NOT EXISTS)
-- - caption (IF NOT EXISTS)
-- - Триггер для updated_at (IF NOT EXISTS)
--
-- Если миграция 108 применена, 111 безопасно пропустит всё (IF NOT EXISTS)
```

### 5. Миграция 113: Добавление updated_at (НЕ НУЖНА для PROD)
```sql
-- Файл: 113_add_updated_at_to_retreat_photos.sql
-- Эта миграция НЕ НУЖНА, если применяется 108 или 111
-- Создана только для DEV окружения, где была старая версия retreat_photos
```

## Итог для PROD (чистая база)

**Нужны только 3 миграции:**
1. ✅ 108 — создаёт таблицы со всеми полями и RLS
2. ✅ 109 — настраивает Storage bucket политики
3. ✅ 110 — добавляет переводы

**Миграции 111 и 113 НЕ НУЖНЫ** (они для патчинга старых баз)

## Проверка после миграций

```sql
-- Проверить структуру таблицы retreat_photos
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'retreat_photos' AND table_schema = 'public'
ORDER BY ordinal_position;

-- Должно быть:
-- id, retreat_id, storage_path, uploaded_by, uploaded_at, updated_at,
-- width, height, file_size, day_number, caption, index_status, index_error

-- Проверить триггеры
SELECT tgname, tgrelid::regclass
FROM pg_trigger
WHERE tgrelid = 'retreat_photos'::regclass;

-- Должен быть: retreat_photos_set_updated_at

-- Проверить RLS политики
SELECT policyname, cmd FROM pg_policies
WHERE tablename = 'retreat_photos';

-- Должны быть:
-- retreat_photos_select (SELECT)
-- retreat_photos_insert (INSERT)
-- retreat_photos_delete (DELETE)
```

## Storage Bucket конфигурация

### Bucket: retreat-photos
- **Public**: Yes
- **File size limit**: 10 MB
- **Allowed MIME types**: image/jpeg, image/jpg, image/png, image/webp

### RLS Policies (настраиваются в Dashboard → Storage → retreat-photos → Policies):

1. **SELECT (Public read for retreat participants)**
   ```sql
   EXISTS (
     SELECT 1 FROM retreat_registrations rr
     JOIN vaishnavas v ON v.id = rr.vaishnava_id
     WHERE rr.retreat_id::text = (storage.foldername(name))[1]
       AND v.user_id = auth.uid()
       AND rr.status IN ('guest', 'team')
   )
   ```

2. **INSERT (Only users with upload_photos permission)**
   ```sql
   EXISTS (
     SELECT 1 FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = auth.uid()
       AND ur.is_active = true
       AND p.code = 'upload_photos'
   )
   OR
   EXISTS (
     SELECT 1 FROM user_permissions up
     JOIN permissions p ON p.id = up.permission_id
     WHERE up.user_id = auth.uid()
       AND up.is_granted = true
       AND p.code = 'upload_photos'
   )
   ```

3. **DELETE (Only users with upload_photos permission)**
   - Аналогично INSERT

## Тестирование

### 1. Проверка загрузки фото (admin)
- Открыть `/photos/upload.html`
- Выбрать ретрит
- Загрузить фото
- Проверить запись в `retreat_photos` со статусом `pending`

### 2. Проверка галереи (guest)
- Создать регистрацию в `retreat_registrations` для тестового пользователя
- Открыть `/guest-portal/photos.html`
- Проверить отображение фото
- Проверить фильтры (по ретриту, по дню)

### 3. Проверка управления (admin)
- Открыть `/photos/manage.html`
- Выбрать ретрит
- Проверить список фото со статусами
- Проверить массовое удаление
