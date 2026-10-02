-- Гость сам вписал в портале дату рейса вне ретрита (раньше начала или позже конца больше чем
-- на 3 дня) — менеджеру его сделки задача «Уточнить даты», как при расхождении в CRM
-- (ВГ 02.10.2026). Невозможные даты база и так не примет (миграция 609).
-- Сотрудники подтверждают такие даты сами в форме — им задача не нужна.

create or replace function trg_portal_flight_date_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    v_reg   retreat_registrations;
    v_ret   retreats;
    v_deal  crm_deals;
    v_date  date;
    v_name  text;
    v_gap   text;
begin
    if new.flight_datetime is null or auth.uid() is null or is_staff(auth.uid()) then return new; end if;
    if tg_op = 'UPDATE' and new.flight_datetime is not distinct from old.flight_datetime then return new; end if;

    select * into v_reg from retreat_registrations where id = new.registration_id;
    select * into v_ret from retreats where id = v_reg.retreat_id;
    if v_ret.id is null or v_ret.start_date < '2001-01-01' then return new; end if;

    v_date := (new.flight_datetime at time zone 'UTC')::date;
    if v_date < v_ret.start_date - 3 then
        v_gap := 'на ' || (v_ret.start_date - v_date) || ' дн. раньше начала';
    elsif v_date > v_ret.end_date + 3 and not retreat_is_internal(v_ret.id) then
        v_gap := 'на ' || (v_date - v_ret.end_date) || ' дн. позже окончания';
    else
        return new;
    end if;

    select * into v_deal from crm_deals
     where vaishnava_id = v_reg.vaishnava_id and retreat_id = v_reg.retreat_id
       and status <> 'cancelled' and manager_id is not null
     order by created_at desc limit 1;
    if v_deal.id is null then return new; end if;
    if exists (select 1 from crm_tasks where deal_id = v_deal.id and completed_at is null
                                        and title like 'Уточнить даты%') then return new; end if;

    select coalesce(spiritual_name, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), 'гость')
      into v_name from vaishnavas where id = v_reg.vaishnava_id;

    insert into crm_tasks (deal_id, assignee_id, title, description, due_date, priority, is_auto_created)
    values (v_deal.id, v_deal.manager_id, 'Уточнить даты: ' || v_name,
            'Гость сам указал в портале рейс ' || to_char(v_date, 'DD.MM.YYYY') || ' — ' || v_gap
            || ' ретрита (' || to_char(v_ret.start_date, 'DD.MM') || '–' || to_char(v_ret.end_date, 'DD.MM.YYYY')
            || '). Проверьте месяц и год у гостя.',
            current_date, 'high', true);
    return new;
end $$;

drop trigger if exists trg_portal_flight_date_task on guest_transfers;
create trigger trg_portal_flight_date_task after insert or update of flight_datetime
    on guest_transfers for each row execute function trg_portal_flight_date_task();
