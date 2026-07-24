-- Департаменты могут держать деньги в разных валютах (пожертвование в $
-- на поклонение, билет за ₽, и т.д.). Модель — как у подушки: департамент
-- это НАБОР подотчётных счетов, по одному на валюту. Счёт нужной валюты
-- создаётся сам при первой трате в ней (fin_dept_account).

CREATE TABLE IF NOT EXISTS fin_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  responsible_person_id uuid REFERENCES vaishnavas(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin_departments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_departments FROM PUBLIC, anon;
DROP POLICY IF EXISTS "Departments read fin" ON fin_departments;
CREATE POLICY "Departments read fin" ON fin_departments
  FOR SELECT TO authenticated USING (fin_can_read_all((SELECT auth.uid())));

ALTER TABLE fin_accounts ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES fin_departments(id);
COMMENT ON COLUMN fin_accounts.department_id IS
'Подотчётный счёт принадлежит департаменту. У департамента по одному счёту на валюту.';

-- Департаменты из уже заведённых 9 подотчётных счетов + переименование
-- «Кухня» → «Кухня (₹)» (валюта в имени, как у подушки и реальных счетов).
DO $$
DECLARE r record; v_dept uuid;
BEGIN
  FOR r IN SELECT id, name, responsible_person_id, currency_code
           FROM fin_accounts WHERE group_name = 'Подотчёты департаментов' AND department_id IS NULL
  LOOP
    INSERT INTO fin_departments (name, responsible_person_id)
    VALUES (r.name, r.responsible_person_id)
    ON CONFLICT (name) DO UPDATE SET responsible_person_id = EXCLUDED.responsible_person_id
    RETURNING id INTO v_dept;

    UPDATE fin_accounts
    SET department_id = v_dept,
        name = r.name || ' (' || CASE r.currency_code
                 WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                 WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€' ELSE r.currency_code END || ')'
    WHERE id = r.id;
  END LOOP;
END $$;

-- ОП (все валюты) и личный счёт Олега (рупии) — базовый ₹-счёт,
-- остальные валюты добавятся сами по мере надобности.
DO $$
DECLARE v_op uuid; v_oleg uuid; v_creator uuid := '2160b531-4e37-4d2a-ba46-cc1ee230cfeb';
BEGIN
  INSERT INTO fin_departments (name, responsible_person_id)
  VALUES ('Отдел продаж', 'e5b63859-94d7-4c80-aba8-d98ec9a6eb27')
  ON CONFLICT (name) DO NOTHING RETURNING id INTO v_op;
  IF v_op IS NULL THEN SELECT id INTO v_op FROM fin_departments WHERE name='Отдел продаж'; END IF;

  INSERT INTO fin_departments (name, responsible_person_id)
  VALUES ('Олег Карпов (личный)', 'e5b63859-94d7-4c80-aba8-d98ec9a6eb27')
  ON CONFLICT (name) DO NOTHING RETURNING id INTO v_oleg;
  IF v_oleg IS NULL THEN SELECT id INTO v_oleg FROM fin_departments WHERE name='Олег Карпов (личный)'; END IF;

  INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name, department_id, responsible_person_id, is_active, created_by)
  SELECT 'Отдел продаж (₹)', 'custodial', 'cash_count', 'INR', 'Подотчёты департаментов', v_op, 'e5b63859-94d7-4c80-aba8-d98ec9a6eb27', true, v_creator
  WHERE NOT EXISTS (SELECT 1 FROM fin_accounts WHERE department_id=v_op AND currency_code='INR');

  INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name, department_id, responsible_person_id, is_active, created_by)
  SELECT 'Олег Карпов (₹)', 'custodial', 'cash_count', 'INR', 'Подотчёты департаментов', v_oleg, 'e5b63859-94d7-4c80-aba8-d98ec9a6eb27', true, v_creator
  WHERE NOT EXISTS (SELECT 1 FROM fin_accounts WHERE department_id=v_oleg AND currency_code='INR');
END $$;

-- Получить-или-создать подотчётный счёт департамента в нужной валюте.
-- Вызывается при проведении заявки: если валюты ещё не было — счёт
-- рождается сам, пустой, и на него ложится операция.
CREATE OR REPLACE FUNCTION public.fin_dept_account(p_department uuid, p_currency text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_dept fin_departments%ROWTYPE;
  v_sym text;
BEGIN
  SELECT id INTO v_id FROM fin_accounts
  WHERE department_id = p_department AND currency_code = p_currency AND kind = 'custodial';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT * INTO v_dept FROM fin_departments WHERE id = p_department;
  IF NOT FOUND THEN RAISE EXCEPTION 'department_not_found'; END IF;

  v_sym := CASE p_currency WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
             WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€' ELSE p_currency END;
  INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name,
                            department_id, responsible_person_id, is_active, created_by)
  VALUES (v_dept.name || ' (' || v_sym || ')', 'custodial', 'cash_count', p_currency,
          'Подотчёты департаментов', p_department, v_dept.responsible_person_id, true,
          COALESCE(auth.uid(), '2160b531-4e37-4d2a-ba46-cc1ee230cfeb'))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_dept_account(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_dept_account(uuid, text) TO service_role;

-- Привязки бота теперь ссылаются на департамент, не на конкретный счёт
ALTER TABLE tg_chat_links DROP COLUMN IF EXISTS account_id;
ALTER TABLE tg_chat_links ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES fin_departments(id);

ALTER TABLE tg_drafts DROP COLUMN IF EXISTS account_id;
ALTER TABLE tg_drafts DROP COLUMN IF EXISTS target_account_id;
ALTER TABLE tg_drafts ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES fin_departments(id);
ALTER TABLE tg_drafts ADD COLUMN IF NOT EXISTS target_department_id uuid REFERENCES fin_departments(id);
