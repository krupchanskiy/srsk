# План: Dev-окружение + Фотогалерея с AI

## Часть 1: Dev-окружение

### Текущее состояние

- Production: `in.rupaseva.com` → GitHub Pages из `main`
- Supabase prod: `llttmftapmwebidgevmg`
- Supabase dev: `vzuiwpeovnzfokekdetq` (уже существует!)
- CI/CD: нет (пуш в main = мгновенный деплой)
- Сборка: нет (статика)

### Проблема

Любой пуш в `main` = сразу production. Нет возможности проверить изменения на живом URL перед выкаткой.

### Рекомендуемое решение: ветки + Vercel

**Почему НЕ два репо:**

- Синк CNAME, конфликты, двойная работа
- У вас УЖЕ есть два Supabase-проекта (dev и prod) — этого достаточно для разделения данных

**Почему Vercel:**

- Встроенный cron (`vercel.json`) — нужен для очереди распознавания лиц
- Лучшая поддержка Vite (для будущей миграции на TypeScript, Фаза 3)
- Serverless Functions с хорошим DX — если понадобится серверная логика сверх Supabase Edge Functions
- Бесплатный план: 100GB bandwidth, deploy previews для PR
- Zero config для статики

**Схема:**

```
main branch  → GitHub Pages  → in.rupaseva.com     (prod, Supabase prod)
dev branch   → Vercel         → dev.rupaseva.com    (staging, Supabase dev)
feature/*    → Vercel preview  → random-url.vercel.app (PR preview)
```

### Шаги реализации

**1. Настройка конфигурации по окружению (1-2 часа)**

Сейчас `js/config.js` содержит оба конфига, но переключение — через код.

Нужно: автоматическое определение по домену:

```javascript
// js/config.js — автоопределение окружения
const IS_DEV = window.location.hostname.includes('dev.')
            || window.location.hostname.includes('vercel.app')
            || window.location.hostname === 'localhost';

const CONFIG = IS_DEV ? {
  SUPABASE_URL: 'https://vzuiwpeovnzfokekdetq.supabase.co',
  SUPABASE_ANON_KEY: '...'
} : {
  SUPABASE_URL: 'https://llttmftapmwebidgevmg.supabase.co',
  SUPABASE_ANON_KEY: '...'
};
```

То же для `guest-portal/js/portal-config.js`.

**2. Создание ветки dev (10 минут)**

```bash
git checkout -b dev
git push origin dev
```

**3. Подключение Vercel (30 минут)**

1. Зарегистрироваться на vercel.com
2. New Project → Import from GitHub → krupchanskiy/srsk
3. Framework Preset: Other
4. Root Directory: `/`
5. Git Branch: `dev` (production branch в Vercel = dev ветка нашего репо)
6. Deploy previews: включены по умолчанию для всех PR
7. Custom domain: `dev.rupaseva.com`

**4. DNS для dev.rupaseva.com (10 минут)**

```
dev.rupaseva.com → CNAME → cname.vercel-dns.com
```

**5. Синхронизация данных между Supabase dev и prod**

По умолчанию — тестовые данные в dev Supabase. Но когда нужны свежие данные (долго не работали с системой, тестирование на реальных данных) — синхронизация с прода:

```bash
# Экспорт с прода (структура + данные)
supabase db dump --project-ref llttmftapmwebidgevmg > prod-dump.sql

# Импорт в dev (ОСТОРОЖНО: затирает все данные в dev!)
supabase db reset --project-ref vzuiwpeovnzfokekdetq
psql "postgresql://postgres:PASSWORD@db.vzuiwpeovnzfokekdetq.supabase.co:5432/postgres" < prod-dump.sql

# Только структура (без данных)
supabase db dump --project-ref llttmftapmwebidgevmg --schema-only > prod-schema.sql
```

**Что синхронизировать:**

| Что | Когда |
|-----|-------|
| Структура (таблицы, RLS, функции) | После каждой миграции на проде |
| Данные (справочники: комнаты, здания, переводы) | Раз в месяц или по запросу |
| Пользовательские данные (vaishnavas, bookings) | Только для отладки конкретного бага |

**Важно:** после импорта данных с прода — сбросить пароли тестовых пользователей в dev, чтобы не было утечки prod-credentials.

### Workflow после настройки

```
1. git checkout -b feature/new-thing    # новая ветка от dev
2. ... работаешь ...
3. git push origin feature/new-thing
4. Открываешь PR в dev → Vercel создаёт preview URL
5. Проверяешь на preview URL (с dev Supabase)
6. Мержишь в dev → dev.rupaseva.com обновляется
7. Тестируешь на dev.rupaseva.com
8. Создаёшь PR из dev → main
9. Мержишь → GitHub Pages деплоит на in.rupaseva.com
```

**6. Vercel cron (опционально, для будущих задач)**

С Collections очередь и cron для распознавания НЕ нужны — поиск мгновенный.
Vercel cron пригодится для других задач (email-дайджесты, очистка старых коллекций).

### Оценка: 2-3 часа на всё

---

## Часть 2: Фотогалерея с AI-поиском лиц

### Бизнес-логика

**Акторы:**

| Роль | Действия |
|------|----------|
| **Фотограф** | Отдельная роль (`upload_photos`). Загружает фото с ретрита (batch upload) |
| **Гость** | Просматривает ВСЕ фото ретрита, нажимает «Найти себя» |
| **Система** | Распознаёт лицо, отмечает фото, уведомляет через Telegram |

**User Flow:**

```
Фотограф:
1. Заходит в admin → Фото ретрита
2. Выбирает ретрит
3. Загружает пачку фото (drag & drop или выбор файлов)
4. Фото сохраняются в Storage, привязываются к ретриту
5. Фронтенд запускает индексацию лиц батчами (Edge Function index-faces)
6. После индексации → Telegram уведомление гостям: «Новые фото с ретрита!»

Гость:
1. Открывает Guest Portal → Фото
2. Видит ВСЕ фото текущего/прошлого ретрита (галерея)
3. Может листать, увеличивать, скачивать
4. Нажимает «Найти себя»
5. Rekognition ищет по коллекции → результат за 1-2 секунды
6. В галерее — фильтр «Фото со мной» (отмеченные фото подсвечены)
7. Может нажать повторно (новые фото добавились) — снова мгновенно
```

### Объёмы (от заказчика)

| Параметр | Значение |
|----------|----------|
| Людей на ретрите | 100 |
| Ретритов в год | 10 |
| Фото в день | 100 |
| Дней в ретрите | 7 |
| **Фото за ретрит** | **700** |
| **Фото в год** | **7,000** |
| Конверсия «Найти себя» | ~50% (50 человек) |

### Архитектура (Rekognition Collections)

Ключевое решение: используем **Rekognition Collections** — индексируем лица при загрузке, ищем за 1 вызов.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ Фотограф    │────→│ Supabase     │     │ Guest Portal    │
│ (Admin UI)  │     │ Storage      │←────│ (Галерея)       │
│ Batch upload│     │ retreat-photos│     │ Просмотр + поиск│
└──────┬──────┘     └──────────────┘     └────────┬────────┘
       │                                          │
       ▼                                          ▼
┌──────────────────┐                   ┌─────────────────────┐
│ Edge Function    │                   │ Edge Function        │
│ index-faces      │                   │ search-face          │
│                  │                   │                      │
│ При загрузке:    │                   │ «Найти себя»:        │
│ 1. IndexFaces    │                   │ 1. SearchFacesByImage│
│    (каждое фото) │                   │    (1 вызов!)        │
│ 2. Сохранить     │                   │ 2. Результат за 1-2с │
│    face_id в БД  │                   │ 3. Сохранить в БД    │
└──────────────────┘                   │ 4. Показать сразу    │
                                       └─────────────────────┘

Rekognition Collection (retreat_{id}):
  Хранит эмбеддинги всех лиц со всех фото ретрита
  SearchFaces ищет по всей коллекции за 1 запрос
```

**Почему Collections, а не попарное сравнение:**

| Подход | Вызовов API | Стоимость/ретрит | Время ответа |
|--------|------------|-----------------|--------------|
| В лоб: 50 гостей × 700 фото | 35,000 | $35.00 | Минуты (очередь) |
| **Collections: 700 index + 50 search** | **750** | **$0.75** | **1-2 секунды** |

Разница в 47 раз дешевле и мгновенный результат вместо очереди.

### Таблицы БД (новые)

```sql
-- Фото ретрита
CREATE TABLE retreat_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retreat_id UUID REFERENCES retreats(id) NOT NULL,
  storage_path TEXT NOT NULL,          -- путь в Supabase Storage
  -- thumbnails не хранятся: CDN Image Transforms генерирует на лету
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  width INT,
  height INT,
  file_size INT,                       -- байты
  day_number INT,                      -- день ретрита (для группировки)
  caption TEXT,                        -- подпись (опционально)
  index_status TEXT DEFAULT 'pending'  -- pending | processing | indexed | failed
    CHECK (index_status IN ('pending', 'processing', 'indexed', 'failed')),
  index_error TEXT                     -- текст ошибки если failed
);

-- Связь фото ↔ лица в Rekognition Collection
-- Одно фото может содержать несколько лиц, у каждого свой face_id
CREATE TABLE photo_faces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID REFERENCES retreat_photos(id) ON DELETE CASCADE NOT NULL,
  rekognition_face_id TEXT NOT NULL,   -- FaceId из Rekognition IndexFaces response
  bbox_x FLOAT, bbox_y FLOAT,         -- координаты лица (% от размера, из BoundingBox)
  bbox_w FLOAT, bbox_h FLOAT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(photo_id, rekognition_face_id)
);

-- Отметки лиц на фото
CREATE TABLE face_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID REFERENCES retreat_photos(id) NOT NULL,
  vaishnava_id UUID REFERENCES vaishnavas(id) NOT NULL,
  confidence FLOAT,                    -- уверенность AI (0-1)
  bbox_x FLOAT, bbox_y FLOAT,         -- координаты лица (% от размера)
  bbox_w FLOAT, bbox_h FLOAT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(photo_id, vaishnava_id)       -- один человек на фото = одна запись
);

-- Rekognition Collections (одна коллекция на ретрит)
-- Коллекция создаётся при первой загрузке фото на ретрит
-- Имя: retreat_{retreat_id}
-- Удаляется через N месяцев после ретрита (экономия)

-- Лог поисков (для аналитики, опционально)
CREATE TABLE face_search_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vaishnava_id UUID REFERENCES vaishnavas(id) NOT NULL,
  retreat_id UUID REFERENCES retreats(id) NOT NULL,
  photos_matched INT DEFAULT 0,
  searched_at TIMESTAMPTZ DEFAULT now()
);
```

### RLS политики (новые таблицы)

```sql
-- retreat_photos: фотограф загружает, участники ретрита читают
ALTER TABLE retreat_photos ENABLE ROW LEVEL SECURITY;

-- Чтение: только участники ретрита (зарегистрированные + команда)
CREATE POLICY "retreat_photos_select" ON retreat_photos FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM retreat_registrations rr
    JOIN profiles p ON p.vaishnava_id = rr.vaishnava_id
    WHERE rr.retreat_id = retreat_photos.retreat_id
      AND p.user_id = auth.uid()
      AND rr.status IN ('guest', 'team')
  )
);

-- Вставка/удаление: только пользователи с permission upload_photos
CREATE POLICY "retreat_photos_insert" ON retreat_photos FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM user_permissions up
    JOIN permissions perm ON perm.id = up.permission_id
    WHERE up.user_id = auth.uid() AND perm.code = 'upload_photos'
  )
);

CREATE POLICY "retreat_photos_delete" ON retreat_photos FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM user_permissions up
    JOIN permissions perm ON perm.id = up.permission_id
    WHERE up.user_id = auth.uid() AND perm.code = 'upload_photos'
  )
);

-- photo_faces: только система (Edge Function с service_role_key)
ALTER TABLE photo_faces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "photo_faces_select" ON photo_faces FOR SELECT USING (true);
-- INSERT/UPDATE/DELETE — только service_role (Edge Functions)

-- face_tags: чтение — участники ретрита, запись — Edge Functions
ALTER TABLE face_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "face_tags_select" ON face_tags FOR SELECT USING (true);
-- INSERT — только service_role

-- face_search_log: пользователь видит только свои
ALTER TABLE face_search_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "face_search_log_select" ON face_search_log FOR SELECT USING (
  vaishnava_id IN (
    SELECT vaishnava_id FROM profiles WHERE user_id = auth.uid()
  )
);
```

**Принцип:** фото ретрита видят только участники этого ретрита. Запись в AI-таблицы — только через Edge Functions (service_role_key). Суперпользователи обходят RLS как обычно.

### AI-сервис: Amazon Rekognition (Collections)

**Рекомендация:** Amazon Rekognition — лучшее соотношение цена/качество + нативные Collections.

**Стоимость (реальные объёмы):**

| Операция | За ретрит | За год (×10) |
|----------|-----------|-------------|
| IndexFaces (при загрузке 700 фото) | 700 × $0.001 = **$0.70** | $7.00 |
| SearchFacesByImage (50 гостей × «Найти себя») | 50 × $0.001 = **$0.05** | $0.50 |
| Хранение метаданных лиц в коллекции | ~$0.01 | ~$0.10 |
| **Итого AI** | **~$0.76** | **~$7.60** |

**Хранение фото (среднее фото ~7.5 МБ JPEG, хорошее качество):**

| | За ретрит | За год (×10) | Накопительно |
|---|---|---|---|
| Оригиналы (700 × 10 МБ) | 7 ГБ | 70 ГБ | +70 ГБ/год |
| Thumbnails | **0** (CDN Image Transforms) | **0** | **0** |
| **Итого** | **~7 ГБ** | **~70 ГБ** | **+70 ГБ/год** |

Thumbnails не хранятся отдельно — Supabase CDN генерирует и кэширует их на лету:

```javascript
// Оригинал (для просмотра полного фото)
supabase.storage.from('retreat-photos').getPublicUrl('photo.jpg')

// Thumbnail для галереи (CDN ресайзит и кэширует автоматически)
supabase.storage.from('retreat-photos').getPublicUrl('photo.jpg', {
  transform: { width: 400, height: 300 }
})
```

CDN глобально распределён — фото отдаются с ближайшего узла (Индия, Европа, США).

**Хранение: Supabase Storage (входит в Pro, уже оплачен)**

| Год | Накоплено | В лимит Pro (100 ГБ)? | Доплата |
|-----|----------|----------------------|---------|
| 1 | 70 ГБ | Да | **$0** |
| 2 | 140 ГБ | 40 ГБ сверх | $0.84/мес |
| 3 | 210 ГБ | 110 ГБ сверх | $2.31/мес |
| 5 | 350 ГБ | 250 ГБ сверх | $5.25/мес |
| 10 | 700 ГБ | 600 ГБ сверх | $12.60/мес |

Срок хранения: **вечно**. Даже через 10 лет — $12.60/мес за 700 ГБ фотоархива.

Bandwidth: ~50 ГБ в пик ретрита — в рамках 250 ГБ/мес Pro.

**Общая стоимость фотогалереи в год:**

| Компонент | Стоимость/год |
|-----------|--------------|
| AI (Rekognition Collections) | ~$8 |
| Хранение (Supabase Storage, входит в Pro) | **$0** (первый год) |
| Уведомления (Telegram Bot API) | **$0** |
| Vercel (free tier) | $0 |
| **Итого** | **~$8/год** |

### Edge Functions vs VPS — где крутить распознавание?

Разработчик предложил VPS. Анализ:

**Что делает наш код?**

Не крутит ML-модель. Отправляет фото во внешний API (Rekognition) и получает результат. Это HTTP-запросы, а не вычисления.

**С Collections проблема таймаута СНЯТА:**

| Операция | Вызовов | Время |
|----------|---------|-------|
| IndexFaces (при загрузке фото) | 1 вызов на фото, ~0.5 сек | Фоново при загрузке |
| SearchFacesByImage («Найти себя») | **1 вызов на гостя** | **1-2 секунды** |

Раньше нужно было сравнивать лицо гостя с каждым фото (700 вызовов, 150+ секунд). С Collections — один запрос к проиндексированной коллекции.

**Вердикт:** VPS не нужен. Edge Function укладывается в 2-5 секунд.

VPS нужен ТОЛЬКО если:
- Крутим свою ML-модель (InsightFace) вместо Rekognition
- Нужен GPU для обработки

### Два потока обработки

**Поток 1: Индексация (при загрузке фотографом)**

**Триггер:** фронтенд вызывает Edge Function после каждого batch upload. НЕ Storage webhook (нет встроенного триггера в Supabase Storage), НЕ DB trigger (нужен доступ к файлу в Storage).

**Механизм батчинга (защита от таймаута):**

Supabase Edge Functions: лимит **150 секунд** (Pro). IndexFaces ~0.5 сек/фото → максимум ~250 фото за один вызов. Но с запасом на сеть и ошибки — берём **батч по 20 фото**.

```
Фронтенд (photos/upload.html):
  1. Фотограф выбирает файлы (drag & drop / file picker)
  2. Файлы загружаются в Storage ПОСЛЕДОВАТЕЛЬНО (по одному, с прогрессбаром)
     → При каждом успешном upload — INSERT в retreat_photos (status='pending')
  3. После загрузки ВСЕХ файлов (или каждые 20) — вызов Edge Function:
     POST /functions/v1/index-faces
     Body: { retreat_id, photo_ids: [...до 20 штук] }
  4. Фронтенд показывает прогресс: "Индексация: 40/100 фото..."
  5. Если фото > 20 — фронтенд вызывает Edge Function В ЦИКЛЕ:
     - batch 1: photo_ids[0..19]   → ждём ответа
     - batch 2: photo_ids[20..39]  → ждём ответа
     - ...
  6. Каждый batch — отдельный вызов Edge Function (~10-15 сек)

Edge Function index-faces:
  1. Получает { retreat_id, photo_ids }
  2. Проверяет/создаёт Rekognition Collection: retreat_{retreat_id}
  3. Для каждого photo_id:
     a. UPDATE retreat_photos SET index_status = 'processing'
     b. Скачивает фото из Storage (signed URL)
     c. Rekognition.IndexFaces(CollectionId, Image, ExternalImageId=photo_id)
     d. Для каждого обнаруженного лица → INSERT в photo_faces (face_id, bbox)
     e. UPDATE retreat_photos SET index_status = 'indexed'
     f. При ошибке → SET index_status = 'failed', index_error = '...'
  4. Возвращает { indexed: N, failed: N, details: [...] }
```

**Фотограф НЕ обязан ждать** — может закрыть страницу. Неиндексированные фото (status='pending') можно доиндексировать позже кнопкой «Индексировать оставшиеся» на manage.html.

**Поток 2: Поиск (по запросу гостя, мгновенный)**

```
Гость нажимает «Найти себя»
  → Проверка: есть ли у гостя фото профиля? (см. ниже «Источник фото для поиска»)
  → Edge Function search-face:
    POST /functions/v1/search-face
    Body: { retreat_id, vaishnava_id }

    1. Загружает фото профиля гостя из Storage (vaishnava-photos bucket)
    2. Rekognition.SearchFacesByImage(
         CollectionId = retreat_{retreat_id},
         Image = фото профиля,
         FaceMatchThreshold = 80,  -- порог уверенности 80%
         MaxFaces = 100
       )
    3. Получает список { FaceId, Similarity } за 1-2 секунды
    4. По FaceId → JOIN photo_faces → получает photo_id
    5. INSERT в face_tags (photo_id, vaishnava_id, confidence, bbox)
       ON CONFLICT (photo_id, vaishnava_id) DO UPDATE SET confidence = EXCLUDED.confidence
    6. INSERT в face_search_log (vaishnava_id, retreat_id, photos_matched)
    7. Возвращает { matched_photo_ids: [...], total: N }

  → Гость видит отмеченные фото МГНОВЕННО
  → Повторный поиск (после загрузки новых фото) — тоже мгновенно
```

**Очередь НЕ НУЖНА** — SearchFacesByImage возвращает результат за 1-2 секунды.

### Источник фото для поиска «Найти себя»

**Проблема:** SearchFacesByImage требует фото лица гостя. Не у всех есть фото профиля.

**Решение — 3 уровня fallback:**

1. **Фото профиля** (vaishnava-photos bucket) — основной вариант. Большинство гостей загружают при регистрации через Guest Portal.

2. **Селфи прямо сейчас** — если фото профиля нет, Guest Portal предлагает:
   - Мобильный: открыть камеру (`<input type="file" accept="image/*" capture="user">`)
   - Десктоп: загрузить файл
   - Фото используется ТОЛЬКО для поиска, не сохраняется в профиль (если гость не хочет)

3. **Нет возможности** — кнопка «Найти себя» неактивна с подсказкой: «Загрузите фото профиля, чтобы AI мог найти вас на фотографиях ретрита»

**Ограничения качества:**

- Rekognition требует минимум 80×80 пикселей лица на фото
- Селфи крупным планом работает лучше, чем фото в группе
- Если совпадений 0 — показать подсказку: «Попробуйте загрузить другое фото (крупный план лица, хорошее освещение)»

### Уведомления: Telegram бот

**Почему ТГ, а не email:**

- 90% гостей в Telegram
- Resend не любит .ru почты (спам/недоставка)
- Бесплатно (Telegram Bot API без лимитов)
- Мгновенная доставка, push-уведомления

**Архитектура:**

```
Supabase Edge Function → Telegram Bot API → гостям в личку
```

**Telegram бот (@rupaseva_bot или аналог):**

- Гость подписывается при регистрации на ретрит (ссылка в Guest Portal)
- Привязка: vaishnavas.telegram_chat_id (новое поле)
- Админ может отправить массовую рассылку по ретриту

**Типы уведомлений:**

1. «Новые фото с ретрита!» — при загрузке фотографом
2. «Мы нашли вас на N фотографиях! Посмотреть →» — после распознавания
3. Общие уведомления ретрита (расписание, изменения) — бонус на будущее

**Подписка через Deep Link (безопасная привязка):**

Проблема: как бот узнаёт, какой vaishnava написал `/start`? Просто chat_id ничего не говорит.

Решение: **Deep Link с одноразовым токеном.**

```
Шаг 1: Гость в Guest Portal нажимает «Подключить уведомления»
  → Фронтенд генерирует одноразовый токен:
    INSERT INTO telegram_link_tokens (token, vaishnava_id, expires_at)
    VALUES (random_uuid(), vaishnava_id, now() + interval '15 minutes')
  → Показывает ссылку/QR-код:
    https://t.me/rupaseva_bot?start=TOKEN

Шаг 2: Гость нажимает ссылку → Telegram открывается → /start TOKEN
  → Edge Function (webhook бота):
    1. Парсит TOKEN из /start payload
    2. SELECT vaishnava_id FROM telegram_link_tokens
       WHERE token = TOKEN AND expires_at > now() AND used = false
    3. Если валидный:
       → UPDATE vaishnavas SET telegram_chat_id = chat_id WHERE id = vaishnava_id
       → UPDATE telegram_link_tokens SET used = true
       → Бот отвечает: «Привет, {spiritual_name}! Уведомления подключены ✓»
    4. Если невалидный/просрочен:
       → Бот отвечает: «Ссылка устарела. Перейдите в Guest Portal для новой ссылки»

Шаг 3: Guest Portal показывает «Уведомления подключены ✓» (проверяет telegram_chat_id != null)
```

**Безопасность:**

- Токен одноразовый + TTL 15 минут → нельзя подставить чужой UUID
- Без токена `/start` не привязывает chat_id
- Один vaishnava = один chat_id (перезаписывается при повторной привязке)
- Нет утечки vaishnava_id в URL (только случайный UUID токен)

**Отвязка:**

- Гость пишет `/stop` боту → бот очищает telegram_chat_id
- Или в Guest Portal: «Отключить уведомления» → UPDATE vaishnavas SET telegram_chat_id = null

**Дополнительная таблица:**

```sql
CREATE TABLE telegram_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  vaishnava_id UUID REFERENCES vaishnavas(id) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Автоочистка просроченных токенов (опционально, pg_cron или вручную)
-- DELETE FROM telegram_link_tokens WHERE expires_at < now() - interval '1 day';
```

**Альтернативные способы подписки (без Guest Portal):**

```
Вариант 1: QR-код на ресепшене — содержит deep link с токеном,
           генерируется ресепшеном через admin-панель для конкретного гостя
Вариант 2: Организатор рассылает общую ссылку в чат ретрита →
           при /start без токена бот предлагает войти через Guest Portal
```

### Страницы (новые/изменённые)

**Admin (для фотографа):**

- `photos/upload.html` — batch upload фото на ретрит (drag & drop, множественная загрузка)
- `photos/manage.html` — управление фото (удаление, подписи, переиндексация)

**Guest Portal (для гостя):**

- `guest-portal/photos.html` — галерея фото ретрита
  - Все фото (по дням)
  - Фильтр «Фото со мной» (после распознавания)
  - Кнопка «Найти себя» (или «Загрузите фото» если нет фото профиля)
  - Скачивание фото (одиночное + zip-архив «Скачать все мои фото»)

### Batch upload: техническая реализация

**Проблема:** фото ~10 МБ × 100 штук = **1 ГБ** за сессию. Браузерный upload нестабилен на больших объёмах.

**Решение: последовательная загрузка с прогрессом и retry.**

```
photos/upload.html — UX:

1. Drag & drop зона (или кнопка «Выбрать файлы»)
2. Превью всех выбранных файлов (thumbnails на клиенте через canvas)
3. Выбор ретрита (dropdown) + день ретрита (опционально)
4. Кнопка «Загрузить»
5. Прогрессбар:
   ┌──────────────────────────────────────────┐
   │ Загрузка: 34/100 фото  [████████░░░] 34% │
   │ Текущий файл: IMG_4521.jpg (7.2 МБ)      │
   │ Скорость: ~2.1 МБ/с                       │
   │ [Пауза]  [Отмена]                         │
   └──────────────────────────────────────────┘
6. После загрузки всех файлов → автоматический запуск индексации (батчами по 20)
7. Прогресс индексации:
   ┌──────────────────────────────────────────┐
   │ Индексация лиц: 60/100  [██████░░░░] 60% │
   │ Найдено лиц: 247                          │
   │ Ошибок: 2 (можно повторить)               │
   └──────────────────────────────────────────┘
```

**Техника загрузки:**

```javascript
// Последовательная загрузка (не параллельная — стабильнее на плохом интернете)
for (const file of files) {
  // 1. Генерируем уникальный путь
  const path = `${retreatId}/${crypto.randomUUID()}.jpg`;

  // 2. Загружаем в Storage (стандартный upload, до 50 МБ на файл)
  const { error } = await supabase.storage
    .from('retreat-photos')
    .upload(path, file, {
      cacheControl: '31536000',  // 1 год кэш (фото не меняются)
      contentType: file.type
    });

  // 3. При ошибке — retry до 3 раз с exponential backoff
  if (error) { await retry(uploadFn, 3); }

  // 4. INSERT в retreat_photos
  await supabase.from('retreat_photos').insert({
    retreat_id: retreatId,
    storage_path: path,
    file_size: file.size,
    day_number: selectedDay,
    index_status: 'pending'
  });

  // 5. Обновляем прогресс
  updateProgress(++uploaded, total);
}
```

**Лимиты Supabase Storage (Pro план):**

| Параметр | Значение |
|----------|----------|
| Макс. размер файла | 5 ГБ (default 50 МБ, настраивается) |
| Макс. файлов в bucket | Без лимита |
| Upload rate limit | 200 req/5 мин (достаточно для 100 фото) |

**Resumable upload НЕ нужен** — Supabase поддерживает tus protocol, но для файлов 10 МБ стандартный upload достаточен. Tus имеет смысл для файлов >50 МБ (видео). Для фото — retry при обрыве проще и надёжнее.

### Удаление фото: каскад операций (photos/manage.html)

Удаление фото — НЕ просто `DELETE FROM retreat_photos`. Нужен каскад:

```
Фотограф нажимает «Удалить фото» (или bulk delete):

1. Подтверждение: «Удалить N фото? Это действие нельзя отменить»

2. Edge Function delete-photos:
   POST /functions/v1/delete-photos
   Body: { photo_ids: [...] }

   Для каждого photo_id:
   a. Получить все face_id из photo_faces
   b. Rekognition.DeleteFaces(CollectionId, FaceIds=[...])
      → Удалить лица из коллекции (иначе «призраки» — поиск будет находить
        лица с удалённых фото)
   c. DELETE FROM face_tags WHERE photo_id = ...
   d. DELETE FROM photo_faces WHERE photo_id = ...
   e. DELETE FROM retreat_photos WHERE id = ...  (CASCADE удалит связи)
   f. supabase.storage.from('retreat-photos').remove([storage_path])

3. Фронтенд обновляет галерею
```

**Кнопка «Переиндексировать»** на manage.html — пересоздание коллекции с нуля:

```
1. Rekognition.DeleteCollection(CollectionId = retreat_{id})
2. Rekognition.CreateCollection(CollectionId = retreat_{id})
3. UPDATE retreat_photos SET index_status = 'pending' WHERE retreat_id = ...
4. TRUNCATE photo_faces WHERE photo_id IN (SELECT id FROM retreat_photos WHERE retreat_id = ...)
5. Запуск индексации батчами (как при первой загрузке)
```

Сценарии когда нужна переиндексация:

- Ошибка в Rekognition Collection (corrupt data)
- Смена региона AWS
- Обновление модели Rekognition (Amazon обновляет ~раз в год)

### Зависимости

```
Dev-окружение ← БЛОКИРУЕТ → Фотогалерея
                              (разрабатывать фотогалерею лучше на dev)

Фотогалерея зависит от:
├── Supabase Storage bucket (retreat-photos) ← создать
├── Таблицы БД ← миграции:
│   ├── retreat_photos (фото + index_status)
│   ├── photo_faces (связь фото ↔ Rekognition face_id)
│   ├── face_tags (связь фото ↔ vaishnava после поиска)
│   ├── face_search_log (аналитика)
│   └── telegram_link_tokens (привязка бота)
├── RLS политики для всех новых таблиц
├── Edge Functions:
│   ├── index-faces (батчами по 20, при загрузке)
│   ├── search-face (мгновенный, по запросу гостя)
│   ├── delete-photos (каскад: Rekognition + Storage + БД)
│   └── telegram-webhook (обработка /start, /stop)
├── AWS аккаунт + Rekognition доступ ✅ ГОТОВО (07.02.2026)
├── Telegram бот (@rupaseva_bot) ← создать через @BotFather
├── Фото профиля у гостей ← уже есть (vaishnava-photos bucket)
└── Fallback: селфи через камеру для гостей без фото профиля
```

---

## Общий план по фазам

### Фаза 0: Dev-окружение (2-3 часа) - ✅ 100% ЗАВЕРШЕНО

- [x] Автоопределение окружения в config.js
- [x] Ветка dev
- [x] Vercel подключение
- [x] DNS dev.rupaseva.com
- [x] Проверка: dev Supabase работает через Vercel

### Фаза 1: Фотогалерея БЕЗ AI (3-5 дней) — ✅ 100% ЗАВЕРШЕНО

- [x] Роль «Фотограф» (permission `upload_photos` в таблице permissions) ✅
- [x] Миграции БД (retreat_photos с index_status) ✅ 108, 109, 110, 111
- [x] Supabase Storage bucket `retreat-photos` + RLS политики ✅
- [x] RLS на retreat_photos (участники ретрита = читают, фотограф = пишет) ✅
- [x] Admin: страница загрузки фото с детальным прогрессом и retry ✅
- [x] Admin: страница manage.html с каскадным удалением из Storage ✅
- [x] Guest Portal: галерея фото ретрита (по дням) ✅
- [x] Thumbnails через CDN Image Transforms (без генерации, Pro фича) ✅
- [x] Скачивание фото (одиночное, принудительное через Blob) ✅
- [x] Скачивание архивом (ZIP) для множественного выбора через JSZip ✅

### Фаза 2: AI Face Recognition (2-4 дня) - ✅ 100% ЗАВЕРШЕНО

- [x] AWS аккаунт + Rekognition доступ (IAM user с минимальными правами) ✅ 07.02.2026
- [x] Миграции БД (photo_faces, face_tags, face_search_log) ✅ 11.02.2026
- [x] RLS на photo_faces, face_tags, face_search_log ✅ 11.02.2026
- [x] Edge Function: index-faces (батчами по 20 фото, автовызов после загрузки) ✅ 11.02.2026
- [x] Edge Function: search-face (поиск по селфи, сохранение в face_tags) ✅ 11.02.2026
- [x] Edge Function: delete-photos (каскад: Rekognition DeleteFaces + Storage + БД) ✅ 11.02.2026
- [x] Автоматический вызов индексации после загрузки фото ✅ 11.02.2026
- [x] Кнопка «Найти себя» в Guest Portal (загрузка селфи → поиск) ✅ 11.02.2026
- [x] Фильтр «Фото со мной» (автозагрузка из face_tags) ✅ 11.02.2026
- [x] Кнопка «Переиндексировать» на manage.html (сброс статуса + вызов Edge Function) ✅ 11.02.2026
- [x] Прогресс-бар индексации с polling каждые 3 секунды ✅ 11.02.2026
- [x] Асинхронная индексация (фотограф может закрыть страницу) ✅ 11.02.2026
- [x] Детект зависших фото в processing (>20 сек → сброс в pending) ✅ 11.02.2026
- [x] Realtime обновления статусов фото в manage.html ✅ 11.02.2026
- [x] Клиентская компрессия фото >5MB перед загрузкой (Canvas API) ✅ 11.02.2026
- [x] Удаление старых photo_faces при переиндексации (fix duplicate key) ✅ 11.02.2026
- [x] UPDATE policy для retreat_photos (миграция 116) ✅ 11.02.2026
- [x] Realtime для retreat_photos (миграция 117) ✅ 11.02.2026
- [x] Защита от бесконечных вызовов Edge Function (счётчик ошибок) ✅ 11.02.2026
- [x] Тестирование с реальными фото (минимум 50 фото, 3 гостя)

### Фаза 3: Telegram бот + уведомления (2-3 дня) - ✅ 100% ЗАВЕРШЕНО

- [x] Создать бота (@rupaseva_bot или аналог) через @BotFather ✅ 12.02.2026
- [x] Миграция 119: поле vaishnavas.telegram_chat_id ✅ 12.02.2026
- [x] Миграция 120: таблица telegram_link_tokens ✅ 12.02.2026
- [x] Миграция 121: CASCADE удаление для face_tags/photo_faces ✅ 12.02.2026
- [x] Миграция 122: Исправление RLS для суперпользователей ✅ 12.02.2026
- [x] Edge Function: telegram-webhook (обработка /start TOKEN, /stop, /help) ✅ 12.02.2026
- [x] Edge Function: send-notification (отправка broadcast/single через Bot API) ✅ 12.02.2026
- [x] Кнопка «Подключить уведомления» в Guest Portal (deep link с токеном) ✅ 12.02.2026
- [x] Polling обновления статуса подключения бота (каждые 3 сек) ✅ 12.02.2026
- [x] Отвязка: /stop или кнопка в Guest Portal ✅ 12.02.2026
- [x] Уведомление «Новые фото с ретрита!» после загрузки фотографом ✅ 12.02.2026
- [x] Уведомление «Нашли вас на N фото!» после успешного поиска ✅ 12.02.2026
- [x] Статус подключения бота в Guest Portal (подключен/не подключен) ✅ 12.02.2026
- [x] Исправление вызова has_permission в send-notification (правильные имена параметров) ✅ 12.02.2026
- [x] Функция current_user_has_upload_permission для Storage policies ✅ 12.02.2026
- [x] Тестирование с реальными пользователями (подключение бота, получение уведомлений)

---

## Резюме дополнительных изменений (не из ТЗ)

В процессе реализации Фазы 2 были добавлены улучшения, которых не было в исходном ТЗ:

### 1. Асинхронная индексация с прогрессом (ТЗ: "фотограф может закрыть страницу")

**Проблема:** ТЗ требовало, чтобы фотограф мог закрыть страницу во время индексации, но не было детальной спецификации UI.

**Реализовано:**
- Прогресс-бар с обновлением каждые 3 секунды (polling)
- Показывает: проиндексировано/всего, процент, количество найденных лиц
- Работает как в upload.html (после загрузки), так и в manage.html (при переиндексации)
- Автоматическое определение завершения индексации
- Переводы для всех UI-элементов прогресса (миграция 115)

**Файлы:**
- [photos/js/upload.js](photos/js/upload.js) — функции `startIndexingPolling()`, `updateIndexingProgress()`
- [photos/js/manage.js](photos/js/manage.js) — аналогичные функции + кнопка "Переиндексировать"
- [supabase/115_photos_indexing_translations.sql](supabase/115_photos_indexing_translations.sql)

### 2. Детект зависших фото

**Проблема:** При ошибках в Edge Function фото могли навсегда остаться в статусе `processing`.

**Реализовано:**
- Детект: если количество фото в `processing` не меняется >20 секунд → автосброс в `pending`
- UPDATE policy для retreat_photos (миграция 116) для возможности клиентского сброса статуса
- Логирование в консоль для отладки

**Файлы:**
- [photos/js/manage.js:524-556](photos/js/manage.js) — логика детекта зависших фото
- [supabase/116_retreat_photos_update_policy.sql](supabase/116_retreat_photos_update_policy.sql)

### 3. Realtime обновления статусов фото

**Проблема:** При работе нескольких вкладок или пользователей статусы фото не синхронизировались.

**Реализовано:**
- Supabase Realtime подписка на таблицу `retreat_photos`
- Автоматическое обновление карточек фото и счётчиков при изменении статуса
- Обновление только изменённых карточек (не полный рендер) для производительности
- Включение Realtime для таблицы (миграция 117)

**Файлы:**
- [photos/js/manage.js:143-238](photos/js/manage.js) — Realtime подписка и обработка событий
- [supabase/117_enable_realtime_retreat_photos.sql](supabase/117_enable_realtime_retreat_photos.sql)

### 4. Клиентская компрессия фото >5MB

**Проблема:** ТЗ говорило "фото ~10 МБ", но Edge Function имела проблемы с памятью при обработке больших фото (Memory limit exceeded).

**Реализовано:**
- Автоматическая компрессия фото >5MB перед загрузкой (Canvas API)
- Ресайз до максимум 2048px по большей стороне
- Конвертация в JPEG с качеством 85%
- Лимит загрузки увеличен до 50MB (с учётом компрессии)

**Файлы:**
- [photos/js/upload.js:compressImageIfNeeded()](photos/js/upload.js) — функция компрессии
- Интегрировано в `uploadSingleFile()` перед отправкой в Storage

### 5. Удаление старых photo_faces при переиндексации

**Проблема:** При переиндексации AWS Rekognition возвращал те же `face_id`, что вызывало ошибку duplicate key constraint.

**Реализовано:**
- Удаление всех записей `photo_faces` для фото перед вставкой новых
- Предотвращает duplicate key violations
- Гарантирует актуальность данных после переиндексации

**Файлы:**
- [supabase/functions/index-faces/index.ts:230-237](supabase/functions/index-faces/index.ts) — DELETE перед INSERT

### 6. Удаление imagescript из Edge Functions

**Проблема:** Библиотека imagescript загружала полные изображения в память, превышая лимит 150MB Edge Function.

**Реализовано:**
- Удалена imagescript из index-faces и search-face
- Прямая передача байтов изображения в Rekognition без ресайза на сервере
- Вместо серверного ресайза — клиентская компрессия (см. п.4)
- Проверка размера файла <15MB (лимит AWS Rekognition)

**Файлы:**
- [supabase/functions/index-faces/index.ts](supabase/functions/index-faces/index.ts)
- [supabase/functions/search-face/index.ts](supabase/functions/search-face/index.ts)

### 7. Изменение батча с 50 на 20 фото

**Проблема:** Батчи по 50 фото приводили к таймаутам Edge Function.

**Реализовано:**
- Уменьшен размер батча до 20 фото
- Более надёжная обработка с запасом по таймауту
- Обновлена документация в ТЗ

### 8. Fallback на vaishnavas.photo_url в search-face

**Проблема:** У некоторых гостей нет загруженного фото в vaishnava-photos bucket.

**Реализовано:**
- При отсутствии фото в Storage — fallback на поле `vaishnavas.photo_url` (внешняя ссылка)
- Более гибкий механизм поиска фото профиля

**Файлы:**
- [supabase/functions/search-face/index.ts](supabase/functions/search-face/index.ts)

### 9. Защита от бесконечных вызовов Edge Function

**Проблема:** Если AWS Rekognition начнёт постоянно возвращать ошибки (например, неправильные credentials), polling будет продолжать вызывать Edge Function каждые 3 секунды до тех пор, пока все фото не получат статус `failed`.

**Реализовано:**
- Счётчик последовательных ошибок `edgeFunctionErrorCounter`
- Автоматическая остановка polling после 10 последовательных ошибок
- Сброс счётчика в 0 при успешном вызове
- Уведомление пользователю при остановке индексации

**Файлы:**
- [photos/js/manage.js:12,608,703-720](photos/js/manage.js) — логика счётчика ошибок
- [photos/js/upload.js:617,634,710-730](photos/js/upload.js) — аналогичная логика

### Итоги

Все дополнительные изменения направлены на:
- **Улучшение UX** — прогресс-бар, realtime обновления
- **Стабильность** — детект зависших фото, удаление дубликатов, retry
- **Производительность** — клиентская компрессия, оптимизация батчей
- **Надёжность** — fallback механизмы, детальное логирование

Ни одно изменение не противоречит исходному ТЗ, а лишь дополняет и улучшает его.

---

## Резюме дополнительных изменений Фазы 3 (не из исходного ТЗ)

### 1. Polling обновления статуса подключения бота

**Проблема:** ТЗ не уточняло, как Guest Portal узнает, что бот подключён (токен использован).

**Реализовано:**
- Polling каждые 3 секунды после показа deep link
- Проверка `telegram_link_tokens.used = true` и `vaishnavas.telegram_chat_id != null`
- Автоматическое обновление UI: "Подключён ✓" без перезагрузки страницы
- Остановка polling через 5 минут (макс. 100 запросов)

**Файлы:**
- [guest-portal/js/portal-index.js:connectTelegram(), checkTokenStatus()](guest-portal/js/portal-index.js)

### 2. Миграция 121: CASCADE удаление для photo_faces/face_tags

**Проблема:** При удалении фото возникала ошибка FK constraint violation.

**Реализовано:**
- `ON DELETE CASCADE` для `face_tags.photo_id → retreat_photos.id`
- `ON DELETE CASCADE` для `photo_faces.photo_id → retreat_photos.id`
- Автоматическое удаление связанных записей при удалении фото

**Файлы:**
- [supabase/121_fix_photo_cascade_delete.sql](supabase/121_fix_photo_cascade_delete.sql)

### 3. Миграция 122: Поддержка суперпользователей для фотографа

**Проблема:** Суперпользователи не могли загружать/удалять фото, т.к. RLS политики проверяли только явное право `upload_photos` через роли.

**Реализовано:**
- Функция `current_user_has_upload_permission()` для Storage policies
- Пересоздание RLS политик `retreat_photos_insert/delete` с использованием `has_permission(auth.uid(), 'upload_photos')`
- Пересоздание Storage политик для bucket `retreat-photos` с использованием `current_user_has_upload_permission()`
- Функция `has_permission` автоматически даёт все права суперпользователям (проверка `is_superuser`)

**Файлы:**
- [supabase/122_fix_retreat_photos_rls_for_superusers.sql](supabase/122_fix_retreat_photos_rls_for_superusers.sql)
- [supabase/functions/send-notification/index.ts:191-194](supabase/functions/send-notification/index.ts) — исправлены имена параметров RPC

### 4. Retry механизм для отправки уведомлений

**Проблема:** ТЗ не уточняло, как обрабатывать ошибки Telegram API (rate limit, timeout).

**Реализовано:**
- Exponential backoff retry (3 попытки, базовая задержка 1 сек)
- Обработка 403 (бот заблокирован) → очистка `telegram_chat_id`
- Обработка 429 (rate limit) → retry с задержкой `retry_after`
- Rate limiting для broadcast: 25 сообщений/сек (батчами, пауза 1 сек между батчами)

**Файлы:**
- [supabase/functions/send-notification/index.ts:sendMessage(), broadcastToSubscribers()](supabase/functions/send-notification/index.ts)
- [supabase/functions/telegram-webhook/index.ts:sendWithRetry()](supabase/functions/telegram-webhook/index.ts)

### 5. Проверка прав для broadcast уведомлений

**Проблема:** ТЗ не уточняло, кто может отправлять broadcast уведомления.

**Реализовано:**
- Проверка права `upload_photos` для broadcast типа уведомлений
- Service role (вызовы из Edge Functions) обходят проверку
- Функция `has_permission` учитывает суперпользователей

**Файлы:**
- [supabase/functions/send-notification/index.ts:186-205](supabase/functions/send-notification/index.ts)

### 6. Fallback на profile photo для "Найти себя"

**Проблема:** ТЗ требовало fallback на селфи, но не уточняло, нужен ли приоритет для существующего фото профиля.

**Реализовано:**
- Проверка `vaishnavas.photo_url` перед открытием file picker
- Если фото профиля есть → автоматическое использование для поиска
- Если нет → предложение загрузить селфи
- Функция `searchFaceByUrl()` для прямого поиска по URL

**Файлы:**
- [guest-portal/photos.html:findMyPhotos(), searchFaceByUrl()](guest-portal/photos.html)

### 7. Команды /help для бота

**Проблема:** ТЗ не описывало команду `/help`.

**Реализовано:**
- Команда `/help` с описанием бота и его возможностей
- Markdown-форматирование сообщения
- Ссылка на поддержку

**Файлы:**
- [supabase/functions/telegram-webhook/index.ts:handleHelp()](supabase/functions/telegram-webhook/index.ts)

---

## Открытые вопросы к заказчику

1. ~~**Объёмы фото**~~ ✅ 100 чел, 700 фото/ретрит, 10 ретритов/год
2. ~~**Бюджет на AI**~~ ✅ ~$8/год — копейки (Rekognition Collections)
3. ~~**Email-провайдер**~~ ✅ Telegram бот (90% гостей в ТГ, бесплатно, без проблем с .ru доменами)
4. ~~**Фотограф**~~ ✅ Отдельная роль (новая permission: `upload_photos`)
5. ~~**Качество фото**~~ ✅ JPEG ~10 МБ с камеры
6. ~~**Хранение**~~ ✅ Supabase Storage (входит в Pro, первый год $0)
7. ~~**Срок хранения**~~ ✅ Вечно (через 5 лет +$4.6/мес, через 10 лет +$9.7/мес)

### Уточнения по Фазе 3 (Telegram уведомления)

8. **Нужно ли уведомление "Нашли вас на N фото"?**

   **Контекст:** Сейчас реализовано уведомление после успешного поиска лица через кнопку "Найти себя" в Guest Portal. Пользователь САМ инициирует поиск, видит результат МГНОВЕННО на странице (1-2 секунды), И получает Telegram-уведомление.

   **Вопрос:** Имеет ли смысл дублировать информацию в Telegram, если пользователь уже видит результат в браузере? Или уведомление нужно для напоминания "зайди посмотри потом"?

   **Варианты:**
   - A) Убрать уведомление (пользователь и так видит результат сразу)
   - B) Оставить как есть (напоминание в мессенджере полезно)
   - C) Сделать опциональным (настройка в Guest Portal: "Уведомлять о найденных фото")

   **Рекомендация:** Вариант A — убрать уведомление. Поиск мгновенный, пользователь сам инициирует действие и видит результат. Telegram уведомление имеет смысл только для АСИНХРОННЫХ событий (новые фото загрузил фотограф), а не для синхронных действий пользователя.
