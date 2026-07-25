-- Гонка при автосоздании подотчётного счёта в новой валюте.
--
-- fin_dept_account делал SELECT, потом INSERT. Два одновременных проведения
-- заявок в валюте, которой у департамента ещё нет, шли в INSERT оба. Дубля не
-- возникало — спасала уникальность имени активного счёта, — но проигравший
-- получал «duplicate key value violates unique constraint» вместо счёта, и
-- заявка оставалась непроведённой с невнятной ошибкой.
-- Проверено двумя параллельными соединениями: второй блокировался и падал.
--
-- Исправление: ловим нарушение уникальности и перечитываем счёт — победитель
-- его уже создал. Плюс блокировка на департамент, чтобы обычный случай не
-- доходил до конфликта вообще.
CREATE OR REPLACE FUNCTION fin_dept_account(p_department uuid, p_currency text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
  v_dept fin_departments%ROWTYPE;
  v_sym text;
BEGIN
  SELECT id INTO v_id FROM fin_accounts
  WHERE department_id = p_department AND currency_code = p_currency AND kind = 'custodial';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT * INTO v_dept FROM fin_departments WHERE id = p_department FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'department_not_found'; END IF;

  -- под блокировкой перечитываем: соперник мог успеть создать счёт
  SELECT id INTO v_id FROM fin_accounts
  WHERE department_id = p_department AND currency_code = p_currency AND kind = 'custodial';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  v_sym := CASE p_currency WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
             WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€' ELSE p_currency END;
  BEGIN
    INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name,
                              department_id, responsible_person_id, is_active, created_by)
    VALUES (v_dept.name || ' (' || v_sym || ')', 'custodial', 'cash_count', p_currency,
            'Подотчёты департаментов', p_department, v_dept.responsible_person_id, true,
            COALESCE(auth.uid(), '2160b531-4e37-4d2a-ba46-cc1ee230cfeb'))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- соперник закоммитился между нашей проверкой и вставкой: берём его счёт
    SELECT id INTO v_id FROM fin_accounts
    WHERE department_id = p_department AND currency_code = p_currency AND kind = 'custodial';
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM fin_accounts
      WHERE name = v_dept.name || ' (' || v_sym || ')' AND is_active;
    END IF;
    IF v_id IS NULL THEN RAISE; END IF;
  END;
  RETURN v_id;
END;
$$;
