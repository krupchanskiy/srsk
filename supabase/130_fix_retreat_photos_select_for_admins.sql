-- Migration: 130_fix_retreat_photos_select_for_admins.sql
-- Fix SELECT policy: allow users with upload_photos permission to view all photos

DROP POLICY IF EXISTS "retreat_photos_select" ON public.retreat_photos;

CREATE POLICY "retreat_photos_select" ON public.retreat_photos
FOR SELECT
USING (
  -- Участники ретрита (guest, team) могут видеть фото своего ретрита
  EXISTS (
    SELECT 1 FROM public.retreat_registrations rr
    JOIN public.vaishnavas v ON v.id = rr.vaishnava_id
    WHERE rr.retreat_id = retreat_photos.retreat_id
      AND v.user_id = auth.uid()
      AND rr.status IN ('guest', 'team', 'volunteer', 'vip')
  )
  -- ИЛИ пользователи с правом upload_photos (включая суперпользователей)
  OR has_permission(auth.uid(), 'upload_photos')
);
