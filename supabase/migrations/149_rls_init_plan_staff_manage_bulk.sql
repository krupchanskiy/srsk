-- PR 9 (часть 3b) — RLS initPlan: основная волна для "Staff manage X".
--
-- 65 полисий паттерна `is_staff(auth.uid())` → `is_staff((SELECT auth.uid()))`
-- через динамический DO-блок. Применено на prod 2026-04-17 порциями.
--
-- Таблицы с этим паттерном: bookings, buildings, buyers, cleaning_tasks,
-- crm_accommodation_types, crm_activity_log, crm_cancellation_reasons,
-- crm_communications, crm_currencies, crm_deal_history, crm_deal_services,
-- crm_deal_tags, crm_deals, crm_deposit_expenses, crm_final_settlements,
-- crm_manager_queue, crm_message_templates, crm_payments, crm_retreat_managers,
-- crm_retreat_prices, crm_services, crm_tags, crm_tasks, floor_plans,
-- guest_accommodations, guest_notes, guest_payments, guest_transfers,
-- guest_visas, meal_groups, menu_days, menu_dishes, menu_items, menu_meals,
-- menu_template_dishes, menu_template_meals, menu_templates, price_history,
-- product_densities, products, purchase_request_items, purchase_requests,
-- recipe_ingredients, recipes, resident_categories, residents, retreat_registrations,
-- retreats, room_cleanings, room_types, rooms, spiritual_teachers, stock,
-- stock_inventories, stock_inventory_items, stock_issuance_items, stock_issuances,
-- stock_issue_items, stock_issues, stock_receipt_items, stock_receipts,
-- stock_request_items, stock_requests, stock_transactions, team_presence,
-- translations, vaishnava_stays.
--
-- Особый случай (roles={public}, without with_check): retreat_schedule_days,
-- retreat_schedule_items — обновлены отдельно.

BEGIN;

DO $$
DECLARE
  r record;
  cnt int := 0;
BEGIN
  FOR r IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE 'Staff manage%'
      AND qual = 'is_staff(auth.uid())'
      AND with_check = 'is_staff(auth.uid())'
      AND cmd = 'ALL'
      AND roles::text = '{authenticated}'
    ORDER BY tablename
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (is_staff((SELECT auth.uid()))) WITH CHECK (is_staff((SELECT auth.uid())))',
      r.policyname, r.tablename
    );
    cnt := cnt + 1;
  END LOOP;
  RAISE NOTICE 'Updated % Staff manage policies', cnt;
END $$;

-- Особый случай: policies на retreat_schedule_days/items — roles=public, with_check=null
DROP POLICY IF EXISTS "Staff manage retreat_schedule_days" ON public.retreat_schedule_days;
CREATE POLICY "Staff manage retreat_schedule_days" ON public.retreat_schedule_days
  AS PERMISSIVE FOR ALL TO public
  USING (is_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "Staff manage retreat_schedule_items" ON public.retreat_schedule_items;
CREATE POLICY "Staff manage retreat_schedule_items" ON public.retreat_schedule_items
  AS PERMISSIVE FOR ALL TO public
  USING (is_staff((SELECT auth.uid())));

COMMIT;
