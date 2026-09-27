-- =============================================================
-- Подсказка ретрита при вводе пожертвования на прасад (решение ВГ 27.09.2026):
-- в форме «Приход» ДДС, если статья «Прасад - пожертвование», а дата попадает в даты
-- нашего общего ретрита (правило миграции 570), форма сама ставит этот ретрит
-- и пишет почему; казначей может убрать. Функция только читает.
-- =============================================================
create or replace function public.fin_prasad_donation_object(p_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
declare v_retreat uuid; v jsonb;
begin
  if not (fin_can_read_all() or fin_is_account_user() or fin_kitchen_can_view()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  v_retreat := fin_private_common_retreat_on(p_date);
  if v_retreat is null then return null; end if;
  select jsonb_build_object('object_id', o.id, 'retreat_name', r.name_ru,
           'is_closed', exists (select 1 from fin_object_closures c where c.object_id = o.id and c.is_initial))
    into v
    from fin_accounting_objects o join retreats r on r.id = o.retreat_id
   where o.retreat_id = v_retreat
   limit 1;
  return v;
end;
$function$;
revoke all on function public.fin_prasad_donation_object(date) from public, anon;
grant execute on function public.fin_prasad_donation_object(date) to authenticated;
