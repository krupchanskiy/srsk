-- Migration: 133_setup_daily_photo_notifications_cron.sql
-- Настройка ежедневной рассылки уведомлений о новых фото в 19:00 IST (13:30 UTC)

-- ИНСТРУКЦИЯ: Настройка cron через Supabase Dashboard
--
-- DEV окружение:
-- 1. Перейти в Dashboard: https://supabase.com/dashboard/project/vzuiwpeovnzfokekdetq/database/cron-jobs
-- 2. Нажать "Create a new cron job"
-- 3. Заполнить:
--    - Name: daily-photo-notifications
--    - Schedule: 30 13 * * * (13:30 UTC = 19:00 IST)
--    - SQL command:
--      SELECT net.http_post(
--        url := 'https://vzuiwpeovnzfokekdetq.supabase.co/functions/v1/daily-photo-notifications',
--        headers := '{"Content-Type": "application/json", "Authorization": "Bearer [SERVICE_ROLE_KEY]"}'::jsonb,
--        body := '{}'::jsonb
--      );
--
-- PROD окружение:
-- 1. Перейти в Dashboard: https://supabase.com/dashboard/project/llttmftapmwebidgevmg/database/cron-jobs
-- 2. Аналогично, но URL: https://llttmftapmwebidgevmg.supabase.co/functions/v1/daily-photo-notifications
--
-- Заменить [SERVICE_ROLE_KEY] на реальный ключ из Settings → API
--
-- ВАЖНО: pg_cron работает в UTC. 13:30 UTC = 19:00 IST (UTC+5:30)

-- Включить расширения (если ещё не включены)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Placeholder: реальная настройка cron через Dashboard
-- (нельзя хранить service_role_key в SQL-миграциях)
