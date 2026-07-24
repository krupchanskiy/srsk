-- Сводка теперь говорит и про заявки из чатов: сколько ждёт проведения и
-- сколько карточек висит без ответа. Единственное изменение относительно
-- предыдущей версии — одна строка перед проверкой «всё в порядке»:
--
--     v_attention := v_attention || fin_tg_chat_drafts_line();
--
-- Функция пересоздаётся целиком, потому что менять тело по частям в SQL нельзя.
CREATE OR REPLACE FUNCTION fin_tg_daily_digest()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  FOR r IN
    SELECT a.name, a.currency_code,
           COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0) AS bal
    FROM fin_accounts a
    LEFT JOIN fin_postings p ON p.account_id = a.id
    WHERE a.kind = 'real' AND a.is_active AND NOT a.is_restricted
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

  FOR r IN
    SELECT p.currency_code,
           SUM(p.amount) FILTER (WHERE p.direction = 'in') AS s_in,
           SUM(p.amount) FILTER (WHERE p.direction = 'out') AS s_out
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounts a ON a.id = p.account_id
    WHERE o.occurred_on = CURRENT_DATE - 1
      AND a.kind = 'real' AND NOT a.is_restricted
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

  SELECT count(*) INTO v_pending FROM crm_payments WHERE NOT is_confirmed;
  SELECT count(*) INTO v_unposted
  FROM crm_payments cp
  WHERE cp.is_confirmed
    AND COALESCE(cp.received_at::date, CURRENT_DATE) >= COALESCE(fin_cutover_date(), DATE '1900-01-01')
    AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
    AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id AND g.status <> 'skipped');

  IF v_unposted > 0 THEN
    v_attention := v_attention || format(E'\n\U0001F534 не разнесен%s в учёт — <b>%s</b>',
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
    WHERE a.kind = 'real' AND a.is_active AND NOT a.is_restricted
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

  -- Заявки из чатов департаментов
  v_attention := v_attention || fin_tg_chat_drafts_line();

  IF v_attention = '' THEN v_attention := E'\nвсё в порядке'; END IF;

  PERFORM tg_send('finance', format(
    E'☀️ <b>Финансы · %s</b>\n\n<b>Остатки</b>%s\n\n<b>Вчера</b>%s\n\n<b>Требует внимания</b>%s\n\n<a href="https://in.rupaseva.com/finance/index.html">Открыть финмодуль</a>',
    fin_fmt_date_ru(CURRENT_DATE), v_balances, v_moves, v_attention));
END;
$$;
