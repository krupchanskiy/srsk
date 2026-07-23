-- =============================================================
-- Telegram, этап 1–2 (одобрено ВГ 23.07.2026, бот @SRSKteambot).
-- Каналы по рубрикам: «Финансы» (ВГ) — красные сигналы + дайджест,
-- «Оплаты» (ВГ + Нитья-виласини) — платежи, ждущие подтверждения.
--
-- Устройство: токен в vault; отправка напрямую из БД через pg_net
-- (та же механика, что ночная чистка файлов). Никаких Edge Functions.
-- Пока в tg_channels не вписан chat_id канала — отправка тихо ложится
-- в tg_log со статусом no_channel: рубрики можно включать до того,
-- как каналы созданы, ничего не теряется и ничего не ломается.
-- Тихих часов нет — решение Адриана: тут встают рано, режим
-- уведомлений каждый настраивает на своём телефоне.
-- =============================================================

-- Токен бота (единственное место хранения — vault)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'telegram_bot_token') THEN
    PERFORM vault.create_secret('8877629320:AAGaJCXo8qsYupbtpiMFGq7yx9moedn5WBk', 'telegram_bot_token');
  END IF;
END $$;

-- Куда слать: рубрика → канал. chat_id заполняется после создания канала.
CREATE TABLE IF NOT EXISTS tg_channels (
  purpose text PRIMARY KEY,
  chat_id bigint,
  note text
);
ALTER TABLE tg_channels ENABLE ROW LEVEL SECURITY;  -- политик нет: доступ только из definer-функций
REVOKE ALL ON tg_channels FROM PUBLIC, anon, authenticated;

INSERT INTO tg_channels (purpose, note) VALUES
  ('finance',  'Красные сигналы + утренний дайджест — ВГ'),
  ('payments', 'Платежи, ждущие подтверждения — ВГ + Нитья-виласини')
ON CONFLICT (purpose) DO NOTHING;

-- Журнал отправок: что, куда, ушло ли (для отладки и «тишина ≠ поломка»)
CREATE TABLE IF NOT EXISTS tg_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purpose text NOT NULL,
  chat_id bigint,
  text text NOT NULL,
  status text NOT NULL,
  request_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tg_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_log FROM PUBLIC, anon, authenticated;

-- Экранирование для parse_mode=HTML
CREATE OR REPLACE FUNCTION public.tg_escape(p text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT replace(replace(replace(COALESCE(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') $$;
REVOKE ALL ON FUNCTION public.tg_escape(text) FROM PUBLIC, anon, authenticated;

-- Отправка. Никогда не роняет вызвавшую транзакцию: любая ошибка — в журнал.
CREATE OR REPLACE FUNCTION public.tg_send(p_purpose text, p_text text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_chat bigint;
  v_token text;
  v_req bigint;
BEGIN
  SELECT chat_id INTO v_chat FROM tg_channels WHERE purpose = p_purpose;
  IF v_chat IS NULL THEN
    INSERT INTO tg_log (purpose, text, status) VALUES (p_purpose, p_text, 'no_channel');
    RETURN;
  END IF;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token';
  SELECT net.http_post(
    url := format('https://api.telegram.org/bot%s/sendMessage', v_token),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'chat_id', v_chat,
      'text', p_text,
      'parse_mode', 'HTML',
      'disable_web_page_preview', true)
  ) INTO v_req;
  INSERT INTO tg_log (purpose, chat_id, text, status, request_id)
  VALUES (p_purpose, v_chat, p_text, 'sent', v_req);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO tg_log (purpose, chat_id, text, status)
  VALUES (p_purpose, v_chat, p_text, 'error: ' || SQLERRM);
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_send(text, text) FROM PUBLIC, anon, authenticated;

-- ---------- Красный сигнал 1: платёж не попал в учёт ----------
CREATE OR REPLACE FUNCTION public.tg_on_autopost_error()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pay crm_payments%ROWTYPE;
  v_guest text;
  v_retreat text;
  v_deal uuid;
BEGIN
  SELECT * INTO v_pay FROM crm_payments WHERE id = NEW.payment_id;
  IF FOUND THEN
    v_deal := v_pay.deal_id;
    SELECT COALESCE(NULLIF(v.spiritual_name, ''), trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))),
           COALESCE(r.name_ru, r.name_en)
      INTO v_guest, v_retreat
    FROM crm_deals d
    LEFT JOIN vaishnavas v ON v.id = d.vaishnava_id
    LEFT JOIN retreats r ON r.id = d.retreat_id
    WHERE d.id = v_pay.deal_id;
  END IF;
  PERFORM tg_send('finance', format(
    E'🔴 <b>Платёж не попал в учёт</b>\n%s %s · %s · %s\nПричина: %s\n%s',
    COALESCE(v_pay.amount::text, '?'), COALESCE(v_pay.currency, ''),
    tg_escape(COALESCE(v_guest, '—')), tg_escape(COALESCE(v_retreat, '—')),
    tg_escape(COALESCE(NEW.message, NEW.code, '—')),
    CASE WHEN v_deal IS NULL THEN '' ELSE 'https://in.rupaseva.com/crm/deal.html?id=' || v_deal END));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tg_autopost_error ON fin_crm_autopost_log;
CREATE TRIGGER trg_tg_autopost_error
  AFTER INSERT ON fin_crm_autopost_log
  FOR EACH ROW
  WHEN (NEW.status = 'error')
  EXECUTE FUNCTION tg_on_autopost_error();

-- ---------- Красный сигнал 2: сторож нашёл нарушение целостности ----------
CREATE OR REPLACE FUNCTION public.tg_on_integrity_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM tg_send('finance', format(
    E'🔴 <b>Нарушение целостности</b>\n%s (%s шт.)\nhttps://in.rupaseva.com/finance/index.html',
    tg_escape(NEW.detail), NEW.bad_count));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tg_integrity_alert ON fin_integrity_alerts;
CREATE TRIGGER trg_tg_integrity_alert
  AFTER INSERT ON fin_integrity_alerts
  FOR EACH ROW
  EXECUTE FUNCTION tg_on_integrity_alert();

-- ---------- Красный сигнал 3: реальный счёт ушёл в минус ----------
-- Срабатывает только на переходе через ноль (было >= 0, стало < 0).
CREATE OR REPLACE FUNCTION public.tg_on_negative_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_balance numeric;
  v_delta numeric;
BEGIN
  IF NEW.direction <> 'out' THEN RETURN NEW; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.kind <> 'real' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_balance FROM fin_postings WHERE account_id = NEW.account_id;
  IF v_balance < 0 AND v_balance + NEW.amount >= 0 THEN
    PERFORM tg_send('finance', format(
      E'🔴 <b>Счёт ушёл в минус</b>\n%s: %s %s\nhttps://in.rupaseva.com/finance/dds.html?account=%s',
      tg_escape(v_acc.name), v_balance, v_acc.currency_code, v_acc.id));
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tg_negative_balance ON fin_postings;
CREATE TRIGGER trg_tg_negative_balance
  AFTER INSERT ON fin_postings
  FOR EACH ROW
  EXECUTE FUNCTION tg_on_negative_balance();

-- ---------- Канал «Оплаты»: платёж ждёт подтверждения ----------
CREATE OR REPLACE FUNCTION public.tg_on_pending_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_guest text;
  v_retreat text;
  v_manager text;
  v_sys text;
BEGIN
  SELECT COALESCE(NULLIF(v.spiritual_name, ''), trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))),
         COALESCE(r.name_ru, r.name_en)
    INTO v_guest, v_retreat
  FROM crm_deals d
  LEFT JOIN vaishnavas v ON v.id = d.vaishnava_id
  LEFT JOIN retreats r ON r.id = d.retreat_id
  WHERE d.id = NEW.deal_id;
  SELECT COALESCE(NULLIF(spiritual_name, ''), trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')))
    INTO v_manager FROM vaishnavas WHERE id = NEW.received_by;
  SELECT name_ru INTO v_sys FROM crm_payment_systems WHERE id = NEW.payment_system_id;
  PERFORM tg_send('payments', format(
    E'💰 <b>Ждёт подтверждения</b>\n%s %s · %s · %s\nСпособ: %s · внёс: %s\nhttps://in.rupaseva.com/crm/prepayments.html',
    NEW.amount, NEW.currency,
    tg_escape(COALESCE(v_guest, '—')), tg_escape(COALESCE(v_retreat, '—')),
    tg_escape(COALESCE(v_sys, '—')), tg_escape(COALESCE(v_manager, '—'))));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tg_pending_payment ON crm_payments;
CREATE TRIGGER trg_tg_pending_payment
  AFTER INSERT ON crm_payments
  FOR EACH ROW
  WHEN (NOT NEW.is_confirmed)
  EXECUTE FUNCTION tg_on_pending_payment();

-- ---------- Утренний дайджест (9:00 IST = 3:30 UTC) ----------
-- Приходит всегда, даже когда всё по нулям: тишина в спокойный день
-- была бы неотличима от сломавшегося бота.
CREATE OR REPLACE FUNCTION public.fin_tg_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lines text := '';
  v_in text := '';
  v_out text := '';
  v_pending int;
  v_unposted int;
  v_stale text := '';
  r record;
BEGIN
  -- Остатки по боевым счетам (все активные, и нулевые тоже — картина целиком)
  FOR r IN
    SELECT a.name, a.currency_code,
           COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0) AS bal
    FROM fin_accounts a
    LEFT JOIN fin_postings p ON p.account_id = a.id
    WHERE a.kind = 'real' AND a.is_active
    GROUP BY a.id, a.name, a.currency_code
    ORDER BY a.name
  LOOP
    v_lines := v_lines || format(E'\n• %s: %s %s', tg_escape(r.name), r.bal, r.currency_code);
  END LOOP;

  -- Вчера: приходы и расходы по валютам (без сторно-пар смысла не искажают: сумма честная)
  FOR r IN
    SELECT p.currency_code,
           SUM(p.amount) FILTER (WHERE p.direction = 'in') AS s_in,
           SUM(p.amount) FILTER (WHERE p.direction = 'out') AS s_out
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounts a ON a.id = p.account_id
    WHERE o.occurred_on = CURRENT_DATE - 1 AND a.kind = 'real' AND o.type <> 'transfer'
    GROUP BY p.currency_code
  LOOP
    IF COALESCE(r.s_in, 0) > 0 THEN v_in := v_in || format(' +%s %s', r.s_in, r.currency_code); END IF;
    IF COALESCE(r.s_out, 0) > 0 THEN v_out := v_out || format(' −%s %s', r.s_out, r.currency_code); END IF;
  END LOOP;

  SELECT count(*) INTO v_pending FROM crm_payments WHERE NOT is_confirmed;
  SELECT count(*) INTO v_unposted
  FROM crm_payments cp
  WHERE cp.is_confirmed
    AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
    AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id);

  -- Кассы, не сверявшиеся больше 3 дней (среди счетов, где уже есть операции)
  FOR r IN
    SELECT a.name,
           (SELECT max(c.performed_at) FROM fin_reconciliations c
            WHERE c.account_id = a.id AND c.is_checkpoint) AS last_cp
    FROM fin_accounts a
    WHERE a.kind = 'real' AND a.is_active
      AND EXISTS (SELECT 1 FROM fin_postings p WHERE p.account_id = a.id)
  LOOP
    IF r.last_cp IS NULL THEN
      v_stale := v_stale || format(E'\n⚠️ %s: ни разу не сверялся', tg_escape(r.name));
    ELSIF r.last_cp < now() - interval '3 days' THEN
      v_stale := v_stale || format(E'\n⚠️ %s: сверялся %s дн. назад', tg_escape(r.name),
        floor(extract(epoch FROM now() - r.last_cp) / 86400)::int);
    END IF;
  END LOOP;

  PERFORM tg_send('finance', format(
    E'☀️ <b>Финансы на %s</b>\n<b>Остатки:</b>%s\n<b>Вчера:</b>%s%s\n<b>Ждут подтверждения:</b> %s платежей%s%s\nhttps://in.rupaseva.com/finance/index.html',
    to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD.MM'),
    COALESCE(NULLIF(v_lines, ''), E'\n—'),
    CASE WHEN v_in = '' AND v_out = '' THEN ' движения не было' ELSE v_in || v_out END, '',
    v_pending,
    CASE WHEN v_unposted > 0 THEN format(E'\n🔴 <b>Не разнесены в учёт: %s</b>', v_unposted) ELSE '' END,
    v_stale));
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_tg_daily_digest() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('fin-tg-digest')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fin-tg-digest');
SELECT cron.schedule('fin-tg-digest', '30 3 * * *', $$SELECT public.fin_tg_daily_digest()$$);
