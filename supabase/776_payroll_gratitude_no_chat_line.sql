-- Сообщения о выплатах по ведомости (решение ВГ 07.11.2026):
--   • есть оклад или начисления — «зарплата», как раньше, но теплее:
--     «Спасибо большое за ваше служение! 💰 Ваша зарплата за октябрь: … —
--     выдана полностью.»
--   • оклада нет, выплаты разовые/нерегулярные — «Спасибо большое за ваше
--     служение! В качестве благодарности примите, пожалуйста: 💰 …»
--   • в чат департамента о выплате больше ничего не пишется (683 слала
--     «✅ Имя — зарплата … выдана»): достаточно отметки в системе и «Получил».
--   • приглашение к боту для людей без оклада — без слов «зарплата» и
--     «благодарность», только зачем бот (fin_payroll_invite_text_gift).
-- «Есть оклад» — как tracksBalance в fin-payroll.js: оклад указан или есть
-- хоть одно начисление.

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
  v_salaried boolean;
  v_m text[];
  v_body text;
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

  v_salaried := v_pos.salary_amount IS NOT NULL
    OR EXISTS (SELECT 1 FROM fin_payroll_accruals WHERE position_id = v_pos.id);

  IF v_salaried THEN
    -- «зарплата за октябрь выдана полностью» → месяц и «полностью/частично»;
    -- начислений ещё нет («выплата проведена») — без месяца
    v_m := regexp_match(fin_payroll_paid_phrase(v_pos.id), '^зарплата за (.+) выдана (\S+)$');
    v_body := E'Спасибо большое за ваше служение!\n\n'
      || CASE WHEN v_m IS NULL
              THEN format('💰 Ваша зарплата: <b>%s</b>', fin_fmt_money(v_amount, v_cur))
              ELSE format('💰 Ваша зарплата за %s: <b>%s</b> — выдана %s.',
                          v_m[1], fin_fmt_money(v_amount, v_cur), v_m[2]) END;
  ELSE
    v_body := E'Спасибо большое за ваше служение! В качестве благодарности примите, пожалуйста:\n\n'
      || format('💰 <b>%s</b>', fin_fmt_money(v_amount, v_cur));
  END IF;

  INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
  VALUES (v_tg,
    E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\n'
    || v_body
    || format(E'\nДепартамент: %s', tg_escape(v_dept))
    || format(E'\nДата: %s', to_char(v_on, 'DD.MM.YYYY'))
    || E'\n\nПожалуйста, нажмите «✅ Получил», если денежки у вас.',
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

CREATE OR REPLACE FUNCTION public.fin_pay_payroll(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

  -- Триггер на проводках молчит: о выплате в чат департамента не пишем (776),
  -- человеку — личное сообщение из триггера на fin_payroll_payments.
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

-- Приглашение к боту для людей без оклада: только зачем бот
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_invite_text_gift',
   E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\nТеперь получение денег от ШРСК подтверждается в Телеграм-боте ШРСК — это как роспись в ведомости, отметка о том, что денежки получены.\n\nЧтобы подключиться, откройте, пожалуйста, бота по ссылке и нажмите «Старт»:\n{link}\n\nБот пришлёт сумму и кнопку «✅ Получил» — нажмите её, пожалуйста. Сумму видите только вы, в общий чат она не попадает. Подключиться нужно один раз, дальше бот будет присылать такие сообщения сам.',
   E'Hare Krishna! Please accept my humble obeisances.\n\nReceipt of money from SRSK is now confirmed in the SRSK Telegram bot — it is like signing the payroll sheet, a note that the money has been received.\n\nTo connect, please open the bot using the link and press "Start":\n{link}\n\nThe bot will send the amount and a "✅ Получил" (Received) button — please press it. Only you see the amount, it is not posted in the group chat. You need to connect only once; after that the bot will send such messages automatically.',
   E'हरे कृष्ण! कृपया मेरा विनम्र प्रणाम स्वीकार करें।\n\nअब SRSK से पैसे की प्राप्ति SRSK टेलीग्राम बॉट में पुष्टि की जाती है — यह वेतन रजिस्टर पर हस्ताक्षर जैसा है, एक नोट कि पैसे मिल गए हैं।\n\nजुड़ने के लिए कृपया लिंक से बॉट खोलें और "Start" दबाएँ:\n{link}\n\nबॉट राशि और "✅ Получил" (प्राप्त हुआ) बटन भेजेगा — कृपया उसे दबाएँ। राशि केवल आप देखते हैं, यह सामान्य चैट में नहीं जाती। जुड़ना केवल एक बार है, इसके बाद बॉट ऐसे संदेश अपने आप भेजेगा।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
