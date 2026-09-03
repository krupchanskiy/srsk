-- 411. Расшифровка проверки «Платёж есть и в журнале, и в начальном остатке»
--
-- ВГ жаловался: «а тут вообще не понятно, на что он ругается» — проверка
-- показывала число нарушений, но списка людей не было, потому что ветки для
-- advance_double_representation в fin_get_integrity_details просто не было.
--
-- Ветка вставляется программно, чтобы не переписывать функцию целиком:
-- якорь — начало ветки advance_missing.
do $do$
declare
  v_def   text;
  v_new   text;
  v_якорь text := '  elsif p_check = ''advance_missing'' then';
  v_ветка text := $frag$  elsif p_check = 'advance_double_representation' then
    -- Платёж уже разнесён в журнал и при этом остался в начальном остатке
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('в журнале %s (%s %s, %s), в начальном остатке %s',
                              fin_fmt_money(x.в_журнале, 'INR'),
                              x.сумма, x.валюта, fin_fmt_date_ru(x.дата),
                              fin_fmt_money(x.в_остатке, 'INR')),
             'link', format('participants.html?retreat=%s&open=%s', x.retreat_id, x.participant_id)
           ) order by x.в_журнале desc), '[]'::jsonb)
      into v_rows
      from (
        select cd.vaishnava_id as participant_id, cd.retreat_id,
               fin_private_person_name(cd.vaishnava_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               cp.amount_inr as в_журнале, cp.amount as сумма, cp.currency as валюта,
               coalesce(cp.received_at::date, cp.confirmed_at::date) as дата,
               (select sum(ob.amount) from fin_participant_opening_balances ob
                 where ob.source_row_id = cd.id::text) as в_остатке
          from crm_payments cp
          join crm_deals cd on cd.id = cp.deal_id
          join retreats r on r.id = cd.retreat_id
         where cp.is_confirmed
           and exists (select 1 from fin_operations o where o.id = cp.id and not o.is_reversed)
           and exists (select 1 from fin_participant_opening_balances ob
                        where ob.source_row_id = cd.id::text)
      ) x
     limit 50;

$frag$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_get_integrity_details';

  if v_def is null then
    raise exception 'Функция fin_get_integrity_details не найдена';
  end if;

  if position('advance_double_representation' in v_def) > 0 then
    raise notice 'Ветка уже есть, менять нечего';
    return;
  end if;

  if position(v_якорь in v_def) = 0 then
    raise exception 'Якорь ветки advance_missing не найден — функция изменилась, миграцию надо править';
  end if;

  v_new := replace(v_def, v_якорь, v_ветка || v_якорь);
  execute v_new;
end
$do$;
