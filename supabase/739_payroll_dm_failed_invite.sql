-- Зарплата: недоставленное личное сообщение → «не подключён» и приглашение (ВГ, 22.10.2026).
--
-- Ранганатху 18.10 ушло сообщение с «✅ Получил», Телеграм ответил «chat not
-- found»: Телеграм привязан (через чат департамента), но «Старт» у бота
-- человек не нажимал, а первым бот писать не может. Ведомость смотрела только
-- на привязку и показывала «ждёт подтверждения» — ждать было нечего. И даже
-- после «Старт» выплата не пришла бы: повторно слались только те, у которых
-- dm_sent_at пуст, а он ставится при постановке в очередь, не при доставке.
--
-- Теперь выплата помнит своё сообщение (dm_outbox_id). Оно не доставлено
-- (tg_outbox.status = 'failed') → получатель «не подключён», на странице
-- кнопка приглашения (683), а после «Старт» бот присылает выплату заново.

ALTER TABLE public.fin_payroll_payments ADD COLUMN dm_outbox_id bigint;

UPDATE public.fin_payroll_payments fpp SET dm_outbox_id = ob.id
  FROM public.tg_outbox ob
 WHERE fpp.dm_sent_at IS NOT NULL
   AND ob.reply_markup::text LIKE '%pc:' || fpp.id::text || '%';

CREATE OR REPLACE FUNCTION public.fin_payroll_dm_failed(p_outbox bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM tg_outbox WHERE id = p_outbox AND status = 'failed');
$function$;
REVOKE ALL ON FUNCTION public.fin_payroll_dm_failed(bigint) FROM PUBLIC, anon;
-- представление вызывает её с правами того, кто открыл ведомость (как 685)
GRANT EXECUTE ON FUNCTION public.fin_payroll_dm_failed(bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_payroll_send_dm(p_payment uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay fin_payroll_payments%ROWTYPE;
  v_pos fin_payroll_positions%ROWTYPE;
  v_tg bigint;
  v_amount numeric;
  v_cur text;
  v_on date;
  v_reversed boolean;
  v_dept text;
  v_id bigint;
BEGIN
  SELECT * INTO v_pay FROM fin_payroll_payments WHERE id = p_payment;
  IF NOT FOUND OR v_pay.confirmed_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO v_pos FROM fin_payroll_positions WHERE id = v_pay.position_id;

  SELECT tg_user_id INTO v_tg FROM tg_user_links WHERE vaishnava_id = v_pos.vaishnava_id
   ORDER BY linked_at DESC LIMIT 1;
  IF v_tg IS NULL THEN RETURN false; END IF;

  SELECT po.amount, po.currency_code, o.occurred_on, o.is_reversed
    INTO v_amount, v_cur, v_on, v_reversed
    FROM fin_postings po JOIN fin_operations o ON o.id = po.operation_id
   WHERE po.id = v_pay.posting_id;
  IF v_reversed THEN RETURN false; END IF;
  SELECT name INTO v_dept FROM fin_departments WHERE id = v_pos.department_id;

  INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
  VALUES (v_tg,
    'Харе Кришна! Примите, пожалуйста, мои поклоны.'
    || format(E'\n\n💰 Вам выдана зарплата: <b>%s</b>', fin_fmt_money(v_amount, v_cur))
    || format(E'\nДепартамент: %s', tg_escape(v_dept))
    || format(E'\nДата: %s', to_char(v_on, 'DD.MM.YYYY'))
    || format(E'\n%s.', upper(left(fin_payroll_paid_phrase(v_pos.id), 1)) || substr(fin_payroll_paid_phrase(v_pos.id), 2))
    || E'\n\nПожалуйста, нажмите «✅ Получил», если деньги у вас.',
    NULL, 'finance',
    jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
      jsonb_build_object('text', '✅ Получил', 'callback_data', 'pc:' || p_payment::text)))))
  RETURNING id INTO v_id;
  PERFORM tg_outbox_try(v_id);

  UPDATE fin_payroll_payments SET dm_sent_at = now(), dm_outbox_id = v_id WHERE id = p_payment;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  -- сообщение не должно ронять выплату
  RETURN false;
END;
$function$;

-- После «Старт» — прислать и то, что ни разу не уходило, и то, что не дошло
CREATE OR REPLACE FUNCTION public.tg_payroll_send_pending(p_tg_user bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_n int := 0;
BEGIN
  FOR v_id IN
    SELECT fpp.id
      FROM tg_user_links l
      JOIN fin_payroll_positions pp ON pp.vaishnava_id = l.vaishnava_id
      JOIN fin_payroll_payments fpp ON fpp.position_id = pp.id
      JOIN fin_postings po ON po.id = fpp.posting_id
      JOIN fin_operations o ON o.id = po.operation_id
     WHERE l.tg_user_id = p_tg_user
       AND fpp.confirm_requested_at IS NOT NULL
       AND fpp.confirmed_at IS NULL
       AND (fpp.dm_sent_at IS NULL OR fin_payroll_dm_failed(fpp.dm_outbox_id))
       AND NOT o.is_reversed
     ORDER BY o.occurred_on
  LOOP
    IF tg_payroll_send_dm(v_id) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- Не дошло сообщение — получатель для ведомости «не подключён» (кнопка приглашения)
CREATE OR REPLACE VIEW public.fin_v_payroll_payments AS
SELECT fpp.id,
    fpp.position_id,
    o.occurred_on,
    po.amount,
    po.currency_code,
    o.comment,
    o.is_reversed,
    fpp.confirm_requested_at,
    fpp.dm_sent_at,
    fpp.confirmed_at,
    (EXISTS (SELECT 1 FROM tg_user_links l
              JOIN fin_payroll_positions pp ON pp.vaishnava_id = l.vaishnava_id
             WHERE pp.id = fpp.position_id)
     AND NOT fin_payroll_dm_failed(fpp.dm_outbox_id)) AS recipient_linked
   FROM fin_payroll_payments fpp
     JOIN fin_postings po ON po.id = fpp.posting_id
     JOIN fin_operations o ON o.id = po.operation_id
  WHERE fin_is_admin();
