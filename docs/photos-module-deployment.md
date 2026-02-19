# Развёртывание модуля фотографий

Этот документ описывает процесс развёртывания модуля фотографий с AI-распознаванием лиц.

## Предварительные требования

### 1. AWS Rekognition

**Аккаунт AWS:**
- Account: srsk (8188-1114-2778)
- Region: `ap-south-1` (Mumbai)
- IAM user: `srsk-rekognition`
- Policy: `SrskRekognitionOnly`

**Необходимые права:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "rekognition:CreateCollection",
        "rekognition:DeleteCollection",
        "rekognition:ListCollections",
        "rekognition:IndexFaces",
        "rekognition:SearchFaces",
        "rekognition:SearchFacesByImage",
        "rekognition:DeleteFaces",
        "rekognition:DetectFaces"
      ],
      "Resource": "*"
    }
  ]
}
```

### 2. Supabase Configuration

**Storage Bucket:**
- Имя: `retreat-photos`
- Public: да (для публичных URL с Image Transform)

**Edge Functions Secrets:**
```bash
supabase secrets set AWS_ACCESS_KEY_ID=<ключ>
supabase secrets set AWS_SECRET_ACCESS_KEY=<секретный ключ>
supabase secrets set AWS_REGION=ap-south-1
```

---

## Шаг 1: Применение миграций БД

### Миграции (в порядке выполнения):

Миграции применяются через MCP или Supabase Dashboard → SQL Editor:

```sql
-- 1. Создание таблиц для фото и распознавания лиц
\i supabase/108_face_recognition_tables.sql

-- 2. Политики Storage для retreat-photos bucket
\i supabase/109_retreat_photos_storage_policies.sql

-- 3. Переводы для интерфейса
\i supabase/110_photos_translations.sql

-- 4. Патч для полей updated_at, uploaded_by
\i supabase/111_retreat_photos_add_fields_and_fix_policies.sql

-- 5. Исправление триггера updated_at
\i supabase/112_fix_retreat_photos_trigger.sql

-- 6. Добавление поля updated_at
\i supabase/113_add_updated_at_to_retreat_photos.sql

-- 7. Добавление поля faces_count
\i supabase/114_add_faces_count_to_retreat_photos.sql

-- 8. Переводы для прогресса индексации
\i supabase/115_photos_indexing_translations.sql

-- 9. UPDATE policy для retreat_photos
\i supabase/116_retreat_photos_update_policy.sql

-- 10. Включить Realtime для retreat_photos
\i supabase/117_enable_realtime_retreat_photos.sql

-- 11. Поле thumb_path (путь к превью) в retreat_photos
\i supabase/118_add_thumb_path_to_retreat_photos.sql

-- 12. Поле telegram_chat_id в vaishnavas (для Telegram-уведомлений)
\i supabase/119_add_telegram_chat_id_to_vaishnavas.sql

-- 13. Таблица telegram_link_tokens (одноразовые токены привязки бота)
\i supabase/120_telegram_link_tokens.sql

-- 14. Каскадное удаление photo_faces и face_tags при удалении фото
\i supabase/121_fix_photo_cascade_delete.sql

-- 15. Исправление RLS для retreat_photos (права суперпользователя)
\i supabase/122_fix_retreat_photos_rls_for_superusers.sql

-- 16. Разрешить пользователям обновлять свой telegram_chat_id
\i supabase/123_allow_users_update_telegram_chat_id.sql

-- 17. Дополнительные переводы для управления фото
\i supabase/124_add_missing_photo_translations.sql

-- 18. Исправление удаления фото ретритов (каскад через Edge Function)
\i supabase/127_fix_retreat_photos_deletion.sql

-- 19. Поле rejected в face_tags (мягкое удаление отметки гостем)
\i supabase/128_face_tags_rejected.sql
```

Через MCP (рекомендуется):
```javascript
// Пример для миграции 128
mcp__supabase__apply_migration({
  project_id: 'llttmftapmwebidgevmg',  // прод
  // или: 'vzuiwpeovnzfokekdetq'       // дев
  name: '128_face_tags_rejected',
  query: '<содержимое supabase/128_face_tags_rejected.sql>'
})
```

### Проверка применения миграций:

```sql
-- Проверить структуру таблиц
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'retreat_photos'
ORDER BY ordinal_position;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('photo_faces', 'face_tags', 'face_search_log');

-- Проверить RLS политики
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename IN ('retreat_photos', 'photo_faces', 'face_tags');
```

---

## Шаг 2: Создание Storage Bucket

```bash
# Если bucket ещё не создан
supabase storage create retreat-photos --project-ref llttmftapmwebidgevmg --public
```

**Настройки bucket:**
- Max file size: 50 MB
- Allowed MIME types: `image/jpeg`, `image/png`, `image/jpg`
- Public access: да (для публичных URL)

---

## Шаг 3: Деплой Edge Functions

### Деплой функций:

```bash
# 1. Индексация лиц (вызывается после загрузки фото)
supabase functions deploy index-faces --project-ref llttmftapmwebidgevmg --no-verify-jwt

# 2. Поиск лиц (вызывается гостем при "Найти себя")
supabase functions deploy search-face --project-ref llttmftapmwebidgevmg --no-verify-jwt

# 3. Каскадное удаление (вызывается при удалении фото)
supabase functions deploy delete-photos --project-ref llttmftapmwebidgevmg --no-verify-jwt
```

### Проверка деплоя:

```bash
# Список функций
supabase functions list --project-ref llttmftapmwebidgevmg

# Логи функций
supabase functions logs index-faces --project-ref llttmftapmwebidgevmg
```

---

## Шаг 4: Настройка прав доступа

### Добавление разрешения `upload_photos`:

```sql
-- 1. Создать разрешение (если нет)
INSERT INTO public.permissions (code, name_ru, name_en, name_hi, category)
VALUES
  ('upload_photos', 'Загрузка фотографий', 'Upload photos', 'फ़ोटो अपलोड करें', 'photos')
ON CONFLICT (code) DO NOTHING;

-- 2. Назначить роли (например, "Фотограф")
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT
  r.id,
  p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name = 'Фотограф' AND p.code = 'upload_photos'
ON CONFLICT DO NOTHING;
```

### Назначение роли пользователю:

```sql
-- Найти user_id
SELECT id, email FROM auth.users WHERE email = 'photographer@example.com';

-- Назначить роль
INSERT INTO public.user_roles (user_id, role_id, is_active)
SELECT
  '<user_id>',
  id,
  true
FROM public.roles
WHERE name = 'Фотограф'
ON CONFLICT DO NOTHING;
```

---

## Шаг 5: Тестирование функционала

### 1. Загрузка фото (как фотограф):

1. Авторизоваться с правом `upload_photos`
2. Открыть `/photos/upload.html`
3. Выбрать ретрит
4. Загрузить несколько фото
5. Проверить:
   - Фото появились в Storage (`retreat-photos/`)
   - Записи созданы в `retreat_photos` со статусом `pending`
   - Edge Function `index-faces` вызвалась автоматически
   - Статус изменился на `indexed`
   - В `photo_faces` появились записи с `rekognition_face_id`

### 2. Управление фото (как фотограф):

1. Открыть `/photos/manage.html`
2. Выбрать ретрит
3. Проверить:
   - Отображаются все фото
   - Статистика (всего/indexed/pending/failed)
   - Работает lightbox (просмотр, скачивание)
   - Работает множественное выбор и удаление
   - Кнопка "Переиндексировать" сбрасывает статус и запускает повторную индексацию

### 3. Поиск себя (как гость):

1. Авторизоваться как гость ретрита
2. Открыть `/guest-portal/photos.html`
3. Нажать "Найти себя"
4. Загрузить селфи (своё фото)
5. Проверить:
   - Статус "Поиск лиц..."
   - Результат "Найдено X фото с вами!"
   - Фото отмечены бейджем "Вы"
   - Чекбокс "Фото со мной" активен
   - При включении чекбокса показываются только фото с гостем
   - В `face_tags` созданы записи с `vaishnava_id`

### 4. Скачивание ZIP:

1. В портале гостя выбрать несколько фото (чекбоксы)
2. Нажать "Скачать ZIP"
3. Проверить, что архив скачался с корректными файлами

---

## Архитектура решения

### 1. Rekognition Collections

**Модель данных:**
- 1 Collection = 1 Ретрит
- Collection ID: `retreat_{retreat_id}` (подчёркивание, не дефис)
- ExternalImageId: `photo_id` (UUID из таблицы `retreat_photos`)

**Жизненный цикл:**
1. Collection создаётся автоматически при первой индексации фото ретрита
2. Collection хранится до удаления ретрита (или очистки через N месяцев)
3. Удаление Collection происходит вручную или по расписанию

### 2. Таблицы БД

#### `retreat_photos`
- `id` (UUID) — первичный ключ
- `retreat_id` (UUID) — связь с ретритом
- `storage_path` (TEXT) — путь в Storage
- `index_status` (TEXT) — `pending | indexing | indexed | failed`
- `faces_count` (INT) — количество найденных лиц
- `index_error` (TEXT) — текст ошибки при `failed`

#### `photo_faces`
- `id` (UUID) — первичный ключ
- `photo_id` (UUID) — связь с фото
- `rekognition_face_id` (TEXT) — FaceId из Rekognition
- `bbox_*` (FLOAT) — координаты лица
- `confidence` (FLOAT) — уверенность (0-100)

#### `face_tags`
- `id` (UUID) — первичный ключ
- `photo_id` (UUID) — связь с фото
- `vaishnava_id` (UUID) — связь с вайшнавом
- `confidence` (FLOAT) — уверенность совпадения (Similarity из SearchFaces)
- `rejected` (BOOLEAN, default false) — гость снял отметку «Вы»; запись не удаляется, а помечается rejected=true, чтобы повторный поиск не добавлял её снова (upsert с ignoreDuplicates)

### 3. Edge Functions

#### `index-faces`
**Вход:**
```json
{
  "retreat_id": "uuid",
  "batch_size": 50
}
```

**Выход:**
```json
{
  "message": "Индексация завершена",
  "processed": 50,
  "indexed": 48,
  "failed": 2
}
```

**Логика:**
1. Проверить/создать Collection
2. Загрузить фото со статусом `pending` (лимит batch_size)
3. Для каждого фото:
   - Скачать изображение
   - Вызвать `IndexFaces`
   - Сохранить `FaceRecords` в `photo_faces`
   - Обновить статус на `indexed`

#### `search-face`
**Вход:**
```json
{
  "retreat_id": "uuid",
  "vaishnava_id": "uuid",
  "photo_url": "https://...",
  "threshold": 80,
  "max_faces": 100
}
```

> `photo_url` — опциональное селфи. Если не передано, берётся `vaishnavas.photo_url`.

**Выход:**
```json
{
  "ok": true,
  "retreat_id": "uuid",
  "vaishnava_id": "uuid",
  "used_photo_url": "https://...",
  "matched_photo_ids": ["uuid1", "uuid2"],
  "total": 2,
  "threshold": 80
}
```

**Логика:**
1. Если `photo_url` не передан — загрузить из `vaishnavas.photo_url`
2. Скачать изображение, проверить размер (≤ 10 МБ)
3. Вызвать `SearchFacesByImage` в Collection `retreat_{retreat_id}`
4. Сопоставить FaceId → photo_id через `photo_faces`
5. Upsert в `face_tags` с `ignoreDuplicates: true` (не перезаписывает `rejected=true`)
6. Отправить Telegram-уведомление с реальным кол-вом найденных фото (запрос в БД с `rejected=false`)
7. Вернуть список `matched_photo_ids`

#### `delete-photos`
**Вход:**
```json
{
  "photo_ids": ["uuid1", "uuid2"],
  "retreat_id": "uuid"
}
```

**Выход:**
```json
{
  "message": "Фотографии успешно удалены",
  "deleted": 2,
  "faces_deleted": 5
}
```

**Логика:**
1. Загрузить `rekognition_face_id` из `photo_faces`
2. Вызвать `DeleteFaces` для удаления из Collection
3. Удалить файлы из Storage
4. Удалить записи из `photo_faces` (каскадом)
5. Удалить записи из `retreat_photos`

---

## Мониторинг и отладка

### Логи Edge Functions:

```bash
# Все логи
supabase functions logs index-faces --project-ref llttmftapmwebidgevmg

# Только ошибки
supabase functions logs index-faces --project-ref llttmftapmwebidgevmg --level error
```

### Проверка статуса индексации:

```sql
-- Статистика по ретриту
SELECT
  index_status,
  COUNT(*) as count
FROM public.retreat_photos
WHERE retreat_id = '<retreat_id>'
GROUP BY index_status;

-- Фото с ошибками
SELECT id, storage_path, index_error
FROM public.retreat_photos
WHERE index_status = 'failed'
ORDER BY uploaded_at DESC;
```

### Очистка тестовых данных:

```sql
-- Удалить все фото тестового ретрита
DELETE FROM public.retreat_photos WHERE retreat_id = '<test_retreat_id>';

-- Очистить Collections вручную (через AWS Console или CLI)
aws rekognition delete-collection --collection-id retreat-<retreat_id> --region ap-south-1
```

---

## Стоимость AWS Rekognition

**Цены для региона ap-south-1 (Mumbai):**
- IndexFaces: $1.50 за 1000 изображений
- SearchFacesByImage: $1.50 за 1000 запросов
- Storage лиц: $0.01 за 1000 лиц/месяц

**Пример расчёта для ретрита на 100 человек:**
- 1000 фото × $1.50/1000 = $1.50 (индексация)
- 100 селфи × $1.50/1000 = $0.15 (поиск)
- 3000 лиц × $0.01/1000 = $0.03/месяц (хранение)
- **Итого:** ~$1.70 за ретрит + $0.03/месяц

---

## Troubleshooting

### Проблема: Фото загрузились, но не индексируются

**Решение:**
1. Проверить, что Edge Function задеплоена:
   ```bash
   supabase functions list --project-ref llttmftapmwebidgevmg
   ```
2. Проверить логи функции:
   ```bash
   supabase functions logs index-faces --project-ref llttmftapmwebidgevmg
   ```
3. Проверить AWS credentials в Secrets:
   ```bash
   supabase secrets list --project-ref llttmftapmwebidgevmg
   ```
4. Вручную запустить индексацию:
   ```bash
   curl -X POST https://llttmftapmwebidgevmg.supabase.co/functions/v1/index-faces \
     -H "Authorization: Bearer <anon_key>" \
     -d '{"retreat_id": "<retreat_id>", "batch_size": 20}'
   ```

### Проблема: "Найти себя" не находит фото

**Возможные причины:**
1. Фото не проиндексированы (`index_status != 'indexed'`)
2. Низкий порог similarity (увеличить threshold до 70-75)
3. Плохое качество селфи (использовать чёткое фото лица)
4. Лицо на групповом фото слишком маленькое

**Решение:**
- Переиндексировать фото с ретрита
- Попробовать другое селфи
- Снизить threshold до 70

### Проблема: RLS ошибка при загрузке фото

**Решение:**
1. Проверить, что у пользователя есть право `upload_photos`:
   ```sql
   SELECT * FROM public.user_permissions up
   JOIN public.permissions p ON p.id = up.permission_id
   WHERE up.user_id = '<user_id>' AND p.code = 'upload_photos';
   ```
2. Проверить RLS политики:
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'retreat_photos';
   ```

---

## Контрольный чеклист развёртывания

**БД и инфраструктура:**
- [ ] AWS IAM user создан с правами на Rekognition
- [ ] AWS credentials добавлены в Supabase Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`)
- [ ] Storage bucket `retreat-photos` создан и настроен как public
- [ ] Миграции 108–124 применены
- [ ] Миграция 127 применена (исправление удаления фото)
- [ ] Миграция 128 применена (`face_tags.rejected`)

**Edge Functions:**
- [ ] `index-faces` задеплоена
- [ ] `search-face` задеплоена
- [ ] `delete-photos` задеплоена

```bash
# Деплой на прод:
supabase functions deploy index-faces --project-ref llttmftapmwebidgevmg --no-verify-jwt
supabase functions deploy search-face --project-ref llttmftapmwebidgevmg --no-verify-jwt
supabase functions deploy delete-photos --project-ref llttmftapmwebidgevmg --no-verify-jwt

# Деплой на дев:
supabase functions deploy index-faces --project-ref vzuiwpeovnzfokekdetq --no-verify-jwt
supabase functions deploy search-face --project-ref vzuiwpeovnzfokekdetq --no-verify-jwt
supabase functions deploy delete-photos --project-ref vzuiwpeovnzfokekdetq --no-verify-jwt
```

**Права доступа:**
- [ ] Разрешение `upload_photos` создано
- [ ] Роль "Фотограф" назначена пользователям

**Тестирование:**
- [ ] Тестовая загрузка фото прошла успешно
- [ ] Индексация лиц работает (статус `indexed`)
- [ ] Поиск "Найти себя" возвращает результаты
- [ ] Снятие отметки "Вы" работает (поле `rejected=true`, повторный поиск не добавляет снова)
- [ ] Telegram-уведомление отправляется с корректным кол-вом фото
- [ ] Скачивание ZIP работает
- [ ] Каскадное удаление работает (Storage + БД + Rekognition)
