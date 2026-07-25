-- Минус на подотчёте департамента был невидим.
--
-- tg_on_negative_balance выходил на `kind <> 'real'`, то есть следил только за
-- кассами и банковскими счетами. Подотчётные счета департаментов (custodial) в
-- сигнал не попадали. Утренняя сводка тоже перебирает только real-счета.
-- Итог: департамент уходит в минус — и об этом не сообщает никто.
--
-- Проверено: расход 5000 при нулевом подотчёте Гест-хауса прошёл, счёт стал
-- −5000, ни сигнала, ни строки в сводке.
--
-- А минус на подотчёте значит одно из двух: забыли записать выдачу или
-- департамент потратил больше выданного. И то и другое требует внимания
-- сразу, а не при случайном открытии страницы счетов.
CREATE OR REPLACE FUNCTION tg_on_negative_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_balance numeric;
  v_what text;
BEGIN
  IF NEW.direction <> 'out' THEN RETURN NEW; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  -- следим и за реальными счетами, и за подотчётами департаментов;
  -- скрытые счета (подушка) по-прежнему молчат
  IF v_acc.kind NOT IN ('real', 'custodial') OR v_acc.is_restricted THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_balance FROM fin_postings WHERE account_id = NEW.account_id;

  IF v_balance < 0 AND v_balance + NEW.amount >= 0 THEN
    v_what := CASE WHEN v_acc.kind = 'custodial'
                   THEN 'Подотчёт ушёл в минус'
                   ELSE 'Счёт ушёл в минус' END;
    PERFORM tg_send('finance', format(
      E'\U0001F534 <b>%s</b>\n%s — <b>%s</b>%s\n\n<a href="https://in.rupaseva.com/finance/dds.html?account=%s">Открыть ленту счёта</a>',
      v_what,
      tg_escape(fin_short_account_name(v_acc.name)),
      fin_fmt_money(v_balance, v_acc.currency_code),
      CASE WHEN v_acc.kind = 'custodial'
           THEN E'\n<i>Похоже, выдача под отчёт не записана в систему</i>' ELSE '' END,
      v_acc.id));
  END IF;
  RETURN NEW;
END;
$$;

-- Строка в утреннюю сводку: департаменты в минусе
CREATE OR REPLACE FUNCTION fin_tg_negative_custodial_line()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_list text := ''; v_n int := 0; r record;
BEGIN
  FOR r IN
    SELECT a.name, a.currency_code,
           COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0) AS bal
    FROM fin_accounts a
    JOIN fin_postings p ON p.account_id = a.id
    WHERE a.kind = 'custodial' AND a.is_active AND NOT a.is_restricted
    GROUP BY a.id, a.name, a.currency_code
    HAVING COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0) < 0
    ORDER BY 3
  LOOP
    v_n := v_n + 1;
    v_list := v_list || CASE WHEN v_list = '' THEN '' ELSE ', ' END
              || format('%s (%s)', tg_escape(fin_short_account_name(r.name)),
                        fin_fmt_money(r.bal, r.currency_code));
  END LOOP;
  IF v_n = 0 THEN RETURN ''; END IF;
  RETURN format(E'\n\U0001F534 %s в минусе — %s',
    fin_plural(v_n, 'подотчёт', 'подотчёта', 'подотчётов'), v_list);
END;
$$;

REVOKE ALL ON FUNCTION tg_on_negative_balance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_tg_negative_custodial_line() FROM PUBLIC, anon, authenticated;

-- Подключение строки к сводке (патч по месту, чтобы не дублировать всю функцию):
--   v_attention := v_attention || fin_tg_negative_custodial_line();
-- вставлена перед строкой fin_tg_chat_drafts_line() в fin_tg_daily_digest.
