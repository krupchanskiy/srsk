-- Счета департамента заводятся из карточки департамента.
--
-- Случай ВГ (05.08.2026): он создал счёт «Стройка (₹)» на странице «Счета»,
-- а в передаче денег он не появился — там выбирается ДЕПАРТАМЕНТ, и счёт был
-- ни к какому не привязан. Указать департамент в форме счёта нельзя: поля нет
-- ни в форме, ни в RPC. Подотчётные счета до сих пор рождались только сами,
-- при первой операции департамента.
--
-- Решение ВГ: «лучше добавить возможность создавать департаменты и добавлять
-- счёт». Департаменты создаются в Справочниках и раньше (кнопка «Добавить»),
-- а вот счёт теперь добавляется прямо в карточке департамента — там же, где
-- ответственный и чат.
--
-- Создание идёт через существующую fin_dept_account: она идемпотентна и
-- возвращает уже существующий счёт, если он есть. Наружу отдаём обёртку с
-- проверкой прав: сама fin_dept_account закрыта от authenticated намеренно.

create or replace function fin_add_department_account(p_department uuid, p_currency text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  v_acc uuid;
  v_name text;
BEGIN
  IF NOT fin_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = p_department) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Департамент не найден'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_currencies WHERE code = p_currency AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Валюта не найдена'));
  END IF;

  -- идемпотентна: вернёт существующий счёт, если он уже заведён
  v_acc := fin_dept_account(p_department, p_currency);
  SELECT name INTO v_name FROM fin_accounts WHERE id = v_acc;

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('account_id', v_acc, 'name', v_name));
END;
$$;

revoke all on function fin_add_department_account(uuid, text) from public, anon;
grant execute on function fin_add_department_account(uuid, text) to authenticated;

comment on function fin_add_department_account(uuid, text) is
  'Завести подотчётный счёт департамента в указанной валюте. Идемпотентна: существующий счёт возвращается как есть.';

insert into translations (key, ru, en, hi, page) values
  ('fin_dept_accounts', 'Счета департамента', 'Department accounts', 'विभाग के खाते', 'Справочники'),
  ('fin_dept_add_account', 'Завести счёт', 'Add account', 'खाता जोड़ें', 'Справочники'),
  ('fin_dept_no_accounts', 'Счетов пока нет — заведите в нужной валюте',
   'No accounts yet — add one in the currency you need', 'अभी कोई खाता नहीं', 'Справочники'),
  ('fin_dept_account_added', 'Счёт заведён', 'Account created', 'खाता बन गया', 'Справочники')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
