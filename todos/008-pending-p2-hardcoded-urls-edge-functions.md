---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, architecture, edge-function, configuration]
dependencies: []
---

# P2: Захардкоженные URL и project_id в Edge Functions

## Problem Statement

`index-faces` определяет окружение через `SUPABASE_URL.includes('vzuiwpeovnzfokekdetq')` (dev project ID), `search-face` безусловно указывает на production URL. Dev-уведомления Telegram ведут на prod-домен.

## Findings

`supabase/functions/index-faces/index.ts:332-334`:
```typescript
const baseUrl = SUPABASE_URL.includes('vzuiwpeovnzfokekdetq')
    ? 'https://dev.rupaseva.com'
    : 'https://in.rupaseva.com';
```

`supabase/functions/search-face/index.ts:62`:
```typescript
const message = `... https://in.rupaseva.com/guest-portal/photos.html`;
// Всегда prod, даже в dev-окружении
```

`send-invite` корректно использует `Deno.env.get('SITE_URL')` — этот паттерн не применён везде.

## Proposed Solutions

### Вариант A — SITE_URL секрет (Рекомендуется)
```bash
supabase secrets set SITE_URL=https://in.rupaseva.com --project-ref llttmftapmwebidgevmg
supabase secrets set SITE_URL=https://dev.rupaseva.com --project-ref vzuiwpeovnzfokekdetq
```
В коде: `const baseUrl = Deno.env.get('SITE_URL') || 'https://in.rupaseva.com';`

## Acceptance Criteria
- [ ] Telegram-уведомления из dev указывают на dev-домен
- [ ] Нет захардкоженных project_id в TypeScript
- [ ] Деплой обеих функций в оба проекта

## Work Log
- 2026-02-13: Найдено в ревью ветки develop (security-sentinel, architecture-strategist)
