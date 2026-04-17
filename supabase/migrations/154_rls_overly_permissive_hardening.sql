-- DB-S-01..06: ужесточение RLS-политик с USING (true) / WITH CHECK (true).
--
-- Проблема (из security advisors):
--   crm_deal_members:       "Authenticated manage deal members"  USING/CHECK = true, ALL
--   crm_utm_links:          "Authenticated manage utm links"     USING/CHECK = true, ALL
--   crm_deals:              "anon_insert_crm_deals"              WITH CHECK = true
--   crm_deal_services:      "anon_insert_crm_deal_services"      WITH CHECK = true
--   vaishnavas:             "anon_insert_vaishnavas"              WITH CHECK = true
--
-- Реальные векторы атаки (до миграции):
--   1. Любой залогиненный юзер (даже гость портала) мог читать/писать
--      все UTM-ссылки и связи участников сделок.
--   2. Анонимный клиент через лид-форму мог создать crm_deal со
--      status='paid' + total_paid=1000000 — фейковые платежи.
--   3. Анон мог создать vaishnava с is_superuser=true — эскалация привилегий.
--
-- Решение: заменяем USING/CHECK (true) на реальные проверки.

BEGIN;

-- crm_deal_members: только staff
DROP POLICY "Authenticated manage deal members" ON public.crm_deal_members;
CREATE POLICY "Staff manage crm_deal_members" ON public.crm_deal_members
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

-- crm_utm_links: только staff
DROP POLICY "Authenticated manage utm links" ON public.crm_utm_links;
CREATE POLICY "Staff manage crm_utm_links" ON public.crm_utm_links
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

-- crm_deals: анон-лид может создать только lead без платежа
DROP POLICY anon_insert_crm_deals ON public.crm_deals;
CREATE POLICY anon_insert_crm_deals ON public.crm_deals
  AS PERMISSIVE FOR INSERT TO anon
  WITH CHECK (
    COALESCE(status, 'lead') = 'lead'
    AND COALESCE(total_paid, 0) = 0
  );

-- crm_deal_services: вообще не нужна анон-политика
-- (используется только из crm/deal.html и crm/deals.html — staff-страницы).
-- "Staff manage crm_deal_services" уже есть и даёт нужный доступ.
DROP POLICY anon_insert_crm_deal_services ON public.crm_deal_services;

-- vaishnavas: анон-лид создаёт только обычного гостя без привилегий
DROP POLICY anon_insert_vaishnavas ON public.vaishnavas;
CREATE POLICY anon_insert_vaishnavas ON public.vaishnavas
  AS PERMISSIVE FOR INSERT TO anon
  WITH CHECK (
    COALESCE(is_superuser, false) = false
    AND COALESCE(is_team_member, false) = false
    AND COALESCE(user_type, 'guest') = 'guest'
    AND user_id IS NULL
    AND COALESCE(is_deleted, false) = false
  );

COMMIT;
