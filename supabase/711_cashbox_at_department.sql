-- 711: «Касса ДДС у ГХ» — временная касса отдельно от денег департамента (ВГ 19.10).
-- Гест-хаус принимает деньги за ВГ, пока его нет: выручку кафе и магазина, оплаты гостей,
-- выдаёт размен кафе, хранит резерв. Это не деньги Гест-хауса и не его траты, поэтому:
--   • fin_accounts.cashbox_department_id — касса ДДС, которая физически лежит у департамента
--     (у кассы нет department_id: в отчёт по департаментам она не попадает);
--   • fin_postings.is_transit — прошлые операции временной кассы на счёте самого департамента
--     (до появления отдельной кассы); на странице департамента их нет в «Подотчёте».
-- Касса видна на странице департамента отдельной вкладкой и в /баланс чата департамента
-- вместе с его счётом и общим итогом — так удобно сверять с деньгами в сейфе.

alter table fin_accounts add column if not exists cashbox_department_id uuid references fin_departments(id);
comment on column fin_accounts.cashbox_department_id is 'Касса ДДС, которая хранится у департамента (Касса ДДС у ГХ)';
alter table fin_postings add column if not exists is_transit boolean not null default false;
comment on column fin_postings.is_transit is 'Операция временной кассы на счёте департамента (деньги не департамента)';

-- лента: + is_transit (столбец в конце — представление пересоздаётся без смены прежних)
CREATE OR REPLACE VIEW fin_v_account_ledger AS
 SELECT p.id AS posting_id,
    p.ledger_seq,
    p.operation_id,
    o.type,
    o.approval,
    o.is_reversed,
    o.occurred_on,
    o.created_at,
        CASE
            WHEN v_hidden.hidden THEN 'Перевод'::text
            ELSE o.comment
        END AS comment,
        CASE
            WHEN v_hidden.hidden THEN NULL::text
            ELSE o.reason
        END AS reason,
    ((o.created_at)::date > o.occurred_on) AS is_late,
    p.account_id,
    a.name AS account_name,
    p.currency_code,
    p.direction,
    p.amount,
        CASE p.direction
            WHEN 'in'::fin_direction THEN p.amount
            ELSE (- p.amount)
        END AS signed_amount,
    p.amount_base,
    p.rate_used,
    p.category_id,
    cat.name AS category_name,
    p.cost_center_id,
    cc.name AS cost_center_name,
    p.object_id,
    obj.display_name AS object_name,
    p.participant_id,
    fin_private_person_name(p.participant_id) AS participant_name,
    p.contractor_id,
    con.name AS contractor_name,
    p.payment_channel,
    p.is_post_close,
    sum(
        CASE p.direction
            WHEN 'in'::fin_direction THEN p.amount
            ELSE (- p.amount)
        END) OVER (PARTITION BY p.account_id ORDER BY p.ledger_seq) AS running_balance,
    fin_private_analytics_hash(p.category_id, p.cost_center_id, p.object_id, p.participant_id, p.participant_balance_kind, p.contractor_id) AS analytics_hash,
    p.participant_balance_kind,
        CASE
            WHEN v_hidden.hidden THEN NULL::text
            ELSE ( SELECT string_agg(DISTINCT regexp_replace(a2.name, '\s*\((₹|₽|\$|€)\)\s*$'::text, ''::text), ', '::text) AS string_agg
               FROM (fin_postings p2
                 JOIN fin_accounts a2 ON ((a2.id = p2.account_id)))
              WHERE ((p2.operation_id = p.operation_id) AND (p2.account_id <> p.account_id)))
        END AS contra_account,
    p.cafe_point,
    p.note,
    p.is_transit
   FROM (((((((fin_postings p
     JOIN fin_operations o ON ((o.id = p.operation_id)))
     JOIN fin_accounts a ON ((a.id = p.account_id)))
     LEFT JOIN fin_categories cat ON ((cat.id = p.category_id)))
     LEFT JOIN fin_cost_centers cc ON ((cc.id = p.cost_center_id)))
     LEFT JOIN fin_accounting_objects obj ON ((obj.id = p.object_id)))
     LEFT JOIN fin_contractors con ON ((con.id = p.contractor_id)))
     JOIN LATERAL ( SELECT (EXISTS ( SELECT 1
                   FROM (fin_postings pr
                     JOIN fin_accounts ar ON ((ar.id = pr.account_id)))
                  WHERE ((pr.operation_id = p.operation_id) AND ar.is_restricted AND (NOT (EXISTS ( SELECT 1
                           FROM fin_account_access aa
                          WHERE ((aa.account_id = ar.id) AND (aa.user_id = auth.uid())))))))) AS hidden) v_hidden ON (true))
  WHERE fin_can_see_account(p.account_id);

-- касса у департамента видна тем, кто видит департамент
create or replace function public.fin_can_see_account(p_account_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM fin_accounts a
    WHERE a.id = p_account_id
      AND (
        (NOT a.is_restricted AND fin_can_read_all(auth.uid()))
        OR EXISTS (SELECT 1 FROM fin_account_access aa
                   WHERE aa.account_id = a.id AND aa.user_id = auth.uid())
        -- ответственный за сам счёт
        OR EXISTS (SELECT 1 FROM vaishnavas v
                    WHERE v.user_id = auth.uid() AND v.id = a.responsible_person_id)
        -- глава или человек из списка департамента, которому счёт принадлежит
        OR a.department_id IN (SELECT fin_user_department_ids(auth.uid()))
        -- касса ДДС, которая хранится у этого департамента (711)
        OR a.cashbox_department_id IN (SELECT fin_user_department_ids(auth.uid()))
      )
  );
$function$;

-- счета департамента: purpose = 'own' (его подотчёт) | 'cashbox' (касса ДДС у него)
drop function if exists fin_department_accounts(text);
create or replace function public.fin_department_accounts(p_department text)
 returns table(account_id uuid, name text, currency_code text, is_active boolean, purpose text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_dept fin_departments%rowtype;
begin
  select * into v_dept from fin_departments d
   where d.code = p_department or d.name = p_department or d.id::text = p_department
   limit 1;
  if not found then return; end if;

  if not fin_can_read_all() and v_dept.id not in (select fin_user_department_ids()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  return query
    select a.id, a.name, a.currency_code, a.is_active,
           case when a.department_id = v_dept.id then 'own' else 'cashbox' end
      from fin_accounts a
     where a.department_id = v_dept.id or a.cashbox_department_id = v_dept.id
     order by a.is_active desc, a.name;
end;
$function$;
revoke execute on function fin_department_accounts(text) from public, anon;
grant execute on function fin_department_accounts(text) to authenticated;

-- выручка: приходы по статьям департамента с ЛЮБОГО счёта, каждая операция (ВГ 19.10:
-- «видеть все деньги за мурти и за магазин, не просто итог»); note — пояснение строки (мурти: какой сет)
drop function if exists fin_department_income(text, date, date);
create or replace function fin_department_income(p_department text, p_from date default null, p_to date default null)
returns table(posting_id uuid, operation_id uuid, type text, approval text, is_reversed boolean,
              occurred_on date, created_at timestamptz, account_id uuid, account_name text,
              currency_code text, direction text, amount numeric, signed_amount numeric, amount_base numeric,
              category_id uuid, category_name text, object_name text, comment text, note text, cafe_point text)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_dept fin_departments%rowtype;
begin
  select * into v_dept from fin_departments d
   where d.code = p_department or d.name = p_department or d.id::text = p_department
   limit 1;
  if not found then return; end if;
  if not fin_can_read_all() and v_dept.id not in (select fin_user_department_ids()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  return query
    select p.id, o.id, o.type::text, o.approval::text, o.is_reversed, o.occurred_on, o.created_at,
           a.id, a.name, p.currency_code, p.direction::text, p.amount,
           case when p.direction = 'in' then p.amount else -p.amount end,
           p.amount_base, c.id, c.name, obj.display_name, o.comment, p.note, p.cafe_point::text
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id
      join fin_department_income_categories dc on dc.category_id = p.category_id and dc.department_id = v_dept.id
      left join fin_accounting_objects obj on obj.id = p.object_id
     where o.type <> 'opening'
       and (p_from is null or o.occurred_on >= p_from)
       and (p_to is null or o.occurred_on <= p_to)
     order by o.occurred_on, p.ledger_seq;
end;
$$;
revoke execute on function fin_department_income(text, date, date) from public, anon;
grant execute on function fin_department_income(text, date, date) to authenticated;

-- /баланс: у департамента с кассой ДДС — по каждой валюте общий итог (как в сейфе),
-- под ним «на хозяйство» (счёт департамента, с держателями) и «касса ДДС»
CREATE OR REPLACE FUNCTION public.tg_department_balance(p_chat bigint)
 RETURNS TABLE(department_name text, balance numeric, currency_code text, pending_drafts integer, formatted text, holders_line text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dept uuid;
  v_name text;
  v_float boolean;
  v_pending int;
  r record;
  v_holders text;
BEGIN
  SELECT l.department_id INTO v_dept FROM tg_chat_links l
   WHERE l.chat_id = p_chat AND l.is_active;
  IF v_dept IS NULL THEN RETURN; END IF;
  SELECT d.name, d.change_float INTO v_name, v_float FROM fin_departments d WHERE d.id = v_dept;
  SELECT count(*)::int INTO v_pending FROM tg_drafts dr WHERE dr.department_id = v_dept AND dr.status = 'pending';

  FOR r IN
    SELECT x.cur,
           max(x.own_id::text)::uuid AS own_id,
           coalesce(sum(x.bal) FILTER (WHERE x.own), 0) AS own_bal,
           coalesce(sum(x.bal) FILTER (WHERE NOT x.own), 0) AS box_bal,
           bool_or(NOT x.own) AS has_box,
           bool_or(x.own) AS has_own
      FROM (
        SELECT a.currency_code AS cur, (a.department_id IS NOT DISTINCT FROM v_dept) AS own,
               CASE WHEN a.department_id = v_dept THEN a.id END AS own_id,
               (SELECT COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)
                  FROM fin_postings p WHERE p.account_id = a.id) AS bal
          FROM fin_accounts a
         WHERE a.is_active
           AND ((a.department_id = v_dept AND a.kind = 'custodial') OR a.cashbox_department_id = v_dept)
      ) x
     GROUP BY x.cur
  LOOP
    -- держатели — как раньше, по счёту департамента
    SELECT string_agg(format('  — %s: %s', tg_escape(h.label), fin_fmt_money(h.amt, r.cur)), E'\n' ORDER BY h.amt DESC)
      INTO v_holders
      FROM (
        SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                        NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                        CASE WHEN v_float THEN 'выдано на сдачу' ELSE 'не привязано' END) AS label,
               SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) AS amt
          FROM fin_postings p2
          LEFT JOIN vaishnavas v ON v.id = p2.holder_person_id
         WHERE p2.account_id = r.own_id
           AND (p2.holder_person_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM fin_department_holders fh WHERE fh.department_id = v_dept AND fh.is_active))
         GROUP BY v.spiritual_name, v.first_name, v.last_name, p2.holder_person_id
        HAVING SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) <> 0
      ) h;

    department_name := v_name;
    currency_code := r.cur;
    pending_drafts := v_pending;
    IF r.has_box THEN
      balance := r.own_bal + r.box_bal;
      formatted := 'всего ' || fin_fmt_money(balance, r.cur);
      holders_line := concat_ws(E'\n',
        format('  — на хозяйство: %s', fin_fmt_money(r.own_bal, r.cur)),
        v_holders,
        format('  — касса ДДС: %s', fin_fmt_money(r.box_bal, r.cur)));
    ELSE
      balance := r.own_bal;
      formatted := fin_fmt_money(balance, r.cur);
      holders_line := v_holders;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$function$;
