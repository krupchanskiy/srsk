# Оценка: Photo Gallery & Face Search

**Задача**: Photo Gallery & Face Search — Business Logic (Short)
**Дата оценки**: 2026-02-08
**Режим**: Human + Claude
**Ограничение**: исполнитель тратит не более 3 ч/день
**Методика**: скилл `~/.claude/skills/estimation/SKILL.md` (категории A/B/C/D + формула с overhead 20%)

---

## Исходные оценки (из документа, обычный dev)

| Фаза | Часы (документ) |
|------|----------------|
| Фаза 1 — Галерея (без AI) | 11–15 |
| Фаза 2 — Распознавание лиц | 10–14 |
| Фаза 3 — Telegram | 8–12 |
| **Итого** | **29–41** |

---

## Переоценка: Human + Claude

### Контекст проекта (влияет на мультипликаторы)

**Факторы вверх** (ближе к верхней границе мультипликатора):

- Стек (Supabase + Vanilla JS + DaisyUI) хорошо документирован
- AWS Rekognition SDK уже подключен, IAM user и ключи настроены
- Устоявшиеся паттерны в проекте (Layout.db, Layout.init, RLS)
- Telegram Bot API — стандартная документация

**Факторы вниз** (ближе к нижней границе):

- Интеграционное тестирование (реальные фото, AWS, Telegram) — нельзя ускорить
- Storage bucket — ручная конфигурация в Dashboard

---

### Фаза 1 — Галерея (без AI)

| Задача | Тип | Обычная | Кат. | Мульт | Human+Claude (с +20% overhead) | Обоснование |
|--------|-----|---------|------|-------|-------------------------------|-------------|
| DB структура (photos, связи, RLS) | DB | 1.5 ч | A | 5x | **0.4 ч** | Миграция SQL — Claude генерирует за минуты |
| Storage bucket + конвенция путей | DevOps | 1.5 ч | D | 1x | **1.5 ч** | Ручная настройка в Supabase Dashboard |
| Загрузка фото (UI + Edge Function + валидация) | Frontend+Backend | 4.5 ч | B | 4x | **1.3 ч** | Стандартный upload, но нужно проверить реально |
| Просмотр галереи (grid + фильтр по ретриту) | Frontend | 3.5 ч | A | 6x | **0.7 ч** | DaisyUI grid — чистый бойлерплейт |
| Удаление фото (UI + права + Storage cleanup) | Full-stack | 2 ч | A | 5x | **0.5 ч** | CRUD + RLS, паттерн проекта |
| **Итого Фаза 1** | | **13 ч** | | | **4.4 ч** | **Мульт: ~3x** |

### Фаза 2 — Распознавание лиц (AI)

| Задача | Тип | Обычная | Кат. | Мульт | Human+Claude (с +20% overhead) | Обоснование |
|--------|-----|---------|------|-------|-------------------------------|-------------|
| AWS Rekognition Edge Function wrapper | Backend | 2.5 ч | B | 4x | **0.8 ч** | SDK подключен, ключи есть |
| Коллекции retreat_{id} (create/check) | Backend | 1.5 ч | A | 6x | **0.3 ч** | Тривиальная логика |
| IndexFaces (батчи по 20, retry, backoff, статусы) | Backend | 3.5 ч | B | 3x | **1.4 ч** | Нетривиальный error handling, нужно тестить |
| SearchFacesByImage (UI загрузки + результаты) | Full-stack | 3.5 ч | B | 3.5x | **1.2 ч** | Frontend + Edge Function + отображение |
| face_tags upsert + миграция | DB+Backend | 1.5 ч | A | 5x | **0.4 ч** | Одна миграция, простой upsert |
| **Итого Фаза 2** | | **12.5 ч** | | | **4.1 ч** | **Мульт: ~3x** |

### Фаза 3 — Telegram

| Задача | Тип | Обычная | Кат. | Мульт | Human+Claude (с +20% overhead) | Обоснование |
|--------|-----|---------|------|-------|-------------------------------|-------------|
| Бот + webhook (BotFather + Edge Function) | Backend+DevOps | 2.5 ч | B | 4x | **0.8 ч** | Telegram Bot API хорошо документирован |
| /start TOKEN (генерация, валидация, привязка, edge cases) | Backend | 3.5 ч | B | 3x | **1.4 ч** | Сложный flow, идемпотентность, expiry |
| /stop отписка | Backend | 1.5 ч | A | 6x | **0.3 ч** | Тривиально: is_active = false |
| Уведомления о найденных фото | Backend | 2.5 ч | B | 3.5x | **0.9 ч** | Шаблон + интеграция + throttling |
| Обработка ошибок + защита | Backend | 1.5 ч | C | 2x | **0.9 ч** | Ручное тестирование edge cases обязательно |
| **Итого Фаза 3** | | **11.5 ч** | | | **4.3 ч** | **Мульт: ~2.7x** |

---

## Сводка

| | Обычная команда | Human + Claude | Мультипликатор |
|--|----------------|---------------|---------------|
| Фаза 1 — Галерея | 13 ч | 4.4 ч | 3.0x |
| Фаза 2 — Face Recognition | 12.5 ч | 4.1 ч | 3.0x |
| Фаза 3 — Telegram | 11.5 ч | 4.3 ч | 2.7x |
| **Итого трудозатраты** | **37 ч** | **12.8 ч** | **~2.9x** |

### Календарные сроки (при 3 ч/день)

| | Обычная команда | Human + Claude |
|--|----------------|---------------|
| Фаза 1 | 4–5 дней | 1.5 дня |
| Фаза 2 | 4–5 дней | 1.5 дня |
| Фаза 3 | 3–4 дня | 1.5 дня |
| **Итого** | **12–13 дней** | **~4.5 дня** |

---

## Допущения

1. Исполнитель знаком со стеком проекта (Supabase, Vanilla JS, DaisyUI)
2. AWS Rekognition SDK и ключи уже настроены
3. Доступы к Supabase, AWS, Telegram BotFather получены заранее
4. Требования зафиксированы, scope не меняется
5. Code review не требуется от третьих лиц

## Что НЕ входит в оценку

- Общение с заказчиком и уточнение требований
- Ожидание доступов и ключей от внешних сервисов
- Ревью от других членов команды
- Дизайн UI (предполагается что используется существующий стиль проекта)

## Риски

| Риск | Влияние | Митигация |
|------|---------|-----------|
| Лимиты AWS Rekognition (free tier) | Может потребоваться оплата | Проверить лимиты заранее |
| Telegram rate limits | Задержки при массовых уведомлениях | Очередь + throttling |
| Большие фото (>5MB) | Медленная загрузка, ошибки resize | Клиентский resize перед upload |
| Неточное распознавание | Жалобы пользователей | Порог confidence + UI "это не я" |

---

## Источники методики

- [METR: AI Impact on Developer Productivity (2025)](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- [ISBSG: AI-Assisted Development Productivity (2026)](https://www.isbsg.org/wp-content/uploads/2026/02/Short-Paper-2026-02-Impact-of-AI-Assisted-Development-on-Productivity-and-Delivery-Speed.pdf)
- [AWS: Measuring Impact of AI Assistants](https://aws.amazon.com/blogs/enterprise-strategy/measuring-the-impact-of-ai-assistants-on-software-development/)
- [New Rules for Estimating in AI Era (Medium)](https://toashishagarwal.medium.com/new-rules-for-estimating-software-development-time-in-ai-era-460ec5347e1a)
