-- =============================================================
-- Payroll: исправление даты начала позиции без истории.
--
-- Форма быстрого добавления сотрудника (438_fin_payroll.sql) не имела
-- поля «действует с» — effective_from всегда молча ставился сегодняшним
-- числом. При заведении человека задним числом (типичный кейс: выдали
-- зарплату, а в систему занесли только сейчас) дата получалась неверной,
-- и начисление за прошлые месяцы не могло сработать вообще — обратного
-- пути через обычную правку не было: fin_save_payroll_position требовал
-- новую дату строго ПОЗЖЕ текущей (это защищает уже посчитанную историю
-- от искажения задним числом).
--
-- Это верно только когда по позиции уже есть начисления или выплаты —
-- тогда правка это реальное событие «второго рода», и должна идти через
-- закрытие+новую запись с датой вперёд. Если же по позиции ещё вообще
-- ничего не посчитано (типичный случай — только что завели с неверной
-- датой), это просто опечатка при вводе, а не история: правим её на
-- месте, включая дату в любую сторону, без создания новой записи.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fin_save_payroll_position(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_cur fin_payroll_positions%ROWTYPE;
  v_vaishnava uuid;
  v_department uuid;
  v_title text;
  v_salary numeric;
  v_currency text;
  v_from date;
  v_has_history boolean;
  v_new_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY[
    'id', 'vaishnava_id', 'department_id', 'position_title', 'salary_amount', 'currency_code', 'effective_from'
  ]);

  v_id         := fin_private_get_uuid(payload, 'id', false);
  v_vaishnava  := fin_private_get_uuid(payload, 'vaishnava_id', true);
  v_department := fin_private_get_uuid(payload, 'department_id', true);
  v_title      := NULLIF(btrim(COALESCE(payload->>'position_title', '')), '');
  v_currency   := COALESCE(NULLIF(payload->>'currency_code', ''), 'INR');
  v_from       := COALESCE(fin_private_get_date(payload, 'effective_from', false), current_date);
  v_salary     := CASE WHEN NULLIF(payload->>'salary_amount', '') IS NULL
                        THEN NULL ELSE fin_private_get_money(payload, 'salary_amount', false) END;

  IF v_title IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Должность обязательна';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_vaishnava) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Человек не найден в справочнике людей';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = v_department) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Департамент не найден';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_currencies WHERE code = v_currency AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Валюта не найдена';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM fin_payroll_positions WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
    END IF;
    IF v_cur.effective_to IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Эта запись уже закрыта — заведите новую позицию';
    END IF;

    v_has_history := EXISTS (SELECT 1 FROM fin_payroll_accruals WHERE position_id = v_id)
                   OR EXISTS (SELECT 1 FROM fin_payroll_payments WHERE position_id = v_id);

    IF NOT v_has_history THEN
      -- по позиции ещё ничего не посчитано — правим на месте, дата может
      -- двигаться в любую сторону (это просто исправление ввода)
      UPDATE fin_payroll_positions
         SET vaishnava_id = v_vaishnava, department_id = v_department, position_title = v_title,
             salary_amount = v_salary, currency_code = v_currency, effective_from = v_from
       WHERE id = v_id
      RETURNING id INTO v_new_id;
    ELSE
      -- уже есть начисления или выплаты — это реальное изменение, дата
      -- только вперёд, историю не переписываем (как раньше)
      IF v_from <= v_cur.effective_from THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дата изменения должна быть позже даты начала текущей записи';
      END IF;
      UPDATE fin_payroll_positions SET effective_to = v_from - 1 WHERE id = v_id;
      INSERT INTO fin_payroll_positions
        (vaishnava_id, department_id, position_title, salary_amount, currency_code, effective_from, created_by)
      VALUES (v_vaishnava, v_department, v_title, v_salary, v_currency, v_from, fin_actor())
      RETURNING id INTO v_new_id;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM fin_payroll_positions
               WHERE vaishnava_id = v_vaishnava AND department_id = v_department AND effective_to IS NULL) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'У этого человека уже есть действующая позиция в этом департаменте';
    END IF;
    INSERT INTO fin_payroll_positions
      (vaishnava_id, department_id, position_title, salary_amount, currency_code, effective_from, created_by)
    VALUES (v_vaishnava, v_department, v_title, v_salary, v_currency, v_from, fin_actor())
    RETURNING id INTO v_new_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_new_id));
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
