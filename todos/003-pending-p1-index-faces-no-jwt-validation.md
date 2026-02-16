---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, security, edge-function, aws]
dependencies: []
---

# P1: index-faces не валидирует JWT — любой запрос проходит авторизацию

## Problem Statement

Edge Function `index-faces` проверяет только **наличие** заголовка Authorization, но не валидирует токен. Любой, кто знает URL функции, может запустить индексацию лиц через AWS Rekognition.

## Findings

`supabase/functions/index-faces/index.ts:88-91`:
```typescript
// Verify authorization header exists (but we don't validate it, just check presence)
const authHeader = req.headers.get("authorization");
if (!authHeader) {
  return json({ error: "Missing authorization header" }, 401);
}
```

Комментарий в коде прямо признаёт проблему. Для сравнения `delete-photos` корректно валидирует:
- `supabase.auth.getUser(token)` — проверка токена
- `supabase.rpc('has_permission', { perm_code: 'upload_photos' })` — проверка права

**Последствия**: трата квоты AWS Rekognition, DoS индексации, захват фото в статус `processing`.

## Proposed Solutions

### Вариант A — Скопировать паттерн из delete-photos (Рекомендуется)
```typescript
const token = authHeader.replace('Bearer ', '');
const { data: { user }, error: userError } = await supabase.auth.getUser(token);
if (userError || !user) return json({ error: 'Invalid token' }, 401);

const { data: hasPermission } = await supabase.rpc('has_permission', {
  perm_code: 'upload_photos', user_uuid: user.id
});
if (!hasPermission) return json({ error: 'No permission' }, 403);
```
Pros: консистентно с delete-photos. Cons: +1 RTT на каждый вызов.

## Acceptance Criteria
- [ ] Запрос с фейковым токеном возвращает 401
- [ ] Запрос без права upload_photos возвращает 403
- [ ] Деплой функции в prod

## Work Log
- 2026-02-13: Найдено в ревью ветки develop (security-sentinel)
