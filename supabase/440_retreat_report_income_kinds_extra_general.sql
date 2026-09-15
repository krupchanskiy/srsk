-- Доп. услуги и «Общий» — тоже отдельными строками (ВГ, сен 2026): после
-- 437-й миграции «Оплата от участника» разбивалась на Оргвзнос/Проживание/
-- Питание, а платежи вида extra (доп. услуги) и general (без привязки к
-- блоку — например, совместная оплата на двоих одной суммой) молча падали
-- в тот же безымянный остаток «Оплата от участника». Теперь у них тоже
-- свои подписанные строки — деньги никуда не делись (система и так гасит
-- долг по приоритету при расчёте баланса участника), просто в отчёте по
-- ретриту это было не видно.
CREATE OR REPLACE FUNCTION fin_private_build_snapshot(p_object uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_obj fin_accounting_objects%ROWTYPE;
  v_parts jsonb := '[]'::jsonb;
  v_p record;
  v_bal jsonb;
  v_cnt int := 0;
  v_charged numeric := 0;
  v_paid numeric := 0;
  v_debt numeric := 0;
  v_advance numeric := 0;
  v_debtors jsonb := '[]'::jsonb;
  v_income jsonb;
  v_expense jsonb;
  v_income_base numeric;
  v_expense_base numeric;
  v_cafe_income jsonb;
  v_cafe_expense jsonb;
  v_cafe_income_base numeric;
  v_cafe_expense_base numeric;
  v_prasad_income jsonb;
  v_prasad_expense jsonb;
  v_prasad_income_base numeric;
  v_prasad_expense_base numeric;
BEGIN
  SELECT * INTO v_obj FROM fin_accounting_objects WHERE id = p_object;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
  END IF;

  IF v_obj.retreat_id IS NOT NULL THEN
    FOR v_p IN
      SELECT DISTINCT ids.pid FROM (
        SELECT participant_id AS pid FROM fin_charges WHERE retreat_id = v_obj.retreat_id
        UNION
        SELECT participant_id FROM fin_participant_opening_balances WHERE retreat_id = v_obj.retreat_id
        UNION
        SELECT p.participant_id FROM fin_postings p
        WHERE p.object_id = p_object AND p.participant_id IS NOT NULL
          AND p.participant_balance_kind IS NOT NULL AND p.participant_balance_kind <> 'none'
      ) ids
    LOOP
      v_bal := fin_private_participant_balance(v_p.pid, v_obj.retreat_id);
      v_cnt := v_cnt + 1;
      v_debt := v_debt + (v_bal->>'total_debt')::numeric;
      v_advance := v_advance + (v_bal->>'total_advance')::numeric;
      SELECT v_charged + COALESCE(SUM((v_bal->'blocks'->k->>'charged')::numeric), 0),
             v_paid    + COALESCE(SUM((v_bal->'blocks'->k->>'paid')::numeric), 0)
        INTO v_charged, v_paid
      FROM unnest(ARRAY['org_fee','accommodation','meals','extra']) k;
      IF (v_bal->>'net')::numeric > 0 THEN
        v_debtors := v_debtors || jsonb_build_array(jsonb_build_object(
          'participant_id', v_p.pid,
          'name', fin_private_person_name(v_p.pid),
          'debt', (v_bal->>'net')::numeric));
      END IF;
    END LOOP;
  END IF;

  -- приходы по статьям, с разбивкой «Оплаты от участника» на назначения
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.grp_id, 'name', x.grp_name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_income, v_income_base
  FROM (
    SELECT s.grp_id, s.grp_name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT
        CASE WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'org_fee' THEN 'org_fee'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'accommodation' THEN 'accommodation'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'meals' THEN 'meals'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'extra' THEN 'extra'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'general' THEN 'general'
             ELSE p.category_id::text END AS grp_id,
        CASE WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'org_fee' THEN 'Оргвзнос'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'accommodation' THEN 'Проживание'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'meals' THEN 'Питание'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'extra' THEN 'Доп. услуги'
             WHEN c.name = 'Оплата от участника' AND p.participant_balance_kind = 'general' THEN 'Без привязки к блоку'
             ELSE c.name END AS grp_name,
        p.currency_code,
        SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END) AS amt_signed,
        SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'in'
      GROUP BY grp_id, grp_name, p.currency_code
    ) s GROUP BY s.grp_id, s.grp_name
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_expense, v_expense_base
  FROM (
    SELECT s.category_id, s.name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT p.category_id, c.name, p.currency_code,
             SUM(CASE p.direction WHEN 'out' THEN p.amount ELSE -p.amount END) AS amt_signed,
             SUM(CASE p.direction WHEN 'out' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'out'
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_cafe_income, v_cafe_income_base
  FROM (
    SELECT s.category_id, s.name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT p.category_id, c.name, p.currency_code,
             SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END) AS amt_signed,
             SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'in' AND c.name = 'Касса кафе'
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_cafe_expense, v_cafe_expense_base
  FROM (
    SELECT s.category_id, s.name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT p.category_id, c.name, p.currency_code,
             SUM(CASE p.direction WHEN 'out' THEN p.amount ELSE -p.amount END) AS amt_signed,
             SUM(CASE p.direction WHEN 'out' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      JOIN fin_accounts a ON a.id = p.account_id
      WHERE p.object_id = p_object AND c.direction = 'out' AND a.name ILIKE '%кафе%'
        AND c.name NOT IN ('Прасад', 'Закупка готового Прасада')
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
  ) x;

  -- Приход прасада: пожертвования + «Питание» (см. пояснение выше)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.grp_id, 'name', x.grp_name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_prasad_income, v_prasad_income_base
  FROM (
    SELECT s.grp_id, s.grp_name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT
        CASE WHEN p.participant_balance_kind = 'meals' THEN 'meals' ELSE p.category_id::text END AS grp_id,
        CASE WHEN p.participant_balance_kind = 'meals' THEN 'Питание' ELSE c.name END AS grp_name,
        p.currency_code,
        SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END) AS amt_signed,
        SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'in'
        AND (c.name = 'Прасад - пожертвование' OR p.participant_balance_kind = 'meals')
      GROUP BY grp_id, grp_name, p.currency_code
    ) s GROUP BY s.grp_id, s.grp_name
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_prasad_expense, v_prasad_expense_base
  FROM (
    SELECT s.category_id, s.name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT p.category_id, c.name, p.currency_code,
             SUM(CASE p.direction WHEN 'out' THEN p.amount ELSE -p.amount END) AS amt_signed,
             SUM(CASE p.direction WHEN 'out' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'out' AND c.name IN ('Прасад', 'Закупка готового Прасада')
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
  ) x;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'object', jsonb_build_object('id', v_obj.id, 'display_name', v_obj.display_name, 'retreat_id', v_obj.retreat_id),
    'generated_at', now(),
    'participants', jsonb_build_object(
      'count', v_cnt, 'charged', v_charged, 'paid', v_paid,
      'debt_total', v_debt, 'advance_total', v_advance, 'debtors', v_debtors),
    'income_by_category', v_income,
    'expense_by_category', v_expense,
    'totals', jsonb_build_object(
      'income_base', v_income_base,
      'expense_base', v_expense_base,
      'net_base', v_income_base - v_expense_base),
    'cafe', jsonb_build_object(
      'income_by_category', v_cafe_income,
      'expense_by_category', v_cafe_expense,
      'totals', jsonb_build_object(
        'income_base', v_cafe_income_base,
        'expense_base', v_cafe_expense_base,
        'net_base', v_cafe_income_base - v_cafe_expense_base)),
    'prasad', jsonb_build_object(
      'income_by_category', v_prasad_income,
      'expense_by_category', v_prasad_expense,
      'totals', jsonb_build_object(
        'income_base', v_prasad_income_base,
        'expense_base', v_prasad_expense_base,
        'net_base', v_prasad_income_base - v_prasad_expense_base)),
    'cost_per_participant', NULL   -- открытый вопрос 2 ТЗ — не блокирует закрытие
  );
END;
$$;
