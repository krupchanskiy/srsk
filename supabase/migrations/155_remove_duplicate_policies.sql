-- Удаление избыточных/небезопасных дубликатов RLS-policies.
-- Обнаружено при аудите под admin JWT: несколько пар policies,
-- которые делают одно и то же, при этом одна из них шире другой.
--
-- Применено на prod 2026-04-17.
--
-- Performance advisors: -2 multiple_permissive_policies warnings.
-- Security: retreats anon теперь видит только is_public=true (было — всё).
--
-- ⚠️ ВАЖНО: оставшиеся архитектурные проблемы (для отдельной сессии):
--
-- 1. vaishnavas: "Users can view vaishnavas based on permissions" для
--    roles=public с условием (is_deleted=false) даёт анону PII всех гостей
--    (имя, email, phone, telegram). Причина: crm/form.html →
--    findOrCreateVaishnava ищет по phone/email. Правильный фикс —
--    перевести на SECURITY DEFINER функцию find_or_create_vaishnava(...).
--
-- 2. crm_deals "anon_read_crm_deals" (true) — анон видит все сделки.
--    Причина: crm/form.html проверяет дубль (vaishnava_id, retreat_id).
--    Правильный фикс — SECURITY DEFINER функция check_duplicate_deal(...).
--
-- 3. face_tags, photo_faces, holidays и др. с qual="true" для anon —
--    разной степени приватности. Нужен отдельный audit.

BEGIN;

-- crm_deals: полный дубликат — оба с одинаковой логикой "vaishnava_id связан с user_id"
-- Оставляем guest_read_own_crm_deals (уже с (SELECT auth.uid()) после миграции 150).
DROP POLICY "Guest read own crm_deals" ON public.crm_deals;

-- retreats: избыточная anon_read_retreats (true) перекрывает "Public read retreats".
-- После удаления anon видит только ретриты с is_public=true (черновики скрыты).
DROP POLICY anon_read_retreats ON public.retreats;

-- vaishnavas: anon_select_vaishnavas (is_deleted=false) — дубликат условия
-- из "Users can view vaishnavas based on permissions" (см. архитектурный долг выше).
DROP POLICY anon_select_vaishnavas ON public.vaishnavas;

COMMIT;
