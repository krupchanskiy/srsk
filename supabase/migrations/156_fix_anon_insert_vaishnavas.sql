-- HOTFIX для миграции 154.
--
-- Проблема обнаружена smoke-тестом под anon:
-- INSERT vaishnavas с полем email падал с
-- "new row violates row-level security policy for table vaishnavas".
--
-- Причина: триггер auto_create_auth_for_vaishnava (SECURITY DEFINER)
-- при email IS NOT NULL:
--   1. Создаёт запись в auth.users
--   2. Устанавливает NEW.user_id := v_auth_id
-- Это происходит ПЕРЕД WITH CHECK проверкой RLS. Моя проверка
-- user_id IS NULL → false → RLS блокирует.
--
-- Fix: убираем проверку user_id IS NULL. Защита от эскалации
-- привилегий остаётся через остальные условия (is_superuser=false,
-- is_team_member=false, user_type='guest').
--
-- Применено на prod 2026-04-17.

BEGIN;

DROP POLICY anon_insert_vaishnavas ON public.vaishnavas;
CREATE POLICY anon_insert_vaishnavas ON public.vaishnavas
  AS PERMISSIVE FOR INSERT TO anon
  WITH CHECK (
    COALESCE(is_superuser, false) = false
    AND COALESCE(is_team_member, false) = false
    AND COALESCE(user_type, 'guest') = 'guest'
    AND COALESCE(is_deleted, false) = false
  );

COMMIT;
