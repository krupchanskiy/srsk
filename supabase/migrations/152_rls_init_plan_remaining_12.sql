-- PR 9 (часть 3d) — доработка RLS initPlan: оставшиеся 12 политик.
--
-- В миграциях 148-150 я ловил auth.uid() регекспом, который не матчил
-- случаи когда auth.uid() обёрнут в функцию: own_vaishnava_id(auth.uid()),
-- has_permission(auth.uid(), ...), is_superuser(auth.uid()),
-- get_own_vaishnava_ids(auth.uid()).
--
-- Supabase performance advisors показал 12 оставшихся auth_rls_initplan
-- предупреждений после 148-150. Закрываем их тут.
--
-- Применено на prod 2026-04-17.

BEGIN;

-- crm_deals: гость читает свои сделки
DROP POLICY "Guest read own crm_deals" ON public.crm_deals;
CREATE POLICY "Guest read own crm_deals" ON public.crm_deals
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (vaishnava_id = own_vaishnava_id((SELECT auth.uid())));

-- crm_payments: гость читает платежи по своим сделкам
DROP POLICY "Guest read own crm_payments" ON public.crm_payments;
CREATE POLICY "Guest read own crm_payments" ON public.crm_payments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (deal_id IN (
    SELECT crm_deals.id FROM crm_deals
    WHERE crm_deals.vaishnava_id = own_vaishnava_id((SELECT auth.uid()))
  ));

-- guest_notes: гость читает заметки по своим регистрациям
DROP POLICY "Guest read own notes" ON public.guest_notes;
CREATE POLICY "Guest read own notes" ON public.guest_notes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (registration_id IN (
    SELECT retreat_registrations.id FROM retreat_registrations
    WHERE retreat_registrations.vaishnava_id = own_vaishnava_id((SELECT auth.uid()))
  ));

-- guest_payments
DROP POLICY "Guest read own payments" ON public.guest_payments;
CREATE POLICY "Guest read own payments" ON public.guest_payments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (registration_id IN (
    SELECT retreat_registrations.id FROM retreat_registrations
    WHERE retreat_registrations.vaishnava_id = own_vaishnava_id((SELECT auth.uid()))
  ));

-- guest_transfers
DROP POLICY "Guest read own transfers" ON public.guest_transfers;
CREATE POLICY "Guest read own transfers" ON public.guest_transfers
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (registration_id IN (
    SELECT retreat_registrations.id FROM retreat_registrations
    WHERE retreat_registrations.vaishnava_id = own_vaishnava_id((SELECT auth.uid()))
  ));

-- guest_visas
DROP POLICY "Guest read own visas" ON public.guest_visas;
CREATE POLICY "Guest read own visas" ON public.guest_visas
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (registration_id IN (
    SELECT retreat_registrations.id FROM retreat_registrations
    WHERE retreat_registrations.vaishnava_id = own_vaishnava_id((SELECT auth.uid()))
  ));

-- residents
DROP POLICY "Guest read own residents" ON public.residents;
CREATE POLICY "Guest read own residents" ON public.residents
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (vaishnava_id = own_vaishnava_id((SELECT auth.uid())));

-- retreat_registrations
DROP POLICY "Guest read own registrations" ON public.retreat_registrations;
CREATE POLICY "Guest read own registrations" ON public.retreat_registrations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (vaishnava_id = own_vaishnava_id((SELECT auth.uid())));

-- retreat_photos: delete (права upload_photos)
DROP POLICY "retreat_photos_delete" ON public.retreat_photos;
CREATE POLICY "retreat_photos_delete" ON public.retreat_photos
  AS PERMISSIVE FOR DELETE TO public
  USING (has_permission((SELECT auth.uid()), 'upload_photos'::text));

-- retreat_photos: insert (права upload_photos)
DROP POLICY "retreat_photos_insert" ON public.retreat_photos;
CREATE POLICY "retreat_photos_insert" ON public.retreat_photos
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (has_permission((SELECT auth.uid()), 'upload_photos'::text));

-- superusers: чтение своей записи
DROP POLICY "superusers_select_own" ON public.superusers;
CREATE POLICY "superusers_select_own" ON public.superusers
  AS PERMISSIVE FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);

-- vaishnavas: родитель создаёт детей
DROP POLICY "Parents can create children" ON public.vaishnavas;
CREATE POLICY "Parents can create children" ON public.vaishnavas
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    is_superuser((SELECT auth.uid()))
    OR has_permission((SELECT auth.uid()), 'create_vaishnava'::text)
    OR (parent_id IS NOT NULL AND parent_id IN (SELECT get_own_vaishnava_ids((SELECT auth.uid()))))
  );

COMMIT;
