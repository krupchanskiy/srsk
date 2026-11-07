-- Напоминание подтвердить получение (решение ВГ 07.11.2026): пока человек не
-- нажал «✅ Получил», бот раз в 2 дня присылает ему в личку напоминание с той
-- же кнопкой. Только тем, кому личное сообщение о выплате уже ушло (бот
-- подключён), Телеграм у человека не выключен (684), выплата не сторнирована.
-- Напоминает, пока не подтвердит.
-- Заодно: ответ на «Получил» называет выплату так же, как личка (776):
-- «Зарплата» при окладе, «Благодарность за служение» без него.
-- Метка в ведомости — «ждёт подтверждения в Телеграме» (новый ключ, чтобы
-- кэш переводов в браузерах перечитался).

ALTER TABLE fin_payroll_payments ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

CREATE OR REPLACE FUNCTION public.fin_payroll_is_salaried(p_position uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM fin_payroll_positions WHERE id = p_position AND salary_amount IS NOT NULL)
      OR EXISTS (SELECT 1 FROM fin_payroll_accruals WHERE position_id = p_position);
$function$;

CREATE OR REPLACE FUNCTION public.tg_payroll_remind()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_id bigint;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT fp.id, l.tg_user_id, po.amount, po.currency_code, o.occurred_on, d.name AS dept
      FROM fin_payroll_payments fp
      JOIN fin_payroll_positions p ON p.id = fp.position_id
      JOIN fin_departments d ON d.id = p.department_id
      JOIN fin_postings po ON po.id = fp.posting_id
      JOIN fin_operations o ON o.id = po.operation_id
      JOIN LATERAL (SELECT tg_user_id FROM tg_user_links WHERE vaishnava_id = p.vaishnava_id
                     ORDER BY linked_at DESC LIMIT 1) l ON true
     WHERE fp.confirm_requested_at IS NOT NULL
       AND fp.confirmed_at IS NULL
       AND fp.dm_sent_at IS NOT NULL
       AND NOT o.is_reversed
       AND fin_payroll_tg_enabled(p.vaishnava_id)
       -- 47 ч, а не 48: ежедневный запуск в одно время не должен сползти на 3 дня
       AND COALESCE(fp.reminded_at, fp.dm_sent_at) <= now() - interval '47 hours'
  LOOP
    BEGIN
      INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
      VALUES (r.tg_user_id,
        E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\nНапоминаем: пожалуйста, подтвердите получение.\n\n'
        || format('💰 <b>%s</b>', fin_fmt_money(r.amount, r.currency_code))
        || format(E'\nДепартамент: %s', tg_escape(r.dept))
        || format(E'\nДата: %s', to_char(r.occurred_on, 'DD.MM.YYYY'))
        || E'\n\nЕсли денежки у вас, нажмите, пожалуйста, «✅ Получил».',
        NULL, 'finance',
        jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
          jsonb_build_object('text', '✅ Получил', 'callback_data', 'pc:' || r.id::text)))))
      RETURNING id INTO v_id;
      PERFORM tg_outbox_try(v_id);
      UPDATE fin_payroll_payments SET reminded_at = now() WHERE id = r.id;
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      -- одно неудачное напоминание не должно остановить остальные
      NULL;
    END;
  END LOOP;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_payroll_remind() FROM PUBLIC, anon, authenticated;

-- Каждый день в 10:00 по Индии (04:30 UTC); кому пора — решает сама функция
SELECT cron.unschedule('tg-payroll-remind') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tg-payroll-remind');
SELECT cron.schedule('tg-payroll-remind', '30 4 * * *', 'SELECT public.tg_payroll_remind()');

CREATE OR REPLACE FUNCTION public.tg_payroll_confirm(p_payment uuid, p_tg_user bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay fin_payroll_payments%ROWTYPE;
  v_vaishnava uuid;
  v_amount numeric;
  v_cur text;
  v_on date;
  v_reversed boolean;
  v_dept text;
BEGIN
  SELECT fpp.* INTO v_pay FROM fin_payroll_payments fpp WHERE fpp.id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  SELECT pp.vaishnava_id, d.name INTO v_vaishnava, v_dept
    FROM fin_payroll_positions pp JOIN fin_departments d ON d.id = pp.department_id
   WHERE pp.id = v_pay.position_id;
  IF NOT EXISTS (SELECT 1 FROM tg_user_links WHERE tg_user_id = p_tg_user AND vaishnava_id = v_vaishnava) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_recipient');
  END IF;

  SELECT po.amount, po.currency_code, o.occurred_on, o.is_reversed
    INTO v_amount, v_cur, v_on, v_reversed
    FROM fin_postings po JOIN fin_operations o ON o.id = po.operation_id
   WHERE po.id = v_pay.posting_id;
  IF v_reversed THEN RETURN jsonb_build_object('ok', false, 'error', 'reversed'); END IF;

  IF v_pay.confirmed_at IS NULL THEN
    UPDATE fin_payroll_payments SET confirmed_at = now() WHERE id = p_payment
    RETURNING * INTO v_pay;
  END IF;

  RETURN jsonb_build_object('ok', true, 'text',
    format('💰 %s: <b>%s</b>',
           CASE WHEN fin_payroll_is_salaried(v_pay.position_id) THEN 'Зарплата' ELSE 'Благодарность за служение' END,
           fin_fmt_money(v_amount, v_cur))
    || format(E'\nДепартамент: %s', tg_escape(v_dept))
    || format(E'\nДата: %s', to_char(v_on, 'DD.MM.YYYY'))
    || format(E'\n\n✅ Получение подтверждено %s. Спасибо!',
              to_char(v_pay.confirmed_at AT TIME ZONE 'Asia/Kolkata', 'DD.MM.YYYY HH24:MI')));
END;
$function$;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_wait_confirm_tg', 'ждёт подтверждения в Телеграме', 'awaiting confirmation in Telegram', 'टेलीग्राम में पुष्टि की प्रतीक्षा')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
