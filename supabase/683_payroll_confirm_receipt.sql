-- Зарплата: отметка в чате без суммы + подтверждение получения в личке (ВГ, 11.10.2026).
--
-- 682 убрала сообщения о зарплате из чатов совсем. ВГ передумал: без
-- следа в Телеграме факт выдачи забывается, и потом нечем ответить на
-- «а мне выдавали?». Решение:
--   • в чат департамента — «✅ Имя — зарплата за сентябрь выдана полностью»
--     (или «частично»), БЕЗ суммы: оклады у людей разные, суммы при всех
--     не показываем;
--   • получателю в личку — сумма и кнопка «✅ Получил»; нажатие пишет
--     confirmed_at в ведомость — это подтверждение от самого человека;
--   • бот может написать в личку только тому, кто сам нажал «Старт» у
--     бота (сообщений в чате департамента для этого мало). Остальным —
--     пометка на странице ведомости и приглашение со ссылкой: ВГ
--     пересылает его человеку, тот жмёт «Старт», бот привязывает его и
--     сразу присылает неподтверждённые выплаты.
--
-- Подтверждения ждут только выплаты, проведённые после этой миграции
-- (confirm_requested_at); старые — без пометок.

ALTER TABLE public.fin_payroll_payments
  ADD COLUMN confirm_requested_at timestamptz,
  ADD COLUMN dm_sent_at timestamptz,
  ADD COLUMN confirmed_at timestamptz;

-- ---------------------------------------------------------------
-- «зарплата за сентябрь выдана полностью» / «… частично» / «выплата
-- проведена». Считаем по позиции накопительно, как и баланс ведомости
-- (438): выплачено всего ≥ начислено всего → полностью за последний
-- начисленный месяц; меньше → частично за первый не закрытый месяц.
-- Начислений нет вовсе (разовые выплаты без оклада) — месяц не называем.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_payroll_paid_phrase(p_position uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accrued numeric;
  v_paid numeric;
  v_period date;
  v_months text[] := ARRAY['январь','февраль','март','апрель','май','июнь',
                           'июль','август','сентябрь','октябрь','ноябрь','декабрь'];
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO v_accrued FROM fin_payroll_accruals WHERE position_id = p_position;
  IF v_accrued = 0 THEN RETURN 'выплата проведена'; END IF;

  SELECT COALESCE(sum(po.amount), 0) INTO v_paid
    FROM fin_payroll_payments fpp
    JOIN fin_postings po ON po.id = fpp.posting_id
    JOIN fin_operations o ON o.id = po.operation_id
   WHERE fpp.position_id = p_position AND NOT o.is_reversed;

  IF v_paid >= v_accrued THEN
    SELECT max(period) INTO v_period FROM fin_payroll_accruals WHERE position_id = p_position;
  ELSE
    SELECT period INTO v_period FROM (
      SELECT period, sum(amount) OVER (ORDER BY period) AS cum
        FROM fin_payroll_accruals WHERE position_id = p_position
    ) s WHERE cum > v_paid ORDER BY period LIMIT 1;
  END IF;

  RETURN format('зарплата за %s%s выдана %s',
    v_months[extract(month FROM v_period)::int],
    CASE WHEN extract(year FROM v_period) <> extract(year FROM current_date)
         THEN ' ' || extract(year FROM v_period)::int ELSE '' END,
    CASE WHEN v_paid >= v_accrued THEN 'полностью' ELSE 'частично' END);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_payroll_paid_phrase(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------
-- Личное сообщение получателю с кнопкой «Получил». Отправляет, только
-- если человек привязан к боту и выплата не сторнирована и ещё не
-- подтверждена. Возвращает true, если сообщение поставлено в очередь.
-- ---------------------------------------------------------------
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

  UPDATE fin_payroll_payments SET dm_sent_at = now() WHERE id = p_payment;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  -- сообщение не должно ронять выплату
  RETURN false;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_payroll_send_dm(uuid) FROM PUBLIC, anon, authenticated;

-- Каждая новая выплата по ведомости (со страницы или из черновика бота)
-- ждёт подтверждения и сразу пробует уйти получателю в личку.
CREATE OR REPLACE FUNCTION public.fin_payroll_payment_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE fin_payroll_payments SET confirm_requested_at = now() WHERE id = NEW.id;
  PERFORM tg_payroll_send_dm(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER fin_payroll_payment_after_insert
  AFTER INSERT ON public.fin_payroll_payments
  FOR EACH ROW EXECUTE FUNCTION public.fin_payroll_payment_after_insert();

-- ---------------------------------------------------------------
-- Нажатие «Получил». Подтвердить может только сам получатель — по его
-- Telegram-id. Возвращает текст, которым бот заменит сообщение.
-- ---------------------------------------------------------------
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
    format('💰 Зарплата: <b>%s</b>', fin_fmt_money(v_amount, v_cur))
    || format(E'\nДепартамент: %s', tg_escape(v_dept))
    || format(E'\nДата: %s', to_char(v_on, 'DD.MM.YYYY'))
    || format(E'\n\n✅ Получение подтверждено %s. Спасибо!',
              to_char(v_pay.confirmed_at AT TIME ZONE 'Asia/Kolkata', 'DD.MM.YYYY HH24:MI')));
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_payroll_confirm(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_payroll_confirm(uuid, bigint) TO service_role;

-- После привязки по ссылке — прислать всё, что ждёт подтверждения.
CREATE OR REPLACE FUNCTION public.tg_payroll_send_pending(p_tg_user bigint)
 RETURNS int
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
       AND fpp.dm_sent_at IS NULL
       AND NOT o.is_reversed
     ORDER BY o.occurred_on
  LOOP
    IF tg_payroll_send_dm(v_id) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_payroll_send_pending(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_payroll_send_pending(bigint) TO service_role;

-- Ссылка-приглашение для неподключённого получателя. Живёт 14 дней, а не
-- 30 минут, как кнопка в профиле: её пересылают и открывают не сразу.
CREATE OR REPLACE FUNCTION public.fin_payroll_invite_token(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_vaishnava uuid;
  v_token text;
BEGIN
  IF NOT fin_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  END IF;
  SELECT pp.vaishnava_id INTO v_vaishnava
    FROM fin_payroll_payments fpp JOIN fin_payroll_positions pp ON pp.id = fpp.position_id
   WHERE fpp.id = NULLIF(payload->>'payment_id', '')::uuid;
  IF v_vaishnava IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'not_found', 'message', 'Выплата не найдена'));
  END IF;
  v_token := encode(extensions.gen_random_bytes(9), 'hex');
  INSERT INTO tg_link_tokens (token, vaishnava_id, expires_at)
  VALUES (v_token, v_vaishnava, now() + interval '14 days');
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('token', v_token));
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_payroll_invite_token(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_payroll_invite_token(jsonb) TO authenticated;

-- Статус подтверждения — на страницу ведомости
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
    EXISTS (SELECT 1 FROM tg_user_links l
             JOIN fin_payroll_positions pp ON pp.vaishnava_id = l.vaishnava_id
            WHERE pp.id = fpp.position_id) AS recipient_linked
   FROM fin_payroll_payments fpp
     JOIN fin_postings po ON po.id = fpp.posting_id
     JOIN fin_operations o ON o.id = po.operation_id
  WHERE fin_is_admin();

-- Выплата со страницы ведомости: строка в чат департамента без суммы.
CREATE OR REPLACE FUNCTION public.fin_pay_payroll(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_position fin_payroll_positions%ROWTYPE;
  v_amount numeric;
  v_on date;
  v_comment text;
  v_employee_name text;
  v_category uuid;
  v_account uuid;
  v_cash_account uuid;
  v_request_id uuid := gen_random_uuid();
  v_transfer_request_id uuid := gen_random_uuid();
  v_row_id uuid := gen_random_uuid();
  v_transfer_res jsonb;
  v_res jsonb;
  v_detail text;
  v_chat bigint;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'comment']);

  SELECT * INTO v_position FROM fin_payroll_positions
    WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
  END IF;

  v_amount  := fin_private_get_money(payload, 'amount', true);
  v_on      := COALESCE(fin_private_get_date(payload, 'occurred_on', false), current_date);
  v_comment := NULLIF(btrim(COALESCE(payload->>'comment', '')), '');

  v_employee_name := fin_private_person_name(v_position.vaishnava_id);
  v_comment := v_employee_name || COALESCE(' — ' || v_comment, '');

  SELECT id INTO v_category FROM fin_categories WHERE code = 'dept_labor' AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = 'Статья «Оплата труда» не найдена в справочнике';
  END IF;

  SELECT id INTO v_cash_account
    FROM fin_accounts
   WHERE kind = 'real' AND group_name = 'Касса' AND currency_code = v_position.currency_code AND is_active
   LIMIT 1;
  IF v_cash_account IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = format('Касса в валюте %s не найдена', v_position.currency_code);
  END IF;

  v_account := fin_dept_account(v_position.department_id, v_position.currency_code);

  -- Триггер на проводках молчит: свою строку о выплате (без суммы) шлём ниже.
  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  -- шаг 1: выдать департаменту из кассы (как и любая ручная выплата тут)
  v_transfer_res := fin_create_transfer(jsonb_build_object(
    'request_id', v_transfer_request_id,
    'occurred_on', v_on,
    'source_account_id', v_cash_account,
    'target_account_id', v_account,
    'source_amount', v_amount,
    'target_amount', NULL,
    'comment', v_comment
  ));
  IF NOT COALESCE((v_transfer_res->>'ok')::boolean, false) THEN
    RETURN v_transfer_res;
  END IF;

  -- шаг 2: департамент сразу выдаёт выплаченное
  v_res := fin_create_expense(jsonb_build_object(
    'request_id', v_request_id,
    'occurred_on', v_on,
    'comment', v_comment,
    'reason', NULL,
    'payer_contact_id', NULL,
    'rows', jsonb_build_array(jsonb_build_object(
      'id', v_row_id,
      'account_id', v_account,
      'amount', v_amount,
      'category_id', v_category,
      'cost_center_id', NULL,
      'object_id', NULL,
      'participant_id', NULL,
      'contractor_id', NULL,
      'payment_channel', NULL
    ))
  ));

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    -- перевод уже прошёл — без исключения он остался бы висеть без
    -- расхода; RAISE откатывает оба шага как одно целое (см. шапку)
    RAISE EXCEPTION 'internal_error'
      USING DETAIL = 'Перевод прошёл, но расход не создался: ' || COALESCE(v_res->'error'->>'message', v_res->'error'->>'code', 'unknown');
  END IF;

  INSERT INTO fin_payroll_payments (posting_id, position_id) VALUES (v_row_id, v_position.id);

  -- В чат департамента — отметка без суммы (см. шапку 683). Личное
  -- сообщение получателю уже ушло из триггера на fin_payroll_payments.
  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_position.department_id AND is_active;
  IF v_chat IS NOT NULL THEN
    PERFORM tg_send_chat(v_chat,
      format('✅ %s — %s', tg_escape(v_employee_name), fin_payroll_paid_phrase(v_position.id)));
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', v_res->'result');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_confirmed', 'подтвердил получение', 'receipt confirmed', 'प्राप्ति की पुष्टि'),
  ('fin_payroll_wait_confirm', 'ждёт подтверждения', 'awaiting confirmation', 'पुष्टि की प्रतीक्षा'),
  ('fin_payroll_not_linked', 'не подключён к боту', 'not connected to the bot', 'बॉट से जुड़े नहीं'),
  ('fin_payroll_copy_invite', 'Скопировать приглашение', 'Copy invitation', 'निमंत्रण कॉपी करें'),
  ('fin_payroll_invite_copied', 'Приглашение скопировано — перешлите его человеку в Телеграм', 'Invitation copied — send it to the person in Telegram', 'निमंत्रण कॉपी हो गया — इसे व्यक्ति को टेलीग्राम में भेजें'),
  ('fin_payroll_unconfirmed_title', 'Не подтверждено получение зарплаты', 'Salary receipt not confirmed', 'वेतन प्राप्ति की पुष्टि नहीं हुई'),
  ('fin_payroll_invite_text',
   E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\nВам выдана зарплата. Чтобы подтвердить получение, откройте, пожалуйста, бота ашрама по ссылке и нажмите «Старт»:\n{link}\n\nБот пришлёт сумму и кнопку «✅ Получил» — нажмите её, пожалуйста. Это нужно сделать один раз, дальше бот будет присылать такие сообщения сам.',
   E'Hare Krishna! Please accept my humble obeisances.\n\nYour salary has been paid. To confirm receipt, please open the ashram bot using the link and press "Start":\n{link}\n\nThe bot will send the amount and a "✅ Получил" (Received) button — please press it. This is needed only once; after that the bot will send such messages automatically.',
   E'हरे कृष्ण! कृपया मेरा विनम्र प्रणाम स्वीकार करें।\n\nआपका वेतन दे दिया गया है। प्राप्ति की पुष्टि के लिए कृपया लिंक से आश्रम का बॉट खोलें और "Start" दबाएँ:\n{link}\n\nबॉट राशि और "✅ Получил" (प्राप्त हुआ) बटन भेजेगा — कृपया उसे दबाएँ। यह केवल एक बार करना है, इसके बाद बॉट ऐसे संदेश अपने आप भेजेगा।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
