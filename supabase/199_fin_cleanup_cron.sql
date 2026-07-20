-- =============================================================
-- Финмодуль, Этап 7: фоновая чистка непривязанных файлов
-- finance-files старше 24 часов (ТЗ 4.13 / Guide 13.2).
-- Механика: pg_cron ежедневно (03:00 IST) дёргает Edge Function
-- fin-cleanup через pg_net; секрет хранится в vault; функция
-- сверяет заголовок с vault и удаляет файлы через Storage API
-- (удалять строки storage.objects из SQL нельзя — физические
-- объекты осиротеют).
-- =============================================================

-- Кандидаты на удаление: файлы бакета старше суток без строки fin_attachments
CREATE OR REPLACE FUNCTION fin_private_unbound_files() RETURNS TABLE(name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT o.name FROM storage.objects o
  WHERE o.bucket_id = 'finance-files'
    AND o.created_at < now() - interval '24 hours'
    AND NOT EXISTS (SELECT 1 FROM fin_attachments a WHERE a.storage_path = o.name);
$$;

-- Секрет для сверки входящего вызова (единственное место хранения — vault)
CREATE OR REPLACE FUNCTION fin_private_cleanup_secret() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'fin_cleanup_secret';
$$;

REVOKE ALL ON FUNCTION fin_private_unbound_files()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_cleanup_secret()  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fin_private_unbound_files()  TO service_role;
GRANT EXECUTE ON FUNCTION fin_private_cleanup_secret() TO service_role;

-- Секрет (идемпотентно)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'fin_cleanup_secret') THEN
    PERFORM vault.create_secret('ca3ca85bec974672f9d566e86f09d857dec970c58ae069a6', 'fin_cleanup_secret');
  END IF;
END $$;

-- Расписание: 21:30 UTC = 03:00 IST
SELECT cron.unschedule('fin-cleanup-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fin-cleanup-daily');
SELECT cron.schedule(
  'fin-cleanup-daily',
  '30 21 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mymrijdfqeevoaocbzfy.supabase.co/functions/v1/fin-cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'fin_cleanup_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
