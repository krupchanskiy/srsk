---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, security, edge-function, search-face]
dependencies: []
---

# P2: search-face — не валидирует, что vaishnava_id принадлежит текущему пользователю

## Problem Statement

`search-face` Edge Function проверяет JWT, но не проверяет, что переданный `vaishnava_id` совпадает с профилем аутентифицированного пользователя. Авторизованный пользователь A может запустить поиск лица для пользователя B, получив его совпадения по Rekognition.

## Findings

`supabase/functions/search-face/index.ts`:
```typescript
const { vaishnava_id } = await req.json();
// Нет проверки: принадлежит ли vaishnava_id текущему auth.uid()?

// Далее — AWS Rekognition SearchFacesByImage для любого vaishnava_id
```

Также: хардкоженный prod URL в уведомлении:
```typescript
const message = `... https://in.rupaseva.com/guest-portal/photos.html`;
// Всегда prod, даже в dev-окружении
```
(этот пункт уже покрыт issue-008)

## Proposed Solutions

### Вариант A — Проверить принадлежность через БД
```typescript
// После валидации JWT:
const { data: vaishnava } = await supabase
  .from('vaishnavas')
  .select('id')
  .eq('id', vaishnava_id)
  .eq('user_id', user.id)
  .single();

if (!vaishnava) return json({ error: 'Forbidden' }, 403);
```

### Вариант B — Брать vaishnava_id из профиля пользователя, не из тела запроса
Не принимать `vaishnava_id` из запроса вовсе — определять по `user_id` из JWT.

## Acceptance Criteria
- [ ] Пользователь не может запустить поиск лица для чужого vaishnava_id
- [ ] Возвращается 403 при несоответствии

## Work Log
- 2026-02-13: Найдено в ревью ветки develop (security-sentinel)
