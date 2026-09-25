-- =============================================================
-- «Счёт» департамента: перевод и трата, созданные одной заявкой из чата
-- («выдано Кухне на … и сразу потрачено»), стоят в ленте рядом (решение ВГ 25.09.2026).
-- Связь живёт в tg_draft_operations (draft_id), главе департамента эта таблица
-- не открыта — функция отдаёт только пары по счёту, который человек вправе видеть.
-- Пары из формы ДДС «перевод + сразу потрачено» связи не имеют — их страница
-- узнаёт сама (та же дата, сумма и комментарий).
-- =============================================================

create or replace function public.fin_account_op_groups(p_account uuid)
returns table (operation_id uuid, group_id uuid)
language plpgsql stable security definer set search_path = public
as $function$
begin
  if not fin_can_see_account(p_account) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  return query
    with ops as (
      select distinct p.operation_id from fin_postings p where p.account_id = p_account
    ), linked as (
      select t.operation_id, t.draft_id
        from tg_draft_operations t join ops on ops.operation_id = t.operation_id
    )
    select l.operation_id, l.draft_id
      from linked l
     where (select count(*) from linked l2 where l2.draft_id = l.draft_id) > 1;
end;
$function$;

revoke all on function public.fin_account_op_groups(uuid) from public, anon;
grant execute on function public.fin_account_op_groups(uuid) to authenticated;
