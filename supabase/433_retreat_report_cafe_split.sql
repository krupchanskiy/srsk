-- Касса кафе отдельным блоком в живом отчёте по ретриту (ВГ, сен 2026):
-- кафе — самостоятельная единица внутри ретрита, в приходах/расходах самого
-- ретрита её не показываем построчно, но в общий итог (totals) она по-прежнему
-- входит — просто теперь виден и её собственный вклад отдельно.
--
-- Признак «это касса кафе» — тот же, что уже используется в подсказке ретрита
-- при вводе операций (js/fin-utils.js): приход — по статье «Касса кафе»,
-- расход — по счёту с «кафе» в названии (отдельного кост-центра «Кафе»
-- в справочнике сейчас нет).
--
-- Существующие поля (income_by_category/expense_by_category/totals) не
-- меняются — только добавляется новый ключ 'cafe'. Сверено на реальных
-- данных Сева-ретрита: totals до и после правки совпадают побайтово.
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
BEGIN
  SELECT * INTO v_obj FROM fin_accounting_objects WHERE id = p_object;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
  END IF;

  -- участники (для ретритных объектов)
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
      -- charged/paid суммарно по блокам
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

  -- приходы/расходы по статьям (signed: сторно гасит исходную; имена
  -- зафиксированы текстом на момент расчёта)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_income, v_income_base
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
      WHERE p.object_id = p_object AND c.direction = 'in'
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
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

  -- Касса кафе отдельным блоком (та же выборка, что и выше, но только
  -- касса-кафе-проводки) — складывается с остальным в totals, не отдельно
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
    'cost_per_participant', NULL   -- открытый вопрос 2 ТЗ — не блокирует закрытие
  );
END;
$$;
