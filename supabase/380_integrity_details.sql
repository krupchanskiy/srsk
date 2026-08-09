-- Сигнал целостности говорил «не сходится (1)» и молчал о том, у кого и на сколько:
-- нажать на него было нельзя, дойти до проблемы — тоже (ВГ, 08.08).
-- Даём расшифровку: кто, какой ретрит, какие суммы и ссылка прямо на карточку.
-- Полный текст функции применён миграцией через MCP; здесь он же.
create or replace function public.fin_get_integrity_details(p_check text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_rows jsonb;
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  if p_check = 'advance_partial_load' then
    -- Начальный остаток есть, но он меньше (или больше) суммы исторических платежей
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('в остатке %s, платежей %s — расхождение %s',
                              fin_fmt_money(x.в_остатке, 'INR'),
                              fin_fmt_money(x.в_платежах, 'INR'),
                              fin_fmt_money(x.в_платежах - x.в_остатке, 'INR')),
             'link', format('participants.html?retreat=%s&open=%s', x.retreat_id, x.participant_id)
           ) order by abs(x.в_платежах - x.в_остатке) desc), '[]'::jsonb)
      into v_rows
      from (
        select ob.participant_id, ob.retreat_id,
               fin_private_person_name(ob.participant_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               sum(ob.amount) as в_остатке,
               (select coalesce(sum(cp.amount_inr), 0)
                  from crm_payments cp join crm_deals cd on cd.id = cp.deal_id
                 where cd.vaishnava_id = ob.participant_id
                   and cd.retreat_id = ob.retreat_id
                   and cp.is_confirmed
                   and not exists (select 1 from fin_operations o where o.id = cp.id)) as в_платежах
          from fin_participant_opening_balances ob
          join retreats r on r.id = ob.retreat_id
         group by ob.participant_id, ob.retreat_id, r.name_ru, r.name_en
      ) x
     where abs(x.в_платежах - x.в_остатке) > 1 and x.в_платежах > 0
     limit 50;

  elsif p_check = 'advance_missing' then
    -- Платежи подтверждены, но начального остатка нет вовсе: деньги не в учёте
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('подтверждено %s, в учёте ничего нет', fin_fmt_money(x.в_платежах, 'INR')),
             'link', format('participants.html?retreat=%s&open=%s', x.retreat_id, x.participant_id)
           ) order by x.в_платежах desc), '[]'::jsonb)
      into v_rows
      from (
        select cd.vaishnava_id as participant_id, cd.retreat_id,
               fin_private_person_name(cd.vaishnava_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               sum(cp.amount_inr) as в_платежах
          from crm_payments cp
          join crm_deals cd on cd.id = cp.deal_id
          join retreats r on r.id = cd.retreat_id
         where cp.is_confirmed
           and not exists (select 1 from fin_operations o where o.id = cp.id)
           and not exists (select 1 from fin_participant_opening_balances ob
                            where ob.participant_id = cd.vaishnava_id
                              and ob.retreat_id = cd.retreat_id)
         group by cd.vaishnava_id, cd.retreat_id, r.name_ru, r.name_en
      ) x
     limit 50;

  elsif p_check = 'unposted_payments' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', fin_private_person_name(cd.vaishnava_id),
             'subtitle', coalesce(r.name_ru, r.name_en),
             'detail', format('%s от %s не разнесён в учёт',
                              fin_fmt_money(cp.amount_inr, 'INR'), fin_fmt_date_ru(cp.received_at::date)),
             'link', 'inbox.html?tab=unposted'
           ) order by cp.amount_inr desc), '[]'::jsonb)
      into v_rows
      from crm_payments cp
      join crm_deals cd on cd.id = cp.deal_id
      join retreats r on r.id = cd.retreat_id
     where cp.is_confirmed
       and coalesce(cp.received_at::date, current_date) >= coalesce(fin_cutover_date(), date '1900-01-01')
       and not exists (select 1 from fin_operations o where o.id = cp.id)
     limit 50;

  else
    v_rows := '[]'::jsonb;   -- для остальных проверок расшифровки пока нет
  end if;

  return jsonb_build_object('ok', true, 'result', v_rows);
end;
$function$;

revoke all on function public.fin_get_integrity_details(text) from public, anon;
grant execute on function public.fin_get_integrity_details(text) to authenticated, service_role;
