-- 384: рейсы из чеклиста сделки становятся трансферами гостя
--
-- Проблема: ОП ведут рейсы в карточке сделки (crm_deals.arrival_*/departure_*),
-- а страницы «Заезды», «Выезды» и «Трансферы» читают только guest_transfers.
-- На Сева-ретрите 81 сделка с рейсом и ноль трансферов — ресепшен видел прочерки.
--
-- Решение: сделка — хозяин данных о рейсе, guest_transfers ведётся из неё
-- автоматически. Заказ такси (taxi_*) остаётся за размещением и не затирается.

-- Одна запись на пару «регистрация + направление»: без этого повторный
-- прогон синхронизации плодил бы дубли рейсов.
create unique index if not exists guest_transfers_reg_direction_uniq
    on public.guest_transfers (registration_id, direction);

create or replace function public.crm_sync_transfer(
    p_reg_id uuid,
    p_direction text,
    p_datetime timestamptz,
    p_flight text,
    p_checklist text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_рейс text := nullif(btrim(coalesce(p_flight, '')), '');
    v_нужен text := case p_checklist when 'needed' then 'yes' when 'not_needed' then 'no' end;
begin
    -- Нечего писать и записи нет — не создаём пустышку
    if p_datetime is null and v_рейс is null
       and not exists (select 1 from guest_transfers
                        where registration_id = p_reg_id and direction = p_direction) then
        return;
    end if;

    insert into guest_transfers (registration_id, direction, flight_datetime, flight_number, needs_transfer)
    values (p_reg_id, p_direction, p_datetime, v_рейс, v_нужен)
    on conflict (registration_id, direction) do update
       set flight_datetime = excluded.flight_datetime,
           flight_number   = excluded.flight_number,
           -- чеклист сделки не должен стирать решение, принятое на размещении
           needs_transfer  = coalesce(excluded.needs_transfer, guest_transfers.needs_transfer)
     where guest_transfers.flight_datetime is distinct from excluded.flight_datetime
        or guest_transfers.flight_number   is distinct from excluded.flight_number
        or (excluded.needs_transfer is not null
            and guest_transfers.needs_transfer is distinct from excluded.needs_transfer);
end;
$$;

-- Сделка изменилась → обновляем трансферы её регистрации
create or replace function public.crm_sync_transfers_from_deal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_reg_id uuid;
begin
    if new.vaishnava_id is null or new.retreat_id is null or new.status = 'cancelled' then
        return new;
    end if;

    select id into v_reg_id
      from retreat_registrations
     where vaishnava_id = new.vaishnava_id
       and retreat_id = new.retreat_id
       and coalesce(is_deleted, false) = false
     limit 1;

    if v_reg_id is null then
        return new;  -- регистрации ещё нет, подтянется её собственным триггером
    end if;

    perform crm_sync_transfer(v_reg_id, 'arrival', new.arrival_datetime,
                              new.arrival_flight, new.checklist_transfer_arrival);
    perform crm_sync_transfer(v_reg_id, 'departure', new.departure_datetime,
                              new.departure_flight, new.checklist_transfer_departure);
    return new;
end;
$$;

drop trigger if exists trg_crm_sync_transfers on public.crm_deals;
create trigger trg_crm_sync_transfers
    after insert or update of arrival_datetime, arrival_flight, checklist_transfer_arrival,
                              departure_datetime, departure_flight, checklist_transfer_departure,
                              vaishnava_id, retreat_id, status
    on public.crm_deals
    for each row execute function crm_sync_transfers_from_deal();

-- Регистрация появилась позже сделки (авторегистрация из CRM) → подтягиваем рейсы
create or replace function public.crm_sync_transfers_on_registration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_сделка crm_deals%rowtype;
begin
    if new.vaishnava_id is null then
        return new;
    end if;

    select * into v_сделка
      from crm_deals
     where vaishnava_id = new.vaishnava_id
       and retreat_id = new.retreat_id
       and status <> 'cancelled'
     order by updated_at desc nulls last
     limit 1;

    if not found then
        return new;
    end if;

    perform crm_sync_transfer(new.id, 'arrival', v_сделка.arrival_datetime,
                              v_сделка.arrival_flight, v_сделка.checklist_transfer_arrival);
    perform crm_sync_transfer(new.id, 'departure', v_сделка.departure_datetime,
                              v_сделка.departure_flight, v_сделка.checklist_transfer_departure);
    return new;
end;
$$;

drop trigger if exists trg_registration_sync_transfers on public.retreat_registrations;
create trigger trg_registration_sync_transfers
    after insert on public.retreat_registrations
    for each row execute function crm_sync_transfers_on_registration();

-- Догрузка того, что накопилось до синхронизации
do $$
declare
    r record;
    v_создано int := 0;
begin
    for r in
        select rr.id as reg_id, d.arrival_datetime, d.arrival_flight, d.checklist_transfer_arrival,
               d.departure_datetime, d.departure_flight, d.checklist_transfer_departure
          from crm_deals d
          join retreat_registrations rr
            on rr.vaishnava_id = d.vaishnava_id and rr.retreat_id = d.retreat_id
           and coalesce(rr.is_deleted, false) = false
         where d.status <> 'cancelled'
           and (d.arrival_datetime is not null or d.departure_datetime is not null)
    loop
        perform crm_sync_transfer(r.reg_id, 'arrival', r.arrival_datetime,
                                  r.arrival_flight, r.checklist_transfer_arrival);
        perform crm_sync_transfer(r.reg_id, 'departure', r.departure_datetime,
                                  r.departure_flight, r.checklist_transfer_departure);
        v_создано := v_создано + 1;
    end loop;
    raise notice 'Синхронизировано сделок: %', v_создано;
end $$;

revoke execute on function public.crm_sync_transfer(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function public.crm_sync_transfer(uuid, text, timestamptz, text, text) to authenticated, service_role;
