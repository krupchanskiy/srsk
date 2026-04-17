-- PR 9 (часть 3c) — RLS initPlan: оставшиеся 9 сложных полисий.
--
-- Более разнообразные полисии с подзапросами, has_permission(), is_superuser().
-- Паттерн: каждый голый auth.uid() обёрнут в (SELECT auth.uid()).
-- Применено на prod 2026-04-17.

BEGIN;

DROP POLICY "guest_read_own_crm_deals" ON public.crm_deals;
CREATE POLICY "guest_read_own_crm_deals" ON public.crm_deals
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (vaishnava_id IN (
    SELECT vaishnavas.id FROM vaishnavas
    WHERE vaishnavas.user_id = (SELECT auth.uid())
  ));

DROP POLICY "face_search_log_select" ON public.face_search_log;
CREATE POLICY "face_search_log_select" ON public.face_search_log
  AS PERMISSIVE FOR SELECT TO public
  USING (vaishnava_id IN (
    SELECT vaishnavas.id FROM vaishnavas
    WHERE vaishnavas.user_id = (SELECT auth.uid())
  ));

DROP POLICY "Allow UPDATE for upload_photos permission" ON public.retreat_photos;
CREATE POLICY "Allow UPDATE for upload_photos permission" ON public.retreat_photos
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    EXISTS (
      SELECT 1
      FROM user_permissions up
      JOIN permissions p ON (p.id = up.permission_id)
      WHERE up.user_id = (SELECT auth.uid())
        AND (p.code)::text = 'upload_photos'::text
    )
    OR EXISTS (
      SELECT 1
      FROM user_roles ur
      JOIN role_permissions rp ON (rp.role_id = ur.role_id)
      JOIN permissions p ON (p.id = rp.permission_id)
      WHERE ur.user_id = (SELECT auth.uid())
        AND (p.code)::text = 'upload_photos'::text
    )
  );

DROP POLICY "retreat_photos_select" ON public.retreat_photos;
CREATE POLICY "retreat_photos_select" ON public.retreat_photos
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1
      FROM retreat_registrations rr
      JOIN vaishnavas v ON (v.id = rr.vaishnava_id)
      WHERE rr.retreat_id = retreat_photos.retreat_id
        AND v.user_id = (SELECT auth.uid())
        AND rr.status = ANY (ARRAY['guest'::text, 'team'::text, 'volunteer'::text, 'vip'::text])
    )
    OR has_permission((SELECT auth.uid()), 'upload_photos'::text)
  );

DROP POLICY "telegram_link_tokens_insert_own" ON public.telegram_link_tokens;
CREATE POLICY "telegram_link_tokens_insert_own" ON public.telegram_link_tokens
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (vaishnava_id IN (
    SELECT vaishnavas.id FROM vaishnavas
    WHERE vaishnavas.user_id = (SELECT auth.uid())
  ));

DROP POLICY "telegram_link_tokens_select_own" ON public.telegram_link_tokens;
CREATE POLICY "telegram_link_tokens_select_own" ON public.telegram_link_tokens
  AS PERMISSIVE FOR SELECT TO public
  USING (vaishnava_id IN (
    SELECT vaishnavas.id FROM vaishnavas
    WHERE vaishnavas.user_id = (SELECT auth.uid())
  ));

DROP POLICY "Users can edit vaishnavas based on permissions" ON public.vaishnavas;
CREATE POLICY "Users can edit vaishnavas based on permissions" ON public.vaishnavas
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    is_superuser((SELECT auth.uid()))
    OR has_permission((SELECT auth.uid()), 'edit_vaishnava'::text)
    OR (user_id = (SELECT auth.uid()) AND has_permission((SELECT auth.uid()), 'edit_own_profile'::text))
    OR (parent_id IN (SELECT get_own_vaishnava_ids((SELECT auth.uid())))
        AND has_permission((SELECT auth.uid()), 'edit_own_profile'::text))
  );

DROP POLICY "Users can view vaishnavas based on permissions" ON public.vaishnavas;
CREATE POLICY "Users can view vaishnavas based on permissions" ON public.vaishnavas
  AS PERMISSIVE FOR SELECT TO public
  USING (
    user_id = (SELECT auth.uid())
    OR is_deleted = false
    OR is_superuser((SELECT auth.uid()))
    OR has_permission((SELECT auth.uid()), 'edit_vaishnava'::text)
  );

DROP POLICY "vaishnavas_update_own_telegram_chat_id" ON public.vaishnavas;
CREATE POLICY "vaishnavas_update_own_telegram_chat_id" ON public.vaishnavas
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

COMMIT;
