-- =============================================================
-- Payroll: выплаты идут по уже существующей статье «Оплата труда»
-- (dept_labor), а не по новой «Зарплата».
--
-- 438_fin_payroll.sql завёл отдельную статью «Зарплата», не заметив,
-- что в справочнике уже была «Оплата труда» — теми же вручную
-- заведёнными зарплатными расходами департаментов. Решение ВГ,
-- 16.09.2026: объединить в «Оплата труда», чтобы отчёт по департаменту
-- не показывал один и тот же вид расхода двумя разными строками.
--
-- Саму статью «Зарплата» не удаляем (на неё уже успела сослаться одна
-- проведённая выплата) — архивируем; существующая проводка переносится
-- на «Оплата труда» отдельным шагом через fin_update_posting_analytics
-- (обычная правка аналитики с аудит-следом, не прямой UPDATE).
-- =============================================================

CREATE OR REPLACE FUNCTION public.fin_pay_payroll(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_position fin_payroll_positions%ROWTYPE;
  v_amount numeric;
  v_on date;
  v_comment text;
  v_category uuid;
  v_account uuid;
  v_request_id uuid := gen_random_uuid();
  v_row_id uuid := gen_random_uuid();
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

  SELECT id INTO v_category FROM fin_categories WHERE code = 'dept_labor' AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = 'Статья «Оплата труда» не найдена в справочнике';
  END IF;

  v_account := fin_dept_account(v_position.department_id, v_position.currency_code);

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
    RETURN v_res;
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

-- «Зарплата» архивируется, а не удаляется — на неё уже ссылается
-- проведённая проводка (перенесённая на dept_labor отдельным шагом)
UPDATE fin_categories SET is_active = false WHERE code = 'salary';
