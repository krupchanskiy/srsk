-- =========================
-- Патч для retreat_photos (на случай если таблица создана без полей)
-- Migration: 111_retreat_photos_add_fields_and_fix_policies.sql
-- Date: 2026-02-10
-- =========================

-- ПРИМЕЧАНИЕ: Эта миграция нужна только если таблица retreat_photos
-- была создана БЕЗ миграции 108 (т.е. старой версией без updated_at).
-- Если применяется миграция 108, то эта миграция безопасно пропустит
-- уже существующие колонки и политики (используется IF NOT EXISTS).

-- 1. Добавить недостающие поля (если их нет)
ALTER TABLE public.retreat_photos
  ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS day_number INT,
  ADD COLUMN IF NOT EXISTS caption TEXT;

-- 2. Создать функцию если не существует
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 3. Добавить триггер (если его нет)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='retreat_photos' AND column_name='updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS retreat_photos_set_updated_at ON public.retreat_photos;
    CREATE TRIGGER retreat_photos_set_updated_at
    BEFORE UPDATE ON public.retreat_photos
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

-- =========================
-- КОММЕНТАРИИ
-- =========================
-- Эта миграция — ПАТЧ для окружений, где retreat_photos была создана
-- без полей updated_at, uploaded_by, day_number, caption.
-- Если миграция 108 применена правильно, все ADD COLUMN IF NOT EXISTS
-- просто пропустятся без ошибок.
--
-- Миграция 108 создаёт таблицу со всеми полями и RLS-политиками.
-- Миграция 111 добавляет поля, если их нет (для старых баз).
