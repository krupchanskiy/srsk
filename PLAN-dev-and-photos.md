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
| **Система** | Распознаёт лицо, отмечает фото, уведомляет по email |

**User Flow:**

```
Фотограф:
1. Заходит в admin → Фото ретрита
2. Выбирает ретрит
3. Загружает пачку фото (drag & drop или выбор файлов)
4. Фото сохраняются в Storage, привязываются к ретриту
5. Edge Function автоматически индексирует лица через Rekognition
→ Email гостям: "Новые фото с ретрита!"

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
  caption TEXT                         -- подпись (опционально)
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
| Email (Resend free tier, 3K/мес) | $0 |
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

```
Фотограф загружает 100 фото за день
  → Каждое фото сохраняется в Storage
  → Edge Function index-faces:
    → Rekognition.IndexFaces(collection=retreat_{id}, image=photo)
    → Сохранить face_id в БД (retreat_photos.rekognition_face_ids)
  → Индексация 100 фото: ~50 сек (укладывается в таймаут)
  → Можно разбить на батчи по 50 если загрузка >100 фото за раз
```

**Поток 2: Поиск (по запросу гостя, мгновенный)**

```
Гость нажимает «Найти себя»
  → Edge Function search-face:
    → Rekognition.SearchFacesByImage(collection=retreat_{id}, image=profile_photo)
    → Получает список face_id совпадений (за 1-2 секунды!)
    → По face_id находит photo_id в БД
    → INSERT в face_tags (все совпадения)
    → Возвращает результат СРАЗУ (без очереди!)
  → Гость видит отмеченные фото мгновенно
```

**Очередь НЕ НУЖНА** — SearchFaces возвращает результат за 1-2 секунды.

### Email-уведомления

Нужен email-провайдер. Варианты:

| Провайдер | Бесплатно | Цена потом |
|-----------|-----------|------------|
| **Resend** | 3000 писем/мес | $20/мес за 50K |
| **SendGrid** | 100 писем/день | $20/мес за 50K |
| **Supabase + SMTP** | Настроить свой SMTP | Зависит от провайдера |

**Типы писем:**

1. «Новые фото с ретрита!» — при загрузке фотографом
2. «Мы нашли вас на N фотографиях!» — после распознавания
3. «Ваш запрос в очереди» — подтверждение (опционально)

### Страницы (новые/изменённые)

**Admin (для фотографа):**

- `photos/upload.html` — batch upload фото на ретрит (drag & drop, множественная загрузка)
- `photos/manage.html` — управление фото (удаление, подписи)

**Guest Portal (для гостя):**

- `guest-portal/photos.html` — галерея фото ретрита
  - Все фото (по дням)
  - Фильтр «Фото со мной» (после распознавания)
  - Кнопка «Найти себя»
  - Статус очереди
  - Скачивание фото

### Зависимости

```
Dev-окружение ← БЛОКИРУЕТ → Фотогалерея
                              (разрабатывать фотогалерею лучше на dev)

Фотогалерея зависит от:
├── Supabase Storage bucket (retreat-photos) ← создать
├── Таблицы БД (retreat_photos, face_tags, face_search_log) ← миграции
├── Edge Function: index-faces (при загрузке) ← написать
├── Edge Function: search-face (при поиске) ← написать
├── AWS аккаунт + Rekognition доступ ← настроить
├── Email-провайдер (Resend) ← настроить
└── Фото профиля у гостей ← уже есть (vaishnava-photos bucket)
```

---

## Общий план по фазам

### Фаза 0: Dev-окружение (2-3 часа)

- [ ] Автоопределение окружения в config.js
- [ ] Ветка dev
- [ ] Vercel подключение
- [ ] DNS dev.rupaseva.com
- [ ] Проверка: dev Supabase работает через Vercel

### Фаза 1: Фотогалерея БЕЗ AI (3-5 дней)

- [ ] Роль «Фотограф» (permission `upload_photos` в таблице permissions)
- [ ] Миграции БД (retreat_photos)
- [ ] Supabase Storage bucket `retreat-photos` + RLS
- [ ] Admin: страница загрузки фото (доступна с permission `upload_photos`)
- [ ] Guest Portal: галерея фото ретрита
- [ ] Thumbnails через CDN Image Transforms (без генерации, Pro фича)
- [ ] Скачивание фото

### Фаза 2: AI Face Recognition (2-4 дня)

- [ ] AWS аккаунт + Rekognition доступ
- [ ] Миграции БД (face_tags, face_search_log)
- [ ] Edge Function: index-faces (индексация при загрузке)
- [ ] Edge Function: search-face (поиск по запросу гостя)
- [ ] Кнопка «Найти себя» в Guest Portal (мгновенный результат)
- [ ] Фильтр «Фото со мной»
- [ ] Тестирование с реальными фото

### Фаза 3: Email-уведомления (1-2 дня)

- [ ] Выбор email-провайдера
- [ ] Edge Function: отправка email
- [ ] Шаблоны писем (2 типа)
- [ ] Настройка в Guest Portal (отписка)

---

## Открытые вопросы к заказчику

1. ~~**Объёмы фото**~~ ✅ 100 чел, 700 фото/ретрит, 10 ретритов/год
2. ~~**Бюджет на AI**~~ ✅ ~$8/год — копейки (Rekognition Collections)
3. **Email-провайдер** — Resend (рекомендую, 3K писем/мес бесплатно)?
4. ~~**Фотограф**~~ ✅ Отдельная роль (новая permission: `upload_photos`)
5. ~~**Качество фото**~~ ✅ JPEG ~10 МБ с камеры
6. ~~**Хранение**~~ ✅ Supabase Storage (входит в Pro, первый год $0)
7. ~~**Срок хранения**~~ ✅ Вечно (через 5 лет +$4.6/мес, через 10 лет +$9.7/мес)
