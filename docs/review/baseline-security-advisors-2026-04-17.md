# Baseline Security Advisors — 2026-04-17

Снято через `mcp__supabase__get_advisors(project_id=mymrijdfqeevoaocbzfy, type=security)` до начала ревью. Все находки уровня **WARN**, ERRORов нет.

## 1. RLS Policy Always True — 6 находок (САМОЕ ОПАСНОЕ)

Политики с `USING (true)` / `WITH CHECK (true)` для неSELECT операций — фактически отключают RLS.

| Таблица | Политика | Роль | Операция | Риск |
|---|---|---|---|---|
| `crm_deal_members` | `Authenticated manage deal members` | authenticated | ALL | **HIGH** — любой залогиненный юзер читает/пишет все связи |
| `crm_utm_links` | `Authenticated manage utm links` | authenticated | ALL | **HIGH** — то же самое для UTM |
| `crm_deals` | `anon_insert_crm_deals` | anon | INSERT | **MEDIUM** — скорее всего интенционально (лид-форма), но надо подтвердить |
| `crm_deal_services` | `anon_insert_crm_deal_services` | anon | INSERT | **MEDIUM** — тоже лид-форма? |
| `crm_manager_queue` | `anon_update_crm_manager_queue` | anon | UPDATE | **HIGH** — анон может менять очередь менеджеров, это подозрительно |
| `vaishnavas` | `anon_insert_vaishnavas` | anon | INSERT | **MEDIUM** — guest-signup? надо подтвердить |

## 2. Function Search Path Mutable — 10 находок

Функции без зафиксированного `search_path` (WARN, низкий риск):
- `update_deal_total_paid`
- `update_plants_updated_at`
- `is_plant_user`
- `fn_crm_log_placement_delete`
- `link_auth_user_to_plant_user`
- `notify_crm_new_deal`
- `fn_crm_log_deal_booking_linked`
- `sync_deal_currency`
- `crm_auto_tasks`
- `create_guest_account`

Фикс: `ALTER FUNCTION <name> SET search_path = public, pg_temp;`

## 3. Public Bucket Allows Listing — 6 бакетов

Публичные бакеты с `SELECT` политикой, позволяющей листить все файлы:
- `floor-plans`
- `guest-photos`
- `plants`
- `recipe-photos`
- `retreat-images`
- `vaishnava-photos`

Риск: можно получить список всех файлов без знания их имён. Для доступа по URL листинг не нужен — политику SELECT можно сузить до `USING (false)` при публичном `public = true` бакете.

## 4. Auth Leaked Password Protection Disabled — 1

Отключена проверка паролей через HaveIBeenPwned. Включить в `Authentication → Policies`.

---

## Сводка

| Level | Количество |
|---|---|
| ERROR | 0 |
| WARN | 23 |

Baseline для сравнения после фиксов.
