-- =============================================================
-- Telegram: человеческое оформление сообщений.
-- Разряды неразрывными пробелами, копейки только когда они есть,
-- символ валюты вместо кода, блоки вместо простыни строк.
-- =============================================================

-- ---------- Деньги: 24000.00 → «24 000 ₽», 1234.5 → «1 234,50 ₹» ----------
CREATE OR REPLACE FUNCTION public.fin_fmt_money(p_amount numeric, p_currency text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_nbsp text := chr(160);      -- неразрывный пробел: сумма не разрывается переносом
  v_abs numeric;
  v_int text;
  v_frac text := '';
  v_sign text := '';
  v_sym text;
BEGIN
  IF p_amount IS NULL THEN RETURN '—'; END IF;
  v_abs := round(abs(p_amount), 2);
  IF p_amount < 0 THEN v_sign := chr(8722); END IF;   -- настоящий минус, не дефис
  v_int := replace(to_char(trunc(v_abs), 'FM999,999,999,990'), ',', v_nbsp);
  IF v_abs <> trunc(v_abs) THEN
    v_frac := ',' || to_char(round((v_abs - trunc(v_abs)) * 100), 'FM00');
  END IF;
  v_sym := CASE upper(COALESCE(p_currency, ''))
    WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
    WHEN 'USD' THEN '$'  WHEN 'EUR' THEN '€'
    WHEN '' THEN '' ELSE p_currency END;
  RETURN v_sign || v_int || v_frac || CASE WHEN v_sym = '' THEN '' ELSE v_nbsp || v_sym END;
END;
$function$;

-- ---------- «2 платежа» вместо «2 платежей» ----------
CREATE OR REPLACE FUNCTION public.fin_plural(n bigint, f1 text, f2 text, f5 text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN n % 100 BETWEEN 11 AND 14 THEN f5
    WHEN n % 10 = 1 THEN f1
    WHEN n % 10 BETWEEN 2 AND 4 THEN f2
    ELSE f5 END;
$function$;

-- ---------- «23 июля» ----------
CREATE OR REPLACE FUNCTION public.fin_fmt_date_ru(d date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT extract(day FROM d)::int || ' ' || (ARRAY[
    'января','февраля','марта','апреля','мая','июня',
    'июля','августа','сентября','октября','ноября','декабря'
  ])[extract(month FROM d)::int];
$function$;

-- ---------- Имя счёта без валютного хвоста: «PayPal ($)» → «PayPal» ----------
-- Валюта и так видна в самой сумме — дублировать её в названии незачем.
CREATE OR REPLACE FUNCTION public.fin_short_account_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT regexp_replace(COALESCE(p_name, ''), '\s*\((₹|₽|\$|€)\)\s*$', '');
$function$;

REVOKE ALL ON FUNCTION public.fin_fmt_money(numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_plural(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_fmt_date_ru(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_short_account_name(text) FROM PUBLIC, anon, authenticated;

-- ---------- Дайджест ----------
CREATE OR REPLACE FUNCTION public.fin_tg_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balances text := '';
  v_empty int := 0;
  v_in text := '';
  v_out text := '';
  v_moves text := '';
  v_attention text := '';
  v_pending bigint;
  v_unposted bigint;
  v_stale text[] := '{}';
  v_stale_n int;
  r record;
BEGIN
  -- Остатки: ненулевые построчно, пустые — одной строкой (шум не нужен)
  FOR r IN
    SELECT a.name, a.currency_code,
           COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0) AS bal
    FROM fin_accounts a
    LEFT JOIN fin_postings p ON p.account_id = a.id
    WHERE a.kind = 'real' AND a.is_active
    GROUP BY a.id, a.name, a.currency_code
    ORDER BY a.name
  LOOP
    IF r.bal = 0 THEN
      v_empty := v_empty + 1;
    ELSE
      v_balances := v_balances || format(E'\n• %s — <b>%s</b>',
        tg_escape(fin_short_account_name(r.name)), fin_fmt_money(r.bal, r.currency_code));
    END IF;
  END LOOP;
  IF v_balances = '' THEN
    v_balances := E'\nвсе счета пусты';
  ELSIF v_empty > 0 THEN
    v_balances := v_balances || format(E'\n<i>ещё %s %s пуст%s</i>',
      v_empty, fin_plural(v_empty, 'счёт', 'счёта', 'счетов'),
      fin_plural(v_empty, '', 'ы', 'ы'));
  END IF;

  -- Вчера: только живые операции (сторнированные пары движением не считаем)
  FOR r IN
    SELECT p.currency_code,
           SUM(p.amount) FILTER (WHERE p.direction = 'in') AS s_in,
           SUM(p.amount) FILTER (WHERE p.direction = 'out') AS s_out
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounts a ON a.id = p.account_id
    WHERE o.occurred_on = CURRENT_DATE - 1
      AND a.kind = 'real'
      AND o.type NOT IN ('transfer', 'reversal')
      AND NOT o.is_reversed
    GROUP BY p.currency_code
    ORDER BY p.currency_code
  LOOP
    IF COALESCE(r.s_in, 0) > 0 THEN
      v_in := v_in || CASE WHEN v_in = '' THEN '' ELSE ', ' END || fin_fmt_money(r.s_in, r.currency_code);
    END IF;
    IF COALESCE(r.s_out, 0) > 0 THEN
      v_out := v_out || CASE WHEN v_out = '' THEN '' ELSE ', ' END || fin_fmt_money(r.s_out, r.currency_code);
    END IF;
  END LOOP;
  IF v_in <> '' THEN v_moves := v_moves || format(E'\n• приход — <b>%s</b>', v_in); END IF;
  IF v_out <> '' THEN v_moves := v_moves || format(E'\n• расход — <b>%s</b>', v_out); END IF;
  IF v_moves = '' THEN v_moves := E'\nдвижения не было'; END IF;

  -- Требует внимания
  SELECT count(*) INTO v_pending FROM crm_payments WHERE NOT is_confirmed;
  SELECT count(*) INTO v_unposted
  FROM crm_payments cp
  WHERE cp.is_confirmed
    AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
    AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id);

  IF v_unposted > 0 THEN
    v_attention := v_attention || format(E'\n🔴 не разнесен%s в учёт — <b>%s</b>',
      fin_plural(v_unposted, '', 'ы', 'ы'), v_unposted);
  END IF;
  IF v_pending > 0 THEN
    v_attention := v_attention || format(E'\n• ждут подтверждения — <b>%s %s</b>',
      v_pending, fin_plural(v_pending, 'платёж', 'платежа', 'платежей'));
  END IF;

  FOR r IN
    SELECT a.name,
           (SELECT max(c.performed_at) FROM fin_reconciliations c
            WHERE c.account_id = a.id AND c.is_checkpoint) AS last_cp
    FROM fin_accounts a
    WHERE a.kind = 'real' AND a.is_active
      AND EXISTS (SELECT 1 FROM fin_postings p WHERE p.account_id = a.id)
    ORDER BY a.name
  LOOP
    IF r.last_cp IS NULL OR r.last_cp < now() - interval '3 days' THEN
      v_stale := v_stale || fin_short_account_name(r.name);
    END IF;
  END LOOP;
  v_stale_n := array_length(v_stale, 1);
  IF v_stale_n IS NOT NULL THEN
    v_attention := v_attention || CASE
      WHEN v_stale_n <= 3 THEN format(E'\n• давно не сверялись — %s', tg_escape(array_to_string(v_stale, ', ')))
      ELSE format(E'\n• давно не сверялись — <b>%s %s</b>', v_stale_n,
                  fin_plural(v_stale_n, 'счёт', 'счёта', 'счетов')) END;
  END IF;
  IF v_attention = '' THEN v_attention := E'\nвсё в порядке'; END IF;

  PERFORM tg_send('finance', format(
    E'☀️ <b>Финансы · %s</b>\n\n<b>Остатки</b>%s\n\n<b>Вчера</b>%s\n\n<b>Требует внимания</b>%s\n\n<a href="https://in.rupaseva.com/finance/index.html">Открыть финмодуль</a>',
    fin_fmt_date_ru(CURRENT_DATE), v_balances, v_moves, v_attention));
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_tg_daily_digest() FROM PUBLIC, anon, authenticated;

-- ---------- Сигналы в том же стиле ----------
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
    E'🔴 <b>Платёж не попал в учёт</b>\n%s · %s\n%s\n\nПричина: %s%s',
    fin_fmt_money(v_pay.amount, v_pay.currency),
    tg_escape(COALESCE(v_guest, '—')),
    tg_escape(COALESCE(v_retreat, '—')),
    tg_escape(COALESCE(NEW.message, NEW.code, '—')),
    CASE WHEN v_deal IS NULL THEN ''
         ELSE format(E'\n\n<a href="https://in.rupaseva.com/crm/deal.html?id=%s">Открыть сделку</a>', v_deal) END));
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_on_integrity_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM tg_send('finance', format(
    E'🔴 <b>Нарушение целостности</b>\n%s\nЗатронуто записей: %s\n\n<a href="https://in.rupaseva.com/finance/index.html">Открыть финмодуль</a>',
    tg_escape(NEW.detail), NEW.bad_count));
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_on_negative_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_balance numeric;
BEGIN
  IF NEW.direction <> 'out' THEN RETURN NEW; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.kind <> 'real' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_balance FROM fin_postings WHERE account_id = NEW.account_id;
  IF v_balance < 0 AND v_balance + NEW.amount >= 0 THEN
    PERFORM tg_send('finance', format(
      E'🔴 <b>Счёт ушёл в минус</b>\n%s — <b>%s</b>\n\n<a href="https://in.rupaseva.com/finance/dds.html?account=%s">Открыть ленту счёта</a>',
      tg_escape(fin_short_account_name(v_acc.name)),
      fin_fmt_money(v_balance, v_acc.currency_code), v_acc.id));
  END IF;
  RETURN NEW;
END;
$function$;

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
    E'💰 <b>Ждёт подтверждения</b>\n%s · %s\n%s\n\nСпособ: %s\nМенеджер: %s\n\n<a href="https://in.rupaseva.com/crm/prepayments.html">Открыть предоплаты</a>',
    fin_fmt_money(NEW.amount, NEW.currency),
    tg_escape(COALESCE(v_guest, '—')),
    tg_escape(COALESCE(v_retreat, '—')),
    tg_escape(COALESCE(v_sys, '—')),
    tg_escape(COALESCE(v_manager, '—'))));
  RETURN NEW;
END;
$function$;
