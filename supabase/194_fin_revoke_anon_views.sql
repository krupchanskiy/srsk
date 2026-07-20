-- =============================================================
-- Финмодуль: убрать fin_v_*-views из поверхности роли anon.
-- Supabase по умолчанию грантит SELECT на новые public-объекты и
-- anon, и authenticated. Данные не утекали (WHERE-гейт возвращает 0
-- строк неавторизованному), но:
--   а) это лишняя поверхность в PostgREST;
--   б) после 193 (REVOKE anon на fin_can_read_all) запрос anon к view
--      упирается в permission denied на гейт-функцию — денай должен
--      быть на уровне самой view, а не невнятной ошибкой внутри.
-- authenticated не трогаем — ему views нужны.
-- =============================================================

DO $$
DECLARE v text;
BEGIN
  FOR v IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='v' AND c.relname LIKE 'fin_v_%'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v);
  END LOOP;
END $$;
