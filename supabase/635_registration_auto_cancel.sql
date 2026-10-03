-- 635: автоотмена регистрации ретрита (фаза 2, шаг 7; решение ВГ 01.10)
--
-- Регистрация уходит в cancelled, если человек не заселялся (нет записи
-- шахматки с отметкой заезда или выездом) и:
--   а) все его сделки по этому ретриту отменены, или
--   б) «Питание» пересчитано в 0 — живые начисления питания есть, а сумма
--      без скидок равна 0 («Перерасчёт: не приехал»). Скидка 100 %
--      («не кушает», ребёнок) — не отмена: человек приезжает.
-- Бронь и места в шахматке не трогаем (решение ВГ): кухня видит их как
-- «ожидается», пока бронь не снимут руками.
--
-- Возврат: если условие ушло (сделку открыли, питание пересчитали обратно,
-- человек заехал) — регистрации возвращается прежний статус. Возвращаем
-- только то, что отменили сами (auto_cancelled_from), ручные отмены не трогаем.

alter table retreat_registrations add column if not exists auto_cancelled_from text;
comment on column retreat_registrations.auto_cancelled_from is
  'Статус до автоотмены (635): сделка отменена или питание пересчитано в 0. NULL — отмена ручная или её не было';

create or replace function registration_auto_cancel_sync(p_vaishnava uuid, p_retreat uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_arrived boolean;
    v_deal_cancelled boolean;
    v_meals_zero boolean;
begin
    if p_vaishnava is null or p_retreat is null then return; end if;

    select exists (select 1 from residents r
                    where r.vaishnava_id = p_vaishnava and r.retreat_id = p_retreat
                      and (r.arrived_at is not null or r.status = 'checked_out'))
      into v_arrived;

    select exists (select 1 from crm_deals d
                    where d.vaishnava_id = p_vaishnava and d.retreat_id = p_retreat
                      and d.status = 'cancelled')
       and not exists (select 1 from crm_deals d
                        where d.vaishnava_id = p_vaishnava and d.retreat_id = p_retreat
                          and d.status <> 'cancelled')
      into v_deal_cancelled;

    select count(*) > 0 and coalesce(sum(c.amount), 0) = 0
      into v_meals_zero
      from fin_charges c
     where c.participant_id = p_vaishnava and c.retreat_id = p_retreat
       and c.kind = 'meals' and not c.is_cancelled;

    if not v_arrived and (v_deal_cancelled or v_meals_zero) then
        update retreat_registrations
           set auto_cancelled_from = status, status = 'cancelled'
         where vaishnava_id = p_vaishnava and retreat_id = p_retreat
           and not is_deleted and status not in ('cancelled', 'rejected');
    else
        update retreat_registrations
           set status = auto_cancelled_from, auto_cancelled_from = null
         where vaishnava_id = p_vaishnava and retreat_id = p_retreat
           and status = 'cancelled' and auto_cancelled_from is not null;
    end if;
end;
$$;

create or replace function trg_registration_follows_deal()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
    if new.status = 'cancelled' or (tg_op = 'UPDATE' and old.status = 'cancelled') then
        perform registration_auto_cancel_sync(new.vaishnava_id, new.retreat_id);
    end if;
    return new;
end;
$$;

drop trigger if exists trg_registration_follows_deal on crm_deals;
create trigger trg_registration_follows_deal
    after insert or update of status on crm_deals
    for each row execute function trg_registration_follows_deal();

create or replace function trg_registration_follows_meals()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if coalesce(new.kind, old.kind) <> 'meals' then return coalesce(new, old); end if;
    if tg_op in ('UPDATE', 'DELETE') then
        perform registration_auto_cancel_sync(old.participant_id, old.retreat_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
        perform registration_auto_cancel_sync(new.participant_id, new.retreat_id);
    end if;
    return coalesce(new, old);
end;
$$;

drop trigger if exists trg_registration_follows_meals on fin_charges;
create trigger trg_registration_follows_meals
    after insert or update of amount, is_cancelled, kind, participant_id, retreat_id or delete on fin_charges
    for each row execute function trg_registration_follows_meals();
