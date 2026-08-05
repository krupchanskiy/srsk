-- Счёт списания в карточке расхода из чата.
--
-- Просьба ВГ (05.08.2026): «в карточке, когда кто-то пишет расход, указать
-- дополнительно счёт, откуда списывается». Раньше расход всегда уходил с
-- подотчёта департамента-автора (`fin_dept_account`), и случай «потратил, но
-- деньги брал из кассы» записать было нечем.
--
-- Два других пункта его просьбы уже работали и правки не потребовали:
-- департамент-получатель (селект «— свой —») и галочка «учесть как расход
-- сразу». Галочка была скрыта до выбора департамента, поэтому о ней не знали —
-- теперь она видна всегда, но погашена, пока департамент не выбран.
--
-- Функция пропатчена программно (`pg_get_functiondef` + `replace`), а не
-- переписана руками: тело на 350 строк, ручная копия — гарантированная опечатка.
-- Ниже зафиксировано, ЧТО именно изменено; актуальное тело всегда в базе:
--   SELECT pg_get_functiondef('tg_post_draft(uuid,jsonb,uuid)'::regprocedure);
--
-- Сигнатура: tg_post_draft(p_id, p_rows) → tg_post_draft(p_id, p_rows, p_source_account)
-- Старая двухпараметрическая удалена, иначе вызовы с двумя аргументами
-- продолжали бы попадать в неё мимо нового параметра.
--
-- Заменённый фрагмент (ветка расхода):
--   БЫЛО: v_acc := fin_dept_account(v_d.department_id, v_d.currency);
--   СТАЛО: приоритет — указанный казначеем счёт, затем сохранённый в заявке,
--          затем подотчёт департамента; валюта счёта обязана совпасть с заявкой.

do $patch$
declare v_def text;
begin
  -- идемпотентность: если параметр уже есть, патчить нечего
  if exists (select 1 from pg_proc
              where proname = 'tg_post_draft'
                and pg_get_function_arguments(oid) like '%p_source_account%') then
    return;
  end if;

  v_def := pg_get_functiondef('tg_post_draft(uuid,jsonb)'::regprocedure);

  v_def := replace(v_def,
    'tg_post_draft(p_id uuid, p_rows jsonb)',
    'tg_post_draft(p_id uuid, p_rows jsonb, p_source_account uuid DEFAULT NULL::uuid)');

  v_def := replace(v_def,
    'v_acc := fin_dept_account(v_d.department_id, v_d.currency);',
    $body$IF COALESCE(p_source_account, v_d.source_account_id) IS NOT NULL THEN
        v_acc := COALESCE(p_source_account, v_d.source_account_id);
        IF (SELECT currency_code FROM fin_accounts WHERE id = v_acc) IS DISTINCT FROM v_d.currency THEN
          RAISE EXCEPTION 'chat_post_failed' USING DETAIL = 'Валюта счёта не совпадает с валютой заявки';
        END IF;
      ELSE
        v_acc := fin_dept_account(v_d.department_id, v_d.currency);
      END IF;$body$);

  execute v_def;
end $patch$;

drop function if exists tg_post_draft(uuid, jsonb);

-- Дефолтный грант PUBLIC пускает anon: закрываем, как принято в проекте
revoke all on function tg_post_draft(uuid, jsonb, uuid) from public, anon;
grant execute on function tg_post_draft(uuid, jsonb, uuid) to authenticated, service_role;

-- Переводы
insert into translations (key, ru, en, hi, page) values
  ('fin_split_source', 'Списать со счёта', 'Pay from account', 'खाते से भुगतान', 'inbox'),
  ('fin_split_as_expense_hint',
   'Доступно, когда выбран департамент: трата сразу станет его расходом, а не повиснет остатком',
   'Available once a department is chosen: the spend becomes their expense instead of sitting as a balance',
   'विभाग चुनने पर उपलब्ध', 'inbox')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;

-- Подпись своего счёта в селекте: «Ашиш (₹) — свой подотчёт».
-- Прежний ключ fin_split_dept_own = «— свой —» давал двойное тире.
insert into translations (key, ru, en, hi, page) values
  ('fin_split_own_account', 'свой подотчёт', 'own float', 'अपना खाता', 'inbox')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
