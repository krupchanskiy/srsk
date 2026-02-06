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
            || window.location.hostname.includes('netlify.app')
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
4. Открываешь PR в dev → Netlify создаёт preview URL
5. Проверяешь на preview URL (с dev Supabase)
6. Мержишь в dev → dev.rupaseva.com обновляется
7. Тестируешь на dev.rupaseva.com
8. Создаёшь PR из dev → main
9. Мержишь → GitHub Pages деплоит на in.rupaseva.com
```

**6. Vercel cron для очереди распознавания (добавить в Фазе 2)**

```json
// vercel.json
{
  "crons": [{
    "path": "/api/process-face-queue",
    "schedule": "* * * * *"
  }]
}
```

Vercel cron будет дёргать Supabase Edge Function для обработки очереди.

### Оценка: 2-3 часа на всё

---

## Часть 2: Фотогалерея с AI-поиском лиц

### Бизнес-логика

**Акторы:**

| Роль | Действия |
|------|----------|
| **Фотограф** | Загружает фото с ретрита (batch upload) |
| **Гость** | Просматривает ВСЕ фото ретрита, нажимает «Найти себя» |
| **Система** | Распознаёт лицо, отмечает фото, уведомляет по email |

**User Flow:**

```
Фотограф:
1. Заходит в admin → Фото ретрита
2. Выбирает ретрит
3. Загружает пачку фото (drag & drop или выбор файлов)
4. Фото сохраняются в Storage, привязываются к ретриту
→ Email гостям: "Новые фото с ретрита!"

Гость:
1. Открывает Guest Portal → Фото
2. Видит ВСЕ фото текущего/прошлого ретрита (галерея)
3. Может листать, увеличивать, скачивать
4. Нажимает «Найти себя»
5. Система ставит задачу в очередь
6. Гость видит: "Идёт поиск... Мы уведомим вас по email"
7. Edge Function распознаёт лицо на фото ретрита
8. Email: "Мы нашли вас на N фотографиях!"
9. В галерее — фильтр «Фото со мной» (отмеченные фото подсвечены)
```

### Допущения (нужно уточнить с заказчиком)

- ~100-150 гостей на ретрит
- ~200-500 фото на ретрит (фотограф загружает ежедневно)
- Конверсия «Найти себя» — ~50% гостей
- Фотограф загружает 1 раз в день

### Архитектура

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ Фотограф    │────→│ Supabase     │     │ Guest Portal    │
│ (Admin UI)  │     │ Storage      │←────│ (Галерея)       │
│ Batch upload│     │ retreat-photos│     │ Просмотр + поиск│
└─────────────┘     └──────┬───────┘     └────────┬────────┘
                           │                       │
                           ▼                       ▼
                    ┌──────────────┐     ┌─────────────────┐
                    │ PostgreSQL   │     │ «Найти себя»    │
                    │ retreat_photos│     │ Задача в очередь│
                    │ face_tags    │     └────────┬────────┘
                    └──────────────┘              │
                                                  ▼
                                        ┌─────────────────┐
                                        │ Edge Function    │
                                        │ face-recognition │
                                        │                 │
                                        │ 1. Берёт фото   │
                                        │    профиля гостя │
                                        │ 2. Ищет на фото  │
                                        │    ретрита       │
                                        │ 3. Сохраняет     │
                                        │    совпадения    │
                                        │ 4. Email гостю   │
                                        └─────────────────┘
```

### Таблицы БД (новые)

```sql
-- Фото ретрита
CREATE TABLE retreat_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retreat_id UUID REFERENCES retreats(id) NOT NULL,
  storage_path TEXT NOT NULL,          -- путь в Supabase Storage
  thumbnail_path TEXT,                 -- уменьшенная версия
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

-- Очередь задач распознавания
CREATE TABLE face_recognition_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vaishnava_id UUID REFERENCES vaishnavas(id) NOT NULL,
  retreat_id UUID REFERENCES retreats(id) NOT NULL,
  status TEXT DEFAULT 'pending',       -- pending | processing | completed | failed
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  photos_processed INT DEFAULT 0,
  photos_matched INT DEFAULT 0,
  error_message TEXT
);
```

### AI-сервис для распознавания лиц

**Варианты:**

| Сервис | Цена | Качество | Интеграция |
|--------|------|----------|------------|
| **Amazon Rekognition** | $1 за 1000 фото | Отличное | REST API |
| **Google Cloud Vision** | $1.50 за 1000 фото | Отличное | REST API |
| **Azure Face API** | $1 за 1000 операций | Отличное | REST API |
| **InsightFace (self-hosted)** | Бесплатно | Хорошее | Нужен сервер |
| **OpenAI Vision** | ~$0.01 за фото | Среднее для лиц | Простой API |

**Рекомендация:** Amazon Rekognition или Google Cloud Vision — лучшее соотношение цена/качество для face matching.

**Примерная стоимость (при допущениях):**

```
1 ретрит:
- 300 фото × 75 гостей (50% конверсия) = 22,500 сравнений
- Amazon Rekognition: ~$22.50 за ретрит
- Если гость жмёт повторно (новые фото): +$0.30 за запрос

В год (~6 ретритов): ~$135
```

### Edge Functions vs VPS — где крутить распознавание?

Разработчик предложил VPS. Анализ:

**Что делает наш код?**

Не крутит ML-модель. Отправляет фото во внешний API (Rekognition) и получает true/false. Это серия HTTP-запросов, а не тяжёлые вычисления.

**Реальная проблема — не нагрузка, а таймаут:**

```
300 фото × 0.5 сек (ответ Rekognition) = 150 секунд

Supabase Edge Functions: таймаут 150 сек (free) / 400 сек (pro)
Vercel Functions:        таймаут 60 сек (free) / 300 сек (pro)
```

На 300 фото — на грани. На 500 — не влезем.

**Решение: батчи (без VPS)**

Edge Function обрабатывает НЕ все фото за раз, а пачками по 50:

```
Вызов 1: фото 1-50    → результаты в БД → queue.processed = 50
Вызов 2: фото 51-100  → результаты в БД → queue.processed = 100
...
Вызов 6: фото 251-300 → результаты в БД → status = completed → email
```

**Кто вызывает батчи:**

- `pg_cron` (встроен в Supabase Pro) — каждую минуту проверяет очередь
- Или `cron-job.org` (бесплатно) — внешний cron дёргает Edge Function

**Сравнение:**

| | Edge Functions + батчи | VPS |
|---|---|---|
| Стоимость | $0 (free tier) | $5-20/мес |
| Деплой | Автоматически через Supabase | Ручной (Docker/systemd) |
| Мониторинг | Supabase Dashboard | Настраивать самим |
| Масштабирование | Автоматическое | Ручное |
| Ограничения | Таймаут 150-400 сек | Нет |

**Вердикт:** начинаем с Edge Functions + батчи. VPS нужен ТОЛЬКО если:

- Крутим свою ML-модель (InsightFace) вместо Rekognition
- >1000 фото за раз и батчи слишком медленные
- Нужен GPU для обработки

### Очередь и обработка

```
Гость нажимает «Найти себя»
  → INSERT в face_recognition_queue (status: pending)
  → Ответ: "Запрос принят, очередь: N"

Cron (каждую минуту):
  → Вызывает Edge Function face-recognition-batch
  → SELECT FROM queue WHERE status IN ('pending', 'processing')
    ORDER BY created_at LIMIT 1
  → Если pending → SET status = 'processing', started_at = now()
  → Берёт фото профиля гостя (vaishnavas.photo_url)
  → Индексирует лицо через Rekognition
  → Берёт следующие 50 необработанных фото ретрита
  → Для каждого совпадения: INSERT в face_tags
  → UPDATE queue SET photos_processed = photos_processed + 50
  → Если все фото обработаны:
    → SET status = 'completed', completed_at = now()
    → Отправить email гостю
  → Если ещё есть фото — cron подхватит на следующей минуте
```

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
├── Таблицы БД (retreat_photos, face_tags, queue) ← миграции
├── Edge Function (face-recognition) ← написать
├── AI-сервис (Rekognition/Vision) ← выбрать и настроить аккаунт
├── Email-провайдер (Resend/SendGrid) ← выбрать и настроить
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

- [ ] Миграции БД (retreat_photos)
- [ ] Supabase Storage bucket `retreat-photos`
- [ ] Admin: страница загрузки фото
- [ ] Guest Portal: галерея фото ретрита
- [ ] Thumbnail generation (resize при загрузке)
- [ ] Скачивание фото

### Фаза 2: AI Face Recognition (3-5 дней)

- [ ] Выбор AI-провайдера
- [ ] Миграции БД (face_tags, face_recognition_queue)
- [ ] Edge Function: распознавание
- [ ] Очередь задач
- [ ] Кнопка «Найти себя» в Guest Portal
- [ ] Фильтр «Фото со мной»
- [ ] Тестирование с реальными фото

### Фаза 3: Email-уведомления (1-2 дня)

- [ ] Выбор email-провайдера
- [ ] Edge Function: отправка email
- [ ] Шаблоны писем (2 типа)
- [ ] Настройка в Guest Portal (отписка)

---

## Открытые вопросы к заказчику

1. **Объёмы фото** — сколько фото на ретрит? Сколько гостей?
2. **Бюджет на AI** — ~$20-30 за ретрит, ~$135/год — ок?
3. **Email-провайдер** — Resend? SendGrid? Свой SMTP?
4. **Фотограф** — это отдельная роль в системе или существующий admin?
5. **Качество фото** — RAW, JPEG, какой размер? Нужна ли компрессия?
6. **Хранение** — Supabase Storage (250MB free, потом $0.021/GB) или S3?
7. **Сколько ретритов в год** — для расчёта стоимости хранения
