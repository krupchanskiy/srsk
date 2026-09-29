-- Отчёт ретрита (ВГ, 28.09.2026): график «Начислено и получено по дням» по всему ретриту
-- и группы участников для карточки «Стоимость ретрита на участника».
-- Полная картина денег участников:
--   начислено = начисления без отмен (сумма − скидка) + стартовые долги,
--   получено  = все проводки участников по объекту ретрита + стартовые авансы.
-- В отличие от карточки «начислено · оплачено» (только блоки) сюда входят и остатки
-- «без привязки к блоку» — у Севы это 1 290 725 ₹ оплат до перехода на систему.
-- Стартовые остатки даты не имеют — отдаются отдельно, график ставит их в первый день.
create or replace function fin_retreat_money_by_day(p_retreat uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_obj uuid;
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  select id into v_obj from fin_accounting_objects where retreat_id = p_retreat;

  return jsonb_build_object(
    'charged', coalesce((select jsonb_object_agg(d, s) from (
        select coalesce(c.occurred_on, c.created_at::date) d, sum(c.amount - c.discount_amount) s
          from fin_charges c
         where c.retreat_id = p_retreat and not c.is_cancelled
         group by 1) z), '{}'::jsonb),
    'paid', coalesce((select jsonb_object_agg(d, s) from (
        select o.occurred_on d, sum(case p.direction when 'in' then p.amount_base else -p.amount_base end) s
          from fin_postings p
          join fin_operations o on o.id = p.operation_id
         where p.object_id = v_obj and p.participant_id is not null
           and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
         group by 1) z), '{}'::jsonb),
    'opening_debt', coalesce((select sum(amount) from fin_participant_opening_balances
                               where retreat_id = p_retreat and kind = 'debt'), 0),
    'opening_credit', coalesce((select sum(amount) from fin_participant_opening_balances
                                 where retreat_id = p_retreat and kind <> 'debt'), 0),
    -- по людям: статус и питание из регистрации, начислено и скидка — для групп
    -- «полная оплата / со скидкой / дети / не платят»; регистрации без начислений тоже здесь
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.pid, 'name', fin_private_person_name(x.pid), 'status', x.status, 'meal_type', x.meal_type,
        'gross', x.gross, 'discount', x.discount, 'has_charges', x.has_charges,
        'placed', exists (select 1 from residents r where r.vaishnava_id = x.pid and r.retreat_id = p_retreat
                            and r.status in ('confirmed', 'checked_out'))))
      from (
        select ids.pid,
               rr.status, rr.meal_type,
               coalesce(ch.gross, 0) gross, coalesce(ch.discount, 0) discount, ch.pid is not null has_charges
          from (select participant_id pid from fin_charges where retreat_id = p_retreat
                union select participant_id from fin_participant_opening_balances where retreat_id = p_retreat
                union select vaishnava_id from retreat_registrations
                       where retreat_id = p_retreat and not coalesce(is_deleted, false)
                         and status not in ('cancelled', 'rejected')) ids
          left join lateral (select r.status, r.meal_type from retreat_registrations r
                              where r.retreat_id = p_retreat and r.vaishnava_id = ids.pid and not coalesce(r.is_deleted, false)
                              order by r.created_at limit 1) rr on true
          left join lateral (select c.participant_id pid, sum(c.amount) gross, sum(c.discount_amount) discount
                               from fin_charges c
                              where c.retreat_id = p_retreat and c.participant_id = ids.pid and not c.is_cancelled
                              group by 1) ch on true
      ) x), '[]'::jsonb)
  );
end;
$function$;

grant execute on function fin_retreat_money_by_day(uuid) to authenticated;
