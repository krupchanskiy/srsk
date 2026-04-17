-- PR 9 (часть 3a) — RLS initPlan: пилотная волна на справочниках.
--
-- Замена is_staff(auth.uid()) → is_staff((SELECT auth.uid()))
-- в 4 полисиях на таблицах с низким трафиком. Применено на prod 2026-04-17.
--
-- Семантика идентична: (SELECT auth.uid()) исполняется один раз на запрос
-- через initPlan и кешируется Postgres'ом, вместо пересчёта per-row.
-- Закрывает часть advisor auth_rls_initplan.

BEGIN;

DROP POLICY "Staff manage units" ON public.units;
CREATE POLICY "Staff manage units" ON public.units
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

DROP POLICY "Staff manage product_categories" ON public.product_categories;
CREATE POLICY "Staff manage product_categories" ON public.product_categories
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

DROP POLICY "Staff manage recipe_categories" ON public.recipe_categories;
CREATE POLICY "Staff manage recipe_categories" ON public.recipe_categories
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

DROP POLICY "Staff manage building_types" ON public.building_types;
CREATE POLICY "Staff manage building_types" ON public.building_types
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

COMMIT;
