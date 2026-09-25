-- =============================================================
-- ДДС: перевод и трата, созданные одной заявкой из чата («выдано … и сразу
-- потрачено»), стоят в ленте рядом — перевод, сразу под ним трата
-- (решение ВГ 25.09.2026, так же, как на странице «Счёт» департамента).
-- По списку операций страницы отдаёт пары из tg_draft_operations — только
-- по операциям, которые человек вправе видеть (есть проводка на видимом счёте).
-- =============================================================

create or replace function public.fin_operation_groups(p_operation_ids uuid[])
returns table (operation_id uuid, group_id uuid)
language sql stable security definer set search_path = public
as $function$
  with visible as (
    select distinct p.operation_id
      from fin_postings p
     where p.operation_id = any(p_operation_ids)
       and fin_can_see_account(p.account_id)
  ), linked as (
    select t.operation_id, t.draft_id
      from tg_draft_operations t
     where t.draft_id in (select t2.draft_id from tg_draft_operations t2 join visible v on v.operation_id = t2.operation_id)
  )
  select l.operation_id, l.draft_id
    from linked l join visible v on v.operation_id = l.operation_id
   where (select count(*) from linked l2 where l2.draft_id = l.draft_id) > 1;
$function$;

revoke all on function public.fin_operation_groups(uuid[]) from public, anon;
grant execute on function public.fin_operation_groups(uuid[]) to authenticated;
