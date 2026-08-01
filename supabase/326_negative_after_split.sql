-- Минус по счёту плательщика: одна цифра, и она итоговая.
--
-- Заявка с разбивкой делает несколько списаний подряд. Триггер сообщает о
-- минусе в момент перехода через ноль, поэтому на такси 6000 (1750 + 4250)
-- в служебный чат уходило «Ашиш — −1 750 ₹», хотя по итогу заявки −6 000 ₹.
-- Цифра, не сходящаяся с реальностью, дороже самого сигнала.
--
-- Теперь на время проведения заявки триггер молчит, а tg_post_draft сам
-- проверяет: пересёк ли счёт ноль за всю заявку — и шлёт одно сообщение с
-- итоговым остатком.

-- Флаг подавления глушит все чат-уведомления от проводок, не только
-- департаментские, — имя приводим в соответствие.
create or replace function tg_notify_negative(p_account uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_balance numeric;
  v_what text;
BEGIN
  SELECT * INTO v_acc FROM fin_accounts WHERE id = p_account;
  IF v_acc.kind NOT IN ('real', 'custodial') OR v_acc.is_restricted THEN RETURN; END IF;

  v_balance := fin_private_account_balance(p_account);
  IF v_balance >= 0 THEN RETURN; END IF;

  v_what := CASE WHEN v_acc.kind = 'custodial' THEN 'Подотчёт ушёл в минус'
                 ELSE 'Счёт ушёл в минус' END;
  PERFORM tg_send('finance', format(
    E'\U0001F534 <b>%s</b>\n%s — <b>%s</b>%s\n\n<a href="https://in.rupaseva.com/finance/dds.html?account=%s">Открыть ленту счёта</a>',
    v_what,
    tg_escape(fin_short_account_name(v_acc.name)),
    fin_fmt_money(v_balance, v_acc.currency_code),
    CASE WHEN v_acc.kind = 'custodial'
         THEN E'\n<i>Похоже, выдача под отчёт не записана в систему</i>' ELSE '' END,
    v_acc.id));
END;
$function$;

create or replace function tg_on_negative_balance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_balance numeric;
BEGIN
  IF NEW.direction <> 'out' THEN RETURN NEW; END IF;
  -- заявка из чата с разбивкой считает итог сама
  IF COALESCE(current_setting('tg.suppress_chat_notify', true), '') = '1' THEN RETURN NEW; END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  -- следим и за реальными счетами, и за подотчётами департаментов;
  -- скрытые счета (подушка) по-прежнему молчат
  IF v_acc.kind NOT IN ('real', 'custodial') OR v_acc.is_restricted THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_balance FROM fin_postings WHERE account_id = NEW.account_id;

  -- сообщаем один раз — в момент перехода через ноль
  IF v_balance < 0 AND v_balance + NEW.amount >= 0 THEN
    PERFORM tg_notify_negative(NEW.account_id);
  END IF;
  RETURN NEW;
END;
$function$;

-- tg_notify_dept_credit проверяет тот же флаг — см. 325.
