-- Рейсы не совпадают с бронью → задача менеджеру CRM.
--
-- Раньше расхождение (v_placement_uncovered) показывалось плашкой в шахматке по всем
-- будущим ретритам — за месяцы до заезда, когда это вопрос менеджера, а не ресепшена.
-- Теперь менеджеру сделки ставится задача, а шахматка показывает плашку только
-- за 14 дней до начала ретрита.
--
-- Задача одна на сделку: пока открыта — новую не ставим, а обновляем описание.
-- Расхождение ушло (бронь продлили, рейс поправили, сделку отменили) — задача
-- закрывается сама с пометкой. Узнаём свою задачу по началу заголовка.

create or replace function crm_check_uncovered_nights(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    u        record;
    v_mgr    uuid;
    v_desc   text;
    c_prefix constant text := 'Рейсы не совпадают с бронью';
begin
    select * into u
      from v_placement_uncovered
     where deal_id = p_deal_id
       and (retreat_end is null or retreat_end >= current_date)
     limit 1;

    if not found then
        update crm_tasks
           set completed_at = now(),
               completion_comment = 'Даты брони и рейсов совпали — закрыто автоматически'
         where deal_id = p_deal_id
           and is_auto_created
           and completed_at is null
           and title like c_prefix || '%';
        return;
    end if;

    v_desc := 'Рейсы: ' || to_char(u.arrival_date, 'DD.MM.YYYY') || ' — '
           || coalesce(to_char(u.departure_date, 'DD.MM.YYYY'), '?')
           || E'\nБронь: ' || to_char(u.check_in, 'DD.MM.YYYY') || ' — ' || to_char(u.check_out, 'DD.MM.YYYY')
           || case when u.nights_before > 0 then E'\nНочей до заезда без места: '   || u.nights_before else '' end
           || case when u.nights_after  > 0 then E'\nНочей после выезда без места: ' || u.nights_after  else '' end
           || E'\nПродлить бронь или уточнить рейс у гостя.';

    update crm_tasks
       set description = v_desc
     where deal_id = p_deal_id
       and is_auto_created
       and completed_at is null
       and title like c_prefix || '%';

    if found then return; end if;

    select manager_id into v_mgr from crm_deals where id = p_deal_id;

    insert into crm_tasks (deal_id, title, description, due_date, priority, assignee_id, is_auto_created)
    values (p_deal_id,
            c_prefix || ': ' || coalesce(u.guest_name, ''),
            v_desc,
            current_date + 3,
            'high',
            v_mgr,
            true);
end;
$$;

-- Сделка: даты рейсов, бронь, статус
create or replace function trg_crm_deal_uncovered_check()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
    perform crm_check_uncovered_nights(new.id);
    return new;
end;
$$;

drop trigger if exists trg_crm_deal_uncovered on crm_deals;
create trigger trg_crm_deal_uncovered
    after insert or update of arrival_datetime, departure_datetime, booking_id, status
    on crm_deals
    for each row execute function trg_crm_deal_uncovered_check();

-- Бронь: даты и статус — пересчитать все сделки на ней
create or replace function trg_booking_uncovered_check()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    d uuid;
begin
    for d in select id from crm_deals where booking_id = new.id loop
        perform crm_check_uncovered_nights(d);
    end loop;
    return new;
end;
$$;

drop trigger if exists trg_booking_uncovered on bookings;
create trigger trg_booking_uncovered
    after update of check_in, check_out, status
    on bookings
    for each row
    when (old.check_in  is distinct from new.check_in
       or old.check_out is distinct from new.check_out
       or old.status    is distinct from new.status)
    execute function trg_booking_uncovered_check();

revoke execute on function crm_check_uncovered_nights(uuid) from public, anon;

-- Уже существующие расхождения по незакончившимся ретритам
select crm_check_uncovered_nights(deal_id)
  from v_placement_uncovered
 where retreat_end is null or retreat_end >= current_date;
