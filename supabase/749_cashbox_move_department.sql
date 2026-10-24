-- 749: кассу ДДС можно передать другому департаменту или открепить (ВГ 24.10).
-- В карточке департамента в справочнике: «Привязать» — выбрать наличную кассу ДДС
-- (в т.ч. хранящуюся у другого департамента), «✕» — открепить (снова просто касса ДДС).
-- Меняется только место хранения; название и держатель правятся на странице «Счета».

-- единственный аргумент payload jsonb — как у всех fin_* (FinUtils.rpc заворачивает в payload, мигр. 368)
drop function if exists fin_set_account_cashbox_department(uuid, uuid);
create or replace function fin_set_account_cashbox_department(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  p_account uuid := nullif(payload->>'p_account', '')::uuid;
  p_department uuid := nullif(payload->>'p_department', '')::uuid;
  v_acc fin_accounts%rowtype;
BEGIN
  IF NOT fin_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = p_account AND is_active;
  IF v_acc.id IS NULL OR v_acc.kind <> 'real' OR v_acc.reconciliation_mode <> 'cash_count' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Привязать можно только активную наличную кассу ДДС'));
  END IF;
  IF p_department IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = p_department) THEN
      RETURN jsonb_build_object('ok', false, 'error',
        jsonb_build_object('code', 'invalid_payload', 'message', 'Департамент не найден'));
    END IF;
    IF EXISTS (SELECT 1 FROM fin_accounts WHERE cashbox_department_id = p_department AND is_active
                AND currency_code = v_acc.currency_code AND id <> p_account) THEN
      RETURN jsonb_build_object('ok', false, 'error',
        jsonb_build_object('code', 'invalid_payload', 'message', 'У департамента уже есть касса ДДС в этой валюте — сначала открепите её'));
    END IF;
  END IF;

  UPDATE fin_accounts SET cashbox_department_id = p_department WHERE id = p_account;
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('account_id', p_account));
END;
$$;
revoke all on function fin_set_account_cashbox_department(jsonb) from public, anon;
grant execute on function fin_set_account_cashbox_department(jsonb) to authenticated;

comment on function fin_set_account_cashbox_department(jsonb) is
  'Передать кассу ДДС на хранение департаменту (null — открепить). Одна касса на валюту у департамента.';

insert into translations (key, ru, en, hi, page) values
  ('fin_dept_attach_cashbox', 'Привязать', 'Attach', 'जोड़ें', 'Справочники'),
  ('fin_dept_cashbox_now_at', 'сейчас у', 'now at', 'अभी', 'Справочники'),
  ('fin_dept_detach_cashbox_confirm', 'Открепить кассу «{name}» от департамента? Она останется кассой ДДС.',
   'Detach «{name}» from the department? It stays a main cash account.', '«{name}» को विभाग से अलग करें?', 'Справочники'),
  ('fin_dept_cashbox_moved', 'Касса привязана', 'Cash account attached', 'नकद खाता जोड़ा गया', 'Справочники'),
  ('fin_dept_cashbox_detached', 'Касса откреплена', 'Cash account detached', 'नकद खाता अलग किया गया', 'Справочники')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
