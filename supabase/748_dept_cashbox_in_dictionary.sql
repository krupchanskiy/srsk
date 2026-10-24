-- 748: «Касса ДДС у департамента» в карточке департамента в справочнике (ВГ 24.10).
-- Касса ДДС, которая хранится у департамента (мигр. 711), не числится за ним (department_id пуст),
-- поэтому в блоке «Счета департамента» её не было и недостающую валюту нельзя было завести самому.
--   • fin_v_account_balances: + cashbox_department_id (столбец в конце);
--   • fin_add_department_cashbox — завести кассу в нужной валюте: имя и держатель — как у уже
--     заведённой кассы этого департамента (иначе «Касса ДДС — <департамент>» и его держатель).

CREATE OR REPLACE VIEW public.fin_v_account_balances AS
 SELECT a.id AS account_id,
    a.name,
    a.kind,
    a.reconciliation_mode,
    a.currency_code,
    a.group_name,
    a.responsible_person_id,
    a.default_cost_center_id,
    a.is_active,
    COALESCE(s.balance, 0::numeric)::numeric(14,2) AS balance,
    s.last_ledger_seq,
    COALESCE(s.balance, 0::numeric) < 0::numeric AS is_negative,
    r.cutoff_ledger_seq AS last_checkpoint_seq,
    r.performed_at AS last_checkpoint_at,
    ( SELECT count(*) AS count
           FROM fin_postings p
          WHERE p.account_id = a.id AND p.ledger_seq > COALESCE(r.cutoff_ledger_seq, 0::bigint)) AS unreconciled_count,
    a.department_id,
    r.original_difference AS last_difference,
    a.cashbox_department_id
   FROM fin_accounts a
     LEFT JOIN ( SELECT fin_postings.account_id,
            sum(
                CASE fin_postings.direction
                    WHEN 'in'::fin_direction THEN fin_postings.amount
                    ELSE - fin_postings.amount
                END) AS balance,
            max(fin_postings.ledger_seq) AS last_ledger_seq
           FROM fin_postings
          GROUP BY fin_postings.account_id) s ON s.account_id = a.id
     LEFT JOIN LATERAL ( SELECT rr.cutoff_ledger_seq,
            rr.performed_at,
            rr.original_difference
           FROM fin_reconciliations rr
          WHERE rr.account_id = a.id
          ORDER BY rr.performed_at DESC, rr.cutoff_ledger_seq DESC
         LIMIT 1) r ON true
  WHERE fin_can_see_account(a.id);

-- единственный аргумент payload jsonb — как у всех fin_* (FinUtils.rpc заворачивает в payload, мигр. 368)
drop function if exists fin_add_department_cashbox(uuid, text);
create or replace function fin_add_department_cashbox(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  p_department uuid := nullif(payload->>'p_department', '')::uuid;
  p_currency text := nullif(payload->>'p_currency', '');
  v_dept_name text;
  v_symbol text;
  v_acc uuid;
  v_name text;
  v_prefix text;
  v_person uuid;
BEGIN
  IF NOT fin_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  END IF;
  SELECT name INTO v_dept_name FROM fin_departments WHERE id = p_department;
  IF v_dept_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Департамент не найден'));
  END IF;
  SELECT symbol INTO v_symbol FROM fin_currencies WHERE code = p_currency AND is_active;
  IF v_symbol IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Валюта не найдена'));
  END IF;

  -- идемпотентна: вернёт существующую кассу, если она уже заведена
  SELECT id, name INTO v_acc, v_name FROM fin_accounts
   WHERE cashbox_department_id = p_department AND currency_code = p_currency AND is_active;
  IF v_acc IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('account_id', v_acc, 'name', v_name));
  END IF;

  -- имя и держатель — как у уже заведённой кассы департамента («Касса ДДС у ГХ»)
  SELECT regexp_replace(name, '\s*\([^)]*\)\s*$', ''), responsible_person_id INTO v_prefix, v_person
    FROM fin_accounts WHERE cashbox_department_id = p_department AND is_active
   ORDER BY created_at LIMIT 1;
  IF v_prefix IS NULL THEN
    v_prefix := 'Касса ДДС — ' || v_dept_name;
    SELECT vaishnava_id INTO v_person FROM fin_department_holders
     WHERE department_id = p_department AND is_active ORDER BY created_at LIMIT 1;
  END IF;
  v_name := v_prefix || ' (' || v_symbol || ')';
  IF EXISTS (SELECT 1 FROM fin_accounts WHERE name = v_name AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'account_name_taken', 'message', 'Активный счёт «' || v_name || '» уже существует'));
  END IF;

  INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name,
                            responsible_person_id, cashbox_department_id, created_by)
  VALUES (v_name, 'real', 'cash_count', p_currency, 'Касса', v_person, p_department, fin_actor())
  RETURNING id INTO v_acc;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('account_id', v_acc, 'name', v_name));
END;
$$;
revoke all on function fin_add_department_cashbox(jsonb) from public, anon;
grant execute on function fin_add_department_cashbox(jsonb) to authenticated;

comment on function fin_add_department_cashbox(jsonb) is
  'Завести кассу ДДС, которая хранится у департамента, в указанной валюте. Идемпотентна.';

insert into translations (key, ru, en, hi, page) values
  ('fin_dept_cashbox', 'Касса ДДС у департамента', 'Main cash held by department', 'विभाग के पास मुख्य नकद', 'Справочники'),
  ('fin_dept_no_cashbox', 'Кассы ДДС у департамента нет', 'No main cash held by this department', 'विभाग के पास मुख्य नकद नहीं', 'Справочники'),
  ('fin_dept_add_cashbox', 'Завести кассу', 'Add cash account', 'नकद खाता जोड़ें', 'Справочники'),
  ('fin_dept_cashbox_added', 'Касса заведена', 'Cash account created', 'नकद खाता बन गया', 'Справочники')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
