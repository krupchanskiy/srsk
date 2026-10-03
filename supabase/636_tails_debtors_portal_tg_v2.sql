-- Фаза 2, шаг 8 (часть 1): должники, портал, Телеграм, сводка ретрита — на v2.
-- Правило ВГ 03.10: по одному гостю — в его валюте расчёта, без курса;
-- суммы по многим гостям — в ₹ по курсу ретрита (fin_private_to_inr) + разбивка по валютам.
-- Сева-ретрит (legacy_inr_settlement): v2 сама уходит в старую ветку — цифры не двигаются.

-- 1. v2 отдаёт general_charged / general_paid (их ждёт сводка ретрита, как у v1)
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('fin_private_participant_balance_v2(uuid,uuid)'::regprocedure);
  n := replace(d, E'v_writeoffs jsonb := ''[]''::jsonb;\n',
                  E'v_writeoffs jsonb := ''[]''::jsonb;\nv_gen_charged numeric;\nv_gen_paid numeric;\n');
  n := replace(n, E'for i in 1 .. 4 loop\nv_block_debt[i] := v_charges[i]',
                  E'v_gen_charged := v_general_debt;\nv_gen_paid := v_general_credit + v_general_signed;\nfor i in 1 .. 4 loop\nv_block_debt[i] := v_charges[i]');
  n := replace(n, E'''quick_net'',', E'''general_charged'', v_gen_charged,\n''general_paid'', v_gen_paid,\n''quick_net'',');
  if n = d or n !~ 'v_gen_charged := v_general_debt' or n !~ '''general_paid'', v_gen_paid' then
    raise exception 'v2: шаблон не найден';
  end if;
  execute n;
end $$;

-- 2. Кто должен / кому должны — признак, валюта не важна
create or replace function public.fin_retreat_debtors(p_retreat uuid)
 returns table(participant_id uuid)
 language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_staff(auth.uid()) then
    raise exception 'forbidden';
  end if;
  if p_retreat is null then return; end if;
  return query
  select x.pid from (
    select distinct c.participant_id as pid from fin_charges c
      where c.retreat_id = p_retreat and not c.is_cancelled
    union
    select distinct b.participant_id from fin_participant_opening_balances b
      where b.retreat_id = p_retreat
    union
    select distinct p.participant_id from fin_postings p
      join fin_accounting_objects o on o.id = p.object_id
      where o.retreat_id = p_retreat and p.participant_id is not null
        and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
  ) x
  where coalesce(
    (fin_private_participant_balance_v2(x.pid, p_retreat)->>'total_debt')::numeric, 0) > 0;
end;
$function$;

create or replace function public.fin_retreat_creditors(p_retreat uuid)
 returns table(participant_id uuid)
 language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_staff(auth.uid()) then raise exception 'forbidden'; end if;
  if p_retreat is null then return; end if;
  return query
  select x.pid from (
    select distinct c.participant_id as pid from fin_charges c
      where c.retreat_id = p_retreat and not c.is_cancelled
  ) x
  cross join lateral (select fin_private_participant_balance_v2(x.pid, p_retreat) as j) b
  where coalesce((b.j->>'net')::numeric, 0) < 0
    and coalesce((b.j->>'total_debt')::numeric, 0) = 0;
end;
$function$;

create or replace function public.fin_has_debt(p_participant uuid, p_retreat uuid)
 returns boolean
 language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_staff(auth.uid()) then
    raise exception 'forbidden';
  end if;
  if p_participant is null or p_retreat is null then
    return false;
  end if;
  return coalesce(
    (fin_private_participant_balance_v2(p_participant, p_retreat)->>'total_debt')::numeric, 0) > 0;
end;
$function$;

-- 3. Долг человека по всем событиям (запрет удаления карточки) — сумма в ₹ по курсу каждого ретрита
create or replace function public.fin_private_participant_total_debt(p_participant uuid)
 returns numeric
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  r record;
  v_bal jsonb;
  v_total numeric := 0;
begin
  for r in
    select distinct retreat_id from (
      select retreat_id from fin_charges
      where participant_id = p_participant and not is_cancelled
      union
      select retreat_id from fin_participant_opening_balances
      where participant_id = p_participant
      union
      select o.retreat_id from fin_postings p
      join fin_accounting_objects o on o.id = p.object_id
      where p.participant_id = p_participant
        and p.participant_balance_kind is not null
        and p.participant_balance_kind <> 'none'
    ) x
    where retreat_id is not null
  loop
    v_bal := fin_private_participant_balance_v2(p_participant, r.retreat_id);
    v_total := v_total + fin_private_to_inr(
      coalesce((v_bal->>'total_debt')::numeric, 0), coalesce(v_bal->>'currency', 'INR'),
      r.retreat_id, current_date);
  end loop;
  return v_total;
end;
$function$;

-- 4. Сводка ретрита: суммы в ₹ по курсу ретрита + по валютам; должник — в своей валюте
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('fin_private_build_snapshot(uuid)'::regprocedure);
  n := replace(d, E'  v_debtors jsonb := ''[]''::jsonb;\n',
    E'  v_debtors jsonb := ''[]''::jsonb;\n  v_cur text;\n  v_debt_cur jsonb := ''{}''::jsonb;\n  v_adv_cur jsonb := ''{}''::jsonb;\n');
  n := replace(n,
E'      v_bal := fin_private_participant_balance(v_p.pid, v_obj.retreat_id);
      v_cnt := v_cnt + 1;
      v_debt := v_debt + (v_bal->>''total_debt'')::numeric;
      v_advance := v_advance + (v_bal->>''total_advance'')::numeric;
      SELECT v_charged + COALESCE(SUM((v_bal->''blocks''->k->>''charged'')::numeric), 0),
             v_paid    + COALESCE(SUM((v_bal->''blocks''->k->>''paid'')::numeric), 0)
        INTO v_charged, v_paid
      FROM unnest(ARRAY[''org_fee'',''accommodation'',''meals'',''extra'']) k;
      v_charged := v_charged + COALESCE((v_bal->>''general_charged'')::numeric, 0);
      v_paid := v_paid + COALESCE((v_bal->>''general_paid'')::numeric, 0);
      IF (v_bal->>''net'')::numeric > 0 THEN
        v_debtors := v_debtors || jsonb_build_array(jsonb_build_object(
          ''participant_id'', v_p.pid,
          ''name'', fin_private_person_name(v_p.pid),
          ''debt'', (v_bal->>''net'')::numeric));
      END IF;',
E'      -- мигр. 636: v2 — у каждого гостя своя валюта; суммы в ₹ по курсу ретрита
      v_bal := fin_private_participant_balance_v2(v_p.pid, v_obj.retreat_id);
      v_cur := coalesce(v_bal->>''currency'', ''INR'');
      v_cnt := v_cnt + 1;
      v_debt := v_debt + fin_private_to_inr((v_bal->>''total_debt'')::numeric, v_cur, v_obj.retreat_id, current_date);
      v_advance := v_advance + fin_private_to_inr((v_bal->>''total_advance'')::numeric, v_cur, v_obj.retreat_id, current_date);
      IF (v_bal->>''total_debt'')::numeric <> 0 THEN
        v_debt_cur := jsonb_set(v_debt_cur, ARRAY[v_cur], to_jsonb(coalesce((v_debt_cur->>v_cur)::numeric, 0) + (v_bal->>''total_debt'')::numeric));
      END IF;
      IF (v_bal->>''total_advance'')::numeric <> 0 THEN
        v_adv_cur := jsonb_set(v_adv_cur, ARRAY[v_cur], to_jsonb(coalesce((v_adv_cur->>v_cur)::numeric, 0) + (v_bal->>''total_advance'')::numeric));
      END IF;
      v_charged := v_charged + fin_private_to_inr(
        (SELECT COALESCE(SUM((v_bal->''blocks''->k->>''charged'')::numeric), 0)
           FROM unnest(ARRAY[''org_fee'',''accommodation'',''meals'',''extra'']) k)
        + COALESCE((v_bal->>''general_charged'')::numeric, 0), v_cur, v_obj.retreat_id, current_date);
      v_paid := v_paid + fin_private_to_inr(
        (SELECT COALESCE(SUM((v_bal->''blocks''->k->>''paid'')::numeric), 0)
           FROM unnest(ARRAY[''org_fee'',''accommodation'',''meals'',''extra'']) k)
        + COALESCE((v_bal->>''general_paid'')::numeric, 0), v_cur, v_obj.retreat_id, current_date);
      IF (v_bal->>''net'')::numeric > 0 THEN
        v_debtors := v_debtors || jsonb_build_array(jsonb_build_object(
          ''participant_id'', v_p.pid,
          ''name'', fin_private_person_name(v_p.pid),
          ''debt'', fin_private_to_inr((v_bal->>''net'')::numeric, v_cur, v_obj.retreat_id, current_date),
          ''debt_cur'', (v_bal->>''net'')::numeric,
          ''currency'', v_cur));
      END IF;');
  n := replace(n, E'''debt_total'', v_debt, ''advance_total'', v_advance, ''debtors'', v_debtors)',
                  E'''debt_total'', v_debt, ''advance_total'', v_advance, ''debtors'', v_debtors,\n      ''debt_by_currency'', v_debt_cur, ''advance_by_currency'', v_adv_cur)');
  if n = d or n !~ 'fin_private_participant_balance_v2' or n !~ 'debt_by_currency' then
    raise exception 'snapshot: шаблон не найден';
  end if;
  execute n;
end $$;

-- 5. Портал гостя: баланс v2 (в валюте гостя), валюта начислений, засчитанная сумма платежа,
--    семейный итог — по валютам
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('portal_fin_get_my_finances()'::regprocedure);
  n := replace(d, 'fin_private_participant_balance(', 'fin_private_participant_balance_v2(');
  n := replace(n, E'''net_amount'', c.amount - c.discount_amount,',
                  E'''net_amount'', c.amount - c.discount_amount, ''currency_code'', c.currency_code,');
  n := replace(n, E'''status'', x->>''status''',
                  E'''status'', x->>''status'', ''settle_amount'', x->''settle_amount'', ''settle_currency'', x->>''settle_currency''');
  n := replace(n,
E'      ''family_net'', (
        SELECT round(COALESCE((fin_private_participant_balance_v2(v_viewer, r.id)->>''net'')::numeric, 0)
          + COALESCE(SUM((fin_private_participant_balance_v2(f2.rid, r.id)->>''net'')::numeric), 0), 2)
        FROM (
          SELECT fl.relative_id AS rid FROM family_links fl WHERE fl.vaishnava_id = v_viewer
          UNION
          SELECT fl.vaishnava_id FROM family_links fl WHERE fl.relative_id = v_viewer
        ) f2
        WHERE fin_private_has_retreat_data(f2.rid, r.id)
      )',
E'      -- мигр. 636: у родственников может быть своя валюта — итог по валютам {"RUB": 100, "INR": 0}
      ''family_net'', (
        SELECT COALESCE(jsonb_object_agg(fb.cur, fb.net), ''{}''::jsonb) FROM (
          SELECT b.j->>''currency'' AS cur, round(SUM((b.j->>''net'')::numeric), 2) AS net
          FROM (
            SELECT v_viewer AS rid
            UNION
            SELECT f2.rid FROM (
              SELECT fl.relative_id AS rid FROM family_links fl WHERE fl.vaishnava_id = v_viewer
              UNION
              SELECT fl.vaishnava_id FROM family_links fl WHERE fl.relative_id = v_viewer
            ) f2
            WHERE fin_private_has_retreat_data(f2.rid, r.id)
          ) m
          CROSS JOIN LATERAL (SELECT fin_private_participant_balance_v2(m.rid, r.id) AS j) b
          GROUP BY 1
        ) fb
      )');
  if n = d or n ~ 'fin_private_participant_balance\(' or n !~ 'jsonb_object_agg\(fb.cur'
     or n !~ '''settle_amount'', x->' or n !~ '''currency_code'', c.currency_code' then
    raise exception 'portal: шаблон не найден';
  end if;
  execute n;
end $$;

-- 6. Телеграм ресепшена: долг/аванс уезжающего — в его валюте
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('tg_reception_digest(date)'::regprocedure);
  n := replace(d, E'  v_debt numeric;\n', E'  v_debt numeric;\n  v_bal jsonb;\n');
  n := replace(n,
E'      v_debt := COALESCE((fin_private_participant_balance(r.vaishnava_id, r.retreat_id)
                          ->>''total_debt'')::numeric, 0);',
E'      v_bal := fin_private_participant_balance_v2(r.vaishnava_id, r.retreat_id);
      v_debt := COALESCE((v_bal->>''total_debt'')::numeric, 0);');
  n := replace(n, E'fin_fmt_money(v_debt, ''INR'')', E'fin_fmt_money(v_debt, COALESCE(v_bal->>''currency'', ''INR''))');
  if n = d or n ~ 'fin_private_participant_balance\(' or n ~ '''INR''\)\) ELSE' then
    raise exception 'digest: шаблон не найден';
  end if;
  execute n;

  d := pg_get_functiondef('tg_reception_plan_text(date,boolean)'::regprocedure);
  n := replace(d, 'fin_private_participant_balance(', 'fin_private_participant_balance_v2(');
  n := replace(n, E'fin_fmt_money(v_debt, ''INR'')', E'fin_fmt_money(v_debt, COALESCE(v_bal->>''currency'', ''INR''))');
  n := replace(n, E'fin_fmt_money(v_adv, ''INR'')', E'fin_fmt_money(v_adv, COALESCE(v_bal->>''currency'', ''INR''))');
  if n = d or n ~ 'fin_private_participant_balance\(' or n ~ 'v_(debt|adv), ''INR''' then
    raise exception 'plan_text: шаблон не найден';
  end if;
  execute n;
end $$;
