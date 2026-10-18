-- 709: «выдано на сдачу» не только у Кафе, но и у Магазина (ВГ 18.10).
-- Как у Кафе (693/694/696): сдача — деньги на счёте департамента НИ НА КОГО из держателей.
-- Приход кассы может вычесть сдачу: доходом идёт остаток, сдача переводом возвращается
-- со счёта департамента туда, куда сдали кассу.
-- У Магазина держателей не было — тогда «ни на кого» = все его деньги, и сдачу не отличить
-- от денег на закупку. Поэтому держатель Магазина — Тарангини (глава): закупочные деньги
-- на ней, сдача — ни на кого. Выдача 05.10 «матаджи Тарангини 20 000 на закупку» — на неё.

alter table fin_departments add column if not exists change_float boolean not null default false;
comment on column fin_departments.change_float is 'Есть «выдано на сдачу» (касса с разменом): Кафе, Магазин';
update fin_departments set change_float = true where code in ('cafe', 'shop') and not change_float;

-- подотчётный счёт департамента в валюте — туда выдаётся и оттуда возвращается сдача
create or replace function fin_private_float_account(p_department uuid, p_currency text)
returns uuid
language sql stable security definer set search_path to 'public'
as $$
  select a.id from fin_accounts a
   where a.department_id = p_department
     and a.kind = 'custodial' and a.is_active and a.currency_code = p_currency
   limit 1;
$$;
revoke execute on function fin_private_float_account(uuid, text) from public, anon, authenticated;

create or replace function fin_private_cafe_float_account(p_currency text)
returns uuid
language sql stable security definer set search_path to 'public'
as $$ select fin_private_float_account(fin_private_cafe_department(), p_currency) $$;

-- сколько сейчас выдано на сдачу (остаток без держателя на счёте департамента)
create or replace function fin_department_float(p_department uuid, p_currency text default 'INR')
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not fin_can_read_all(auth.uid()) then return null; end if;
  return (select coalesce(sum(case p.direction when 'in' then p.amount else -p.amount end), 0)
            from fin_postings p
           where p.account_id = fin_private_float_account(p_department, p_currency)
             and p.holder_person_id is null);
end;
$$;
revoke execute on function fin_department_float(uuid, text) from public, anon;
grant execute on function fin_department_float(uuid, text) to authenticated;

create or replace function fin_cafe_float(p_currency text default 'INR')
returns numeric
language sql stable security definer set search_path to 'public'
as $$ select fin_department_float(fin_private_cafe_department(), p_currency) $$;

-- приход кассы с вычетом сдачи: float_department_id — чья сдача (по умолчанию Кафе, как раньше)
CREATE OR REPLACE FUNCTION public.fin_create_cafe_collection(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_float numeric := COALESCE(NULLIF(payload->>'cafe_float', '')::numeric, 0);
  v_target uuid := NULLIF(payload->>'float_account_id', '')::uuid;
  v_dept uuid := COALESCE(NULLIF(payload->>'float_department_id', '')::uuid, fin_private_cafe_department());
  v_income jsonb := payload - 'cafe_float' - 'float_account_id' - 'float_department_id';
  v_dept_name text;
  v_cur text; v_src uuid; v_have numeric;
  v_res jsonb; v_tr jsonb; v_msg text;
BEGIN
  IF v_float < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload',
      'message', 'Сдача не может быть отрицательной'));
  END IF;
  SELECT name INTO v_dept_name FROM fin_departments WHERE id = v_dept AND change_float;
  IF v_float > 0 AND v_dept_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload',
      'message', 'У этого департамента нет выдачи на сдачу'));
  END IF;

  BEGIN
    IF jsonb_array_length(COALESCE(v_income->'rows', '[]'::jsonb)) > 0 THEN
      v_res := fin_create_income(v_income);
      IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN RETURN v_res; END IF;
    END IF;

    IF v_float > 0 THEN
      SELECT currency_code INTO v_cur FROM fin_accounts WHERE id = v_target AND is_active;
      IF v_cur IS NULL THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = 'Не указан счёт, куда сдана сдача';
      END IF;
      v_src := fin_private_float_account(v_dept, v_cur);
      IF v_src IS NULL THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = format('У департамента «%s» нет подотчётного счёта в %s', v_dept_name, v_cur);
      END IF;
      SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) INTO v_have
        FROM fin_postings WHERE account_id = v_src AND holder_person_id IS NULL;
      IF round(v_float, 2) > round(v_have, 2) THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL =
          format('У «%s» выдано на сдачу %s, а указано %s', v_dept_name, fin_fmt_money(v_have, v_cur), fin_fmt_money(v_float, v_cur));
      END IF;

      PERFORM set_config('tg.suppress_chat_notify', '1', true);
      v_tr := fin_create_transfer(jsonb_build_object(
        'request_id', fin_private_child_uuid((payload->>'request_id')::uuid, 'cafe-float-return'),
        'occurred_on', payload->>'occurred_on',
        'source_account_id', v_src, 'target_account_id', v_target,
        'source_amount', v_float, 'target_amount', v_float,
        'comment', format('Возврат сдачи — сдана вместе с кассой «%s»', v_dept_name)
                   || COALESCE(' · ' || NULLIF(btrim(payload->>'comment'), ''), '')));
      PERFORM set_config('tg.suppress_chat_notify', '', true);
      IF NOT COALESCE((v_tr->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = COALESCE(v_tr#>>'{error,message}', 'не удалось вернуть сдачу');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'cafe_float',
      'message', COALESCE(NULLIF(v_msg, ''), SQLERRM)));
  END;

  RETURN COALESCE(v_res, v_tr);
END;
$function$;

-- /баланс: строка без держателя у департаментов со сдачей — «выдано на сдачу»
CREATE OR REPLACE FUNCTION public.tg_department_balance(p_chat bigint)
 RETURNS TABLE(department_name text, balance numeric, currency_code text, pending_drafts integer, formatted text, holders_line text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_dept uuid;
BEGIN
  SELECT l.department_id INTO v_dept FROM tg_chat_links l
   WHERE l.chat_id = p_chat AND l.is_active;
  IF v_dept IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT d.name::text,
         COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)::numeric,
         a.currency_code::text,
         (SELECT count(*)::int FROM tg_drafts dr
           WHERE dr.department_id = v_dept AND dr.status = 'pending'),
         fin_fmt_money(COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0),
                       a.currency_code)::text,
         (SELECT string_agg(
                   format('  — %s: %s', tg_escape(h.label), fin_fmt_money(h.amt, a.currency_code)),
                   E'\n' ORDER BY h.amt DESC)
            FROM (
              SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                              NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                              CASE WHEN d.change_float THEN 'выдано на сдачу' ELSE 'не привязано' END) AS label,
                     SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) AS amt
                FROM fin_postings p2
                LEFT JOIN vaishnavas v ON v.id = p2.holder_person_id
               WHERE p2.account_id = a.id
                 AND (p2.holder_person_id IS NOT NULL
                      OR EXISTS (SELECT 1 FROM fin_department_holders fh WHERE fh.department_id = v_dept AND fh.is_active))
               GROUP BY v.spiritual_name, v.first_name, v.last_name, p2.holder_person_id
              HAVING SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) <> 0
            ) h)
  FROM fin_accounts a
  JOIN fin_departments d ON d.id = a.department_id
  LEFT JOIN fin_postings p ON p.account_id = a.id
  WHERE a.department_id = v_dept AND a.kind = 'custodial' AND a.is_active
  GROUP BY d.name, d.change_float, a.currency_code, a.id;
END;
$function$;

-- держатель Магазина — Тарангини (глава департамента)
insert into fin_department_holders (department_id, vaishnava_id, is_active)
select d.id, d.responsible_person_id, true
  from fin_departments d
 where d.code = 'shop' and d.responsible_person_id is not null
   and not exists (select 1 from fin_department_holders h where h.department_id = d.id and h.vaishnava_id = d.responsible_person_id);

-- выдача 05.10 «Выдал матаджи Тарангини 20 000 рупий на закупку» — на Тарангини, а не на сдачу
update fin_postings p
   set holder_person_id = (select responsible_person_id from fin_departments where code = 'shop')
 where p.id = '039cda68-2787-ee47-e189-4f5ae00ba457' and p.holder_person_id is null;
