# Модуль: Фотогалерея с AI распознаванием лиц

**Цель модуля**: загрузка, хранение и управление фотографиями с ретритов с автоматическим распознаванием лиц для персонализированного поиска.

**Роли**:
- **Фотограф** (`upload_photos`) — загружает фото, управляет галереей, запускает индексацию
- **Гость** (авторизованный) — ищет себя на фото, скачивает фото с собой

**Используемые технологии**:
- **Supabase Storage** (`retreat-photos` bucket) — хранение оригиналов и превью
- **AWS Rekognition** — индексация лиц, поиск по селфи
- **Edge Functions** — `index-faces`, `search-face`, `delete-photos`

---

## Основные сущности

### 1. Таблица `retreat_photos`

Метаданные фотографий с ретритов.

**Поля**:
- `id` (uuid, PK) — UUID фото
- `retreat_id` (uuid, FK → `retreats.id`) — к какому ретриту относится
- `storage_path` (text) — путь к оригиналу в Storage (например, `{retreat_id}/{uuid}.jpg`)
- `thumb_path` (text, nullable) — путь к превью 400px (например, `{retreat_id}/thumbs/{uuid}.jpg`)
- `mime_type` (text) — MIME-тип (обычно `image/jpeg`)
- `file_size` (bigint) — размер файла в байтах
- `uploaded_by` (uuid, FK → `auth.users.id`) — кто загрузил
- `uploaded_at` (timestamptz) — дата загрузки
- `updated_at` (timestamptz) — последнее обновление (триггер)
- `day_number` (int, nullable) — номер дня ретрита (опционально)
- `index_status` (text) — статус индексации лиц:
  - `pending` — ожидает индексации
  - `processing` — индексируется сейчас
  - `indexed` — проиндексировано
  - `failed` — ошибка индексации
- `index_error` (text, nullable) — текст ошибки индексации
- `faces_count` (int, default 0) — количество найденных лиц

**Индексы**:
- `idx_retreat_photos_retreat_id` — для фильтрации по ретриту
- `idx_retreat_photos_index_status` — для выборки pending/failed фото

**RLS политики**:
- **SELECT**: все авторизованные пользователи
- **INSERT**: только с правом `upload_photos`
- **UPDATE**: только с правом `upload_photos` (для обновления `index_status`)
- **DELETE**: только с правом `upload_photos`

**Триггер**: `set_retreat_photos_updated_at` — автообновление `updated_at`

**Realtime**: включён (`ALTER TABLE retreat_photos REPLICA IDENTITY FULL`) для live-обновления статусов в manage.html

---

### 2. Таблица `photo_faces`

Привязка лиц из AWS Rekognition к фотографиям.

**Поля**:
- `id` (uuid, PK) — UUID записи
- `photo_id` (uuid, FK → `retreat_photos.id`, ON DELETE CASCADE) — к какому фото относится
- `rekognition_face_id` (text, unique) — ID лица в AWS Rekognition (для DeleteFaces)
- `bbox_left` (float4, nullable) — BoundingBox.Left (координата X)
- `bbox_top` (float4, nullable) — BoundingBox.Top (координата Y)
- `bbox_width` (float4, nullable) — BoundingBox.Width
- `bbox_height` (float4, nullable) — BoundingBox.Height
- `confidence` (float4, nullable) — уверенность AWS в том, что это лицо
- `created_at` (timestamptz) — дата создания

**Индексы**:
- `idx_photo_faces_photo_id` — для быстрого поиска лиц на фото
- `idx_photo_faces_rekognition_face_id` — для DeleteFaces и дедупликации

**RLS политики**:
- **SELECT**: все авторизованные пользователи (для отображения рамок лиц)
- **INSERT/UPDATE/DELETE**: только через Edge Functions (Service Role)

**Примечание**: при переиндексации фото сначала удаляются старые записи `photo_faces` для этого `photo_id`, затем вставляются новые (предотвращает duplicate key constraint).

---

### 3. Таблица `face_tags`

Привязка распознанных лиц к конкретным людям (вайшнавам).

**Поля**:
- `id` (uuid, PK) — UUID привязки
- `photo_id` (uuid, FK → `retreat_photos.id`, ON DELETE CASCADE) — фото
- `vaishnava_id` (uuid, FK → `vaishnavas.id`, ON DELETE CASCADE) — кого нашли
- `rekognition_face_id` (text) — ID лица из AWS Rekognition (соответствует `photo_faces.rekognition_face_id`)
- `similarity` (float4) — степень схожести с эталонным фото (0-100)
- `tagged_at` (timestamptz) — когда создана привязка
- `tagged_by` (uuid, FK → `auth.users.id`, nullable) — кто создал (NULL = автоматически)

**Уникальность**: `unique (photo_id, vaishnava_id)` — один вайшнав не может быть дважды на одном фото

**Индексы**:
- `idx_face_tags_photo_id` — для поиска всех людей на фото
- `idx_face_tags_vaishnava_id` — для поиска всех фото конкретного вайшнава

**RLS политики**:
- **SELECT**: все авторизованные пользователи
- **INSERT/UPDATE/DELETE**: только через Edge Functions (Service Role)

**Использование**: фильтр "Фото со мной" в Guest Portal загружает `face_tags` для `currentGuest.id`.

---

### 4. Таблица `face_search_log`

Логирование поисков по селфи (для аналитики и отладки).

**Поля**:
- `id` (uuid, PK) — UUID записи
- `vaishnava_id` (uuid, FK → `vaishnavas.id`) — кто искал
- `selfie_storage_path` (text) — путь к загруженному селфи
- `retreat_id` (uuid, FK → `retreats.id`) — в каком ретрите искали
- `found_photos_count` (int) — сколько фото нашли
- `search_duration_ms` (int, nullable) — длительность поиска в мс
- `searched_at` (timestamptz) — дата поиска

**RLS политики**:
- **SELECT**: только свои записи (`vaishnava_id = auth.uid()`)
- **INSERT**: только через Edge Functions (Service Role)

**Использование**: статистика в админке (планируется).

---

## Структура файлов

```
photos/
├── upload.html          # Загрузка фото (только для фотографов)
├── manage.html          # Управление фото (только для фотографов)
├── js/
│   ├── upload.js        # Логика загрузки с компрессией, retry, прогресс-баром
│   └── manage.js        # Логика управления, индексация, Realtime обновления

guest-portal/
├── index.html           # Главная страница гостя (превью галереи, сортировка)
└── photos.html          # Полная галерея (поиск по селфи, фильтры, скачивание)

supabase/
├── functions/
│   ├── index-faces/     # Edge Function: индексация лиц (батчами по 20)
│   ├── search-face/     # Edge Function: поиск по селфи
│   └── delete-photos/   # Edge Function: каскадное удаление (Rekognition + Storage + БД)
├── 108_face_recognition_tables.sql       # Создание таблиц
├── 109_retreat_photos_storage_policies.sql # RLS политики для Storage
├── 110_photos_translations.sql           # Переводы UI
├── 111_retreat_photos_add_fields_and_fix_policies.sql # Добавление полей
├── 112_fix_retreat_photos_trigger.sql    # Фикс триггера updated_at
├── 113_add_updated_at_to_retreat_photos.sql # Добавление updated_at
├── 114_add_faces_count_to_retreat_photos.sql # Добавление faces_count
├── 115_photos_indexing_translations.sql  # Переводы для прогресса индексации
├── 116_retreat_photos_update_policy.sql  # UPDATE policy для сброса зависших фото
└── 117_enable_realtime_retreat_photos.sql # Включение Realtime для таблицы
```

---

## Основные сценарии

### 1. Загрузка фото фотографом

**Страница**: `/photos/upload.html`

**Шаги**:
1. Фотограф выбирает ретрит из списка
2. Drag & Drop или выбор через input (множественный выбор)
3. **Клиентская компрессия** (если >5MB):
   - Ресайз до max 2048px по большей стороне
   - Конвертация в JPEG с качеством 85%
   - Создание превью 400px
4. Последовательная загрузка файлов:
   - Загрузка оригинала в Storage: `{retreat_id}/{uuid}.jpg`
   - Загрузка превью в Storage: `{retreat_id}/thumbs/{uuid}.jpg`
   - Вставка записи в БД: `retreat_photos` со статусом `pending`
   - **Retry**: до 3 попыток с exponential backoff (1s, 2s, 4s)
5. После загрузки всех фото — **автоматический вызов индексации**:
   - `supabase.functions.invoke('index-faces', { body: { retreat_id, limit: 20 } })`
6. **Polling каждые 3 секунды**:
   - Загрузка статусов всех фото ретрита
   - Отображение прогресса (проиндексировано/всего, %, количество лиц)
   - Запуск следующего батча, если есть `pending` фото и нет активной обработки
   - Остановка при завершении (`indexed + failed === total && processing === 0`)

**Защита от зависания**:
- Если `processing` не меняется >20 секунд → автосброс в `pending`
- Если Edge Function возвращает ошибку 10 раз подряд → остановка polling + уведомление

**UI элементы**:
- Drag & Drop зона с предпросмотром
- Прогресс-бар загрузки (файл за файлом)
- Прогресс-бар индексации (автоматически после загрузки)
- Кнопка "Загрузить ещё" после завершения

---

### 2. Управление фото (manage.html)

**Страница**: `/photos/manage.html`

**Функции**:
- Выбор ретрита из списка
- Отображение всех фото ретрита (сортировка по дате загрузки, новые первые)
- Фильтр по статусу индексации: `all`, `pending`, `indexed`, `failed`
- Множественный выбор фото (чекбоксы)
- **Удаление выбранных фото**:
  - Каскадное удаление через `supabase.functions.invoke('delete-photos', { body: { photo_ids: [...] } })`
  - Edge Function удаляет: Rekognition faces → Storage файлы → БД записи
- **Переиндексация**:
  - "Индексировать необработанные" — только `pending` и `failed` фото
  - "Переиндексировать всё" — сброс всех фото в `pending` + удаление старых `photo_faces`
- **Realtime обновления**:
  - Подписка на `retreat_photos` через Supabase Realtime
  - Автообновление карточек фото и статистики при изменении статуса
  - Обновление только изменённых карточек (не полный рендер)
- **Lightbox** для просмотра фото (навигация стрелками, Escape для закрытия)

**Статистика** (в реальном времени):
- Всего фото
- Проиндексировано
- Ожидает индексации
- Ошибки индексации

---

### 3. Поиск себя гостем (Guest Portal)

**Страница**: `/guest-portal/photos.html`

**Шаги**:
1. Гость загружает селфи (кнопка "Найти себя")
2. Селфи загружается в Storage: `selfies/{vaishnava_id}/{timestamp}.jpg`
3. Вызов Edge Function для **каждого** ретрита гостя:
   ```javascript
   await supabase.functions.invoke('search-face', {
     body: {
       selfie_path: fileName,
       retreat_id: retreatId,
       vaishnava_id: currentUser.id
     }
   })
   ```
4. Edge Function:
   - Скачивает селфи из Storage
   - Ищет похожие лица через AWS Rekognition `SearchFacesByImage`
   - Для каждого найденного лица (similarity ≥ 80%):
     - Получает `photo_id` из `photo_faces` по `rekognition_face_id`
     - Создаёт запись в `face_tags`
   - Возвращает массив `photo_ids`
5. Клиент объединяет результаты всех ретритов в `myPhotos`
6. **Включается фильтр "Фото со мной"** (чекбокс становится активным)
7. Фото с гостем отмечаются бейджем "Вы" (оранжевый) и оранжевой рамкой

**Fallback**: если у гостя нет фото в `vaishnava-photos` bucket, Edge Function использует `vaishnavas.photo_url` (внешняя ссылка).

**Статус поиска** (UI):
- Загрузка фото... (синий спиннер)
- Поиск лиц... (синий спиннер)
- Найдено N фото с вами! (зелёная галочка, автоскрытие через 3 сек)
- Не найдено фото с вами (жёлтое предупреждение, автоскрытие через 5 сек)
- Ошибка: ... (красная ошибка, автоскрытие через 5 сек)

---

### 4. Скачивание фото гостем

**Одиночное фото**:
- Клик на кнопку "Скачать" в lightbox
- Загрузка через `fetch()` → `Blob` → `URL.createObjectURL()` → `<a download>`
- Принудительное скачивание (не открытие в новой вкладке)

**Множественное скачивание** (ZIP):
- Выбор фото через чекбоксы
- Кнопка "Скачать выбранные" (активна только при выборе ≥1 фото)
- Использование **JSZip** (CDN):
  - Загрузка каждого фото через `fetch()`
  - Добавление в архив с именем `{retreat_name}_{date}.jpg`
  - Генерация ZIP (`zip.generateAsync({ type: 'blob' })`)
  - Скачивание архива: `retreat_photos_{timestamp}.zip`
- Прогресс-бар скачивания (X/Y фото)

---

## Архитектура индексации

### AWS Rekognition Collections

**Концепция**: каждый ретрит = отдельная коллекция в AWS Rekognition.

**Формат ID**: `retreat_{retreat_id}`

**Преимущества**:
- Изоляция данных между ретритами
- Быстрый поиск (только внутри коллекции)
- Простое удаление (удалить коллекцию = удалить все лица ретрита)

**Создание коллекции**: автоматически при первой индексации (Edge Function `ensureCollection()`)

---

### Edge Function: index-faces

**Путь**: `/supabase/functions/index-faces/index.ts`

**Вход**:
```typescript
{
  retreat_id: string,
  limit?: number  // default 20, max 50
}
```

**Логика**:
1. Проверка авторизации (наличие `authorization` header)
2. Создание/проверка коллекции AWS Rekognition
3. Выборка фото для индексации:
   ```sql
   SELECT id, storage_path, index_status
   FROM retreat_photos
   WHERE retreat_id = $1
     AND index_status IN ('pending', 'failed')
   ORDER BY updated_at ASC
   LIMIT $2
   ```
4. Пометка фото как `processing`:
   ```sql
   UPDATE retreat_photos
   SET index_status = 'processing', index_error = NULL
   WHERE id IN (...)
   ```
5. Для каждого фото:
   - Скачать файл из Storage (public URL)
   - Проверить размер (<15MB — лимит AWS)
   - Вызов `IndexFacesCommand`:
     - `ExternalImageId = photo_id` (для связи с БД)
     - `MaxFaces = 15`
     - `QualityFilter = AUTO`
   - **Удалить старые `photo_faces`** для этого `photo_id` (предотвращает дубликаты)
   - Вставить новые `photo_faces` (mapping `rekognition_face_id` → `photo_id`)
   - Обновить статус:
     ```sql
     UPDATE retreat_photos
     SET index_status = 'indexed',
         index_error = NULL,
         faces_count = {count}
     WHERE id = photo_id
     ```
   - При ошибке:
     ```sql
     UPDATE retreat_photos
     SET index_status = 'failed',
         index_error = {error_message}
     WHERE id = photo_id
     ```
6. Возврат результата:
   ```json
   {
     "ok": true,
     "retreat_id": "...",
     "collection_id": "retreat_...",
     "processed": 20,
     "indexed": 18,
     "failed": 2,
     "results": [
       { "photo_id": "...", "status": "indexed", "faces_indexed": 3 },
       { "photo_id": "...", "status": "failed", "error": "Image too large" }
     ]
   }
   ```

**Особенности**:
- Батчи по 20 фото (баланс между скоростью и надёжностью)
- Retry логика на стороне клиента (polling запускает новый батч)
- Нет imagescript (прямая передача байтов в Rekognition)
- Логирование в консоль для отладки

---

### Edge Function: search-face

**Путь**: `/supabase/functions/search-face/index.ts`

**Вход**:
```typescript
{
  selfie_path: string,      // путь к селфи в Storage
  retreat_id: string,
  vaishnava_id: string
}
```

**Логика**:
1. Проверка авторизации
2. Скачивание селфи из Storage (public URL или signed URL)
3. Вызов `SearchFacesByImageCommand`:
   - `CollectionId = "retreat_{retreat_id}"`
   - `Image = { Bytes: imageBytes }`
   - `MaxFaces = 50`
   - `FaceMatchThreshold = 80` (минимальная схожесть)
4. Для каждого найденного лица:
   - Получить `photo_id` из `photo_faces` по `FaceId`
   - Создать запись в `face_tags`:
     ```sql
     INSERT INTO face_tags (photo_id, vaishnava_id, rekognition_face_id, similarity)
     VALUES (...)
     ON CONFLICT (photo_id, vaishnava_id) DO NOTHING
     ```
5. Логирование в `face_search_log`
6. Возврат:
   ```json
   {
     "ok": true,
     "retreat_id": "...",
     "vaishnava_id": "...",
     "found_photos": ["photo_id_1", "photo_id_2", ...],
     "count": 5
   }
   ```

**Fallback**: если нет фото в Storage → использовать `vaishnavas.photo_url` (внешний URL)

---

### Edge Function: delete-photos

**Путь**: `/supabase/functions/delete-photos/index.ts`

**Вход**:
```typescript
{
  photo_ids: string[]  // массив UUID фото
}
```

**Логика** (каскадное удаление):
1. Проверка авторизации
2. Загрузка метаданных фото:
   ```sql
   SELECT id, retreat_id, storage_path, thumb_path
   FROM retreat_photos
   WHERE id IN (...)
   ```
3. Группировка по `retreat_id` (коллекции)
4. Для каждой коллекции:
   - Загрузка `rekognition_face_id` из `photo_faces`:
     ```sql
     SELECT DISTINCT rekognition_face_id
     FROM photo_faces
     WHERE photo_id IN (...)
     ```
   - Вызов `DeleteFacesCommand`:
     - `CollectionId = "retreat_{retreat_id}"`
     - `FaceIds = [...]`
5. Удаление файлов из Storage:
   ```javascript
   await supabase.storage
     .from('retreat-photos')
     .remove([storage_path, thumb_path, ...])
   ```
6. Удаление из БД (каскадно через FK):
   ```sql
   DELETE FROM retreat_photos WHERE id IN (...)
   -- Автоматически удалятся photo_faces и face_tags (ON DELETE CASCADE)
   ```
7. Возврат:
   ```json
   {
     "ok": true,
     "deleted": 5,
     "faces_deleted": 12,
     "storage_files_deleted": 10
   }
   ```

---

## Оптимизации и защиты

### 1. Клиентская компрессия фото

**Проблема**: фото с камеры ~10MB → превышение лимита AWS (15MB) и таймауты Edge Function.

**Решение**: компрессия на клиенте перед загрузкой.

**Реализация** (`photos/js/upload.js`):
```javascript
async function compressImageIfNeeded(file) {
  const MAX_SIZE = 5 * 1024 * 1024; // 5 МБ
  if (file.size <= MAX_SIZE) return file;

  // Ресайз до max 2048px по большей стороне
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();

  // ... рисуем на canvas ...

  // Конвертация в Blob с качеством 0.85
  canvas.toBlob((blob) => {
    const compressedFile = new File([blob], file.name, {
      type: 'image/jpeg',
      lastModified: Date.now()
    });
    resolve(compressedFile);
  }, 'image/jpeg', 0.85);
}
```

**Результат**: 10MB → ~2-3MB, время индексации ↓, надёжность ↑

---

### 2. Детект зависших фото

**Проблема**: при ошибках Edge Function фото могут навсегда остаться в статусе `processing`.

**Решение**: клиентский детект и автосброс.

**Реализация** (`photos/js/manage.js`, `photos/js/upload.js`):
```javascript
if (processing === lastProcessingCount && processing > 0) {
  stuckCounter++;
  if (stuckCounter >= 7) { // 7 × 3 сек = 21 сек
    // Сброс в pending
    await db.from('retreat_photos')
      .update({ index_status: 'pending', index_error: 'Timeout - reset by client' })
      .eq('retreat_id', retreatId)
      .eq('index_status', 'processing');

    stuckCounter = 0;
  }
} else {
  stuckCounter = 0;
  lastProcessingCount = processing;
}
```

**Результат**: фото не зависают навсегда, автоматически переиндексируются.

---

### 3. Защита от бесконечных вызовов Edge Function

**Проблема**: при повторяющихся ошибках AWS (например, неверные credentials) polling продолжает вызывать Edge Function каждые 3 секунды.

**Решение**: счётчик последовательных ошибок + остановка после 10 ошибок.

**Реализация**:
```javascript
if (error) {
  edgeFunctionErrorCounter++;
  if (edgeFunctionErrorCounter >= 10) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    // Уведомление пользователю
  }
} else {
  edgeFunctionErrorCounter = 0; // Сброс при успехе
}
```

**Результат**: защита от чрезмерной нагрузки на БД и Edge Function.

---

### 4. Realtime обновления статусов

**Проблема**: при работе нескольких вкладок или пользователей статусы фото не синхронизируются.

**Решение**: Supabase Realtime подписка.

**Включение** (миграция 117):
```sql
ALTER TABLE retreat_photos REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE retreat_photos;
```

**Реализация** (`photos/js/manage.js`):
```javascript
realtimeChannel = db
  .channel(`retreat_photos:${retreatId}`)
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'retreat_photos',
    filter: `retreat_id=eq.${retreatId}`
  }, (payload) => {
    handleRealtimeChange(payload);
  })
  .subscribe();
```

**Результат**: live-обновление карточек фото без перезагрузки страницы.

---

### 5. Batch processing и polling

**Концепция**: индексация происходит батчами по 20 фото, клиент запускает следующий батч через polling.

**Преимущества**:
- Надёжность: если Edge Function упала — следующий батч запустится через 3 сек
- Прогресс: пользователь видит реальный прогресс индексации
- Асинхронность: фотограф может закрыть страницу, индексация продолжится (другие пользователи или повторный визит)

**Условие запуска следующего батча**:
```javascript
if (pending > 0 && (processing === 0 || stuckCounter > 3)) {
  // Запустить следующий батч
}
```

**Условие остановки polling**:
```javascript
if (indexed + failed === total && processing === 0) {
  clearInterval(pollingInterval);
}
```

---

## Права доступа

### Permission: `upload_photos`

**Кто**: фотограф (отдельная роль или индивидуальное право)

**Доступ**:
- **INSERT** в `retreat_photos`
- **UPDATE** в `retreat_photos` (для сброса зависших фото)
- **DELETE** в `retreat_photos`
- Вызов Edge Functions: `index-faces`, `delete-photos`
- Страницы: `/photos/upload.html`, `/photos/manage.html`

**Проверка в HTML**:
```javascript
if (!window.hasPermission?.('upload_photos')) {
  alert('Нет прав доступа');
  window.location.href = '../index.html';
}
```

**Проверка в Edge Functions**:
```typescript
const authHeader = req.headers.get("authorization");
if (!authHeader) {
  return json({ error: "Missing authorization header" }, 401);
}
```

---

### Гости (авторизованные пользователи)

**Доступ**:
- **SELECT** из `retreat_photos`, `photo_faces`, `face_tags`
- Вызов Edge Function: `search-face`
- Страницы: `/guest-portal/photos.html`

**Ограничения**:
- Не могут загружать/удалять фото
- Не могут запускать индексацию
- Могут искать только себя (Edge Function проверяет `vaishnava_id = auth.uid()`)

---

## Типичные запросы

### 1. Загрузить все фото ретрита с количеством лиц

```javascript
const { data: photos, error } = await Layout.db
  .from('retreat_photos')
  .select('id, storage_path, thumb_path, faces_count, index_status, uploaded_at')
  .eq('retreat_id', retreatId)
  .order('uploaded_at', { ascending: false });
```

---

### 2. Загрузить фото с моими лицами

```javascript
// 1. Получить мои photo_ids из face_tags
const { data: myTags } = await supabase
  .from('face_tags')
  .select('photo_id')
  .eq('vaishnava_id', currentUser.id);

const myPhotoIds = myTags.map(t => t.photo_id);

// 2. Загрузить фото
const { data: photos } = await supabase
  .from('retreat_photos')
  .select('id, storage_path, thumb_path, retreat_id')
  .in('id', myPhotoIds)
  .order('uploaded_at', { ascending: false });
```

---

### 3. Подсчёт статистики по статусам индексации

```javascript
const { data, error } = await Layout.db
  .from('retreat_photos')
  .select('index_status')
  .eq('retreat_id', retreatId);

const total = data.length;
const indexed = data.filter(p => p.index_status === 'indexed').length;
const pending = data.filter(p => p.index_status === 'pending').length;
const failed = data.filter(p => p.index_status === 'failed').length;
```

---

### 4. Загрузить лица на конкретном фото

```javascript
const { data: faces, error } = await supabase
  .from('photo_faces')
  .select(`
    id,
    rekognition_face_id,
    bbox_left,
    bbox_top,
    bbox_width,
    bbox_height,
    confidence
  `)
  .eq('photo_id', photoId);
```

---

### 5. Загрузить людей на конкретном фото

```javascript
const { data: tags, error } = await supabase
  .from('face_tags')
  .select(`
    id,
    vaishnava_id,
    similarity,
    vaishnavas (
      spiritual_name,
      first_name,
      last_name
    )
  `)
  .eq('photo_id', photoId);
```

---

## Стоимость AWS Rekognition

**Модель ценообразования** (ap-south-1 Mumbai):
- **Хранение коллекций**: $0.01 за 1000 лиц/месяц
- **IndexFaces**: $1 за 1000 изображений
- **SearchFacesByImage**: $1 за 1000 поисков

**Расчёт для ШРСК** (из ТЗ):
- 10 ретритов/год × 100 чел × 700 фото = 700,000 фото/год
- Среднее 3 лица/фото = 2,100,000 лиц
- Хранение: 2,100 × $0.01 = **$21/год**
- Индексация: 700 × $1 = **$700/год**
- Поиски: 10 × 100 × $1/1000 = **$1/год**

**Итого**: ~$722/год (с учётом переиндексации ~$800/год)

**Оптимизация**:
- Удаление старых коллекций (ретриты >3 лет назад)
- Лимит на количество поисков в день на пользователя

---

## Troubleshooting

### 1. Фото зависли в `processing`

**Причина**: Edge Function упала или таймаут

**Решение**:
- Автоматически: детект через 20 секунд → сброс в `pending`
- Вручную (SQL):
  ```sql
  UPDATE retreat_photos
  SET index_status = 'pending', index_error = 'Manual reset'
  WHERE index_status = 'processing';
  ```

---

### 2. Ошибка 546 при вызове Edge Function

**Причина**: неверные AWS credentials в Supabase Secrets

**Решение**:
1. Проверить Secrets в Supabase Dashboard:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` (должен быть `ap-south-1`)
2. Пересоздать IAM user в AWS Console (policy: `SrskRekognitionOnly`)

---

### 3. "Image too large" при индексации

**Причина**: фото >15MB (лимит AWS Rekognition)

**Решение**:
- Клиентская компрессия перед загрузкой (уже реализовано)
- Если всё равно >15MB → увеличить компрессию (снизить качество с 0.85 до 0.7)

---

### 4. Не находит гостя при поиске по селфи

**Причины**:
- Качество селфи (размытость, угол, освещение)
- Не проиндексированы фото ретрита
- Порог схожести (80%) слишком высокий

**Решение**:
- Попробовать другое селфи (анфас, хорошее освещение)
- Проверить статус индексации фото ретрита в `manage.html`
- Снизить порог в Edge Function (80% → 70%)

---

### 5. Duplicate key constraint в `photo_faces`

**Причина**: переиндексация без удаления старых записей

**Решение**: уже исправлено в миграции — Edge Function сначала удаляет старые `photo_faces`, затем вставляет новые.

---

## Roadmap (будущие улучшения)

### Фаза 3: Telegram бот + уведомления
- [ ] Создать бота (@rupaseva_bot)
- [ ] Миграция: `vaishnavas.telegram_chat_id`
- [ ] Edge Function: telegram-webhook
- [ ] Уведомление "Новые фото с ретрита!"
- [ ] Уведомление "Нашли вас на N фото!"

### Фаза 4 (опционально):
- [ ] Ручная разметка лиц (для тренировки модели)
- [ ] Групповые фото (теги нескольких людей на одном фото)
- [ ] Альбомы и категории (официальные/неофициальные фото)
- [ ] Лайки и комментарии к фото
- [ ] Экспорт альбома в PDF (для печати)
- [ ] Интеграция с Google Photos (автозагрузка)
- [ ] Защита авторских прав (watermark, EXIF данные)

---

## Связанные документы

- [PLAN-dev-and-photos.md](../../PLAN-dev-and-photos.md) — ТЗ и детальный план реализации
- [docs/photo-permissions-setup.md](../../docs/photo-permissions-setup.md) — настройка прав `upload_photos`
- [docs/photos-module-setup.md](../../docs/photos-module-setup.md) — первоначальная настройка модуля
- [docs/photos-module-deployment.md](../../docs/photos-module-deployment.md) — деплой Edge Functions
- [docs/photos-module-usage.md](../../docs/photos-module-usage.md) — инструкция для фотографов и гостей
- [supabase/PHOTO_MODULE_MIGRATIONS.md](../../supabase/PHOTO_MODULE_MIGRATIONS.md) — список миграций БД

---

**Дата создания**: 11.02.2026
**Версия**: 1.0
**Статус**: Фаза 2 завершена ✅
