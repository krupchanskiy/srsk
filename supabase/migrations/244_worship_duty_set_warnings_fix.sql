-- Приписка к массиву без явного типа читалась как «ещё один массив»
-- и роняла назначение на строке с предупреждением.
create or replace function worship_duty_set(
    p_date date, p_person uuid, p_service uuid default null,
    p_override uuid default null, p_role text default 'pujari')
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
    v_человек   worship_people%rowtype;
    v_служба    worship_services%rowtype;
    v_разовая   worship_day_overrides%rowtype;
    v_время     time;
    v_id        uuid;
    v_предупр   text[] := '{}';
begin
    if not worship_can_approve() then
        raise exception 'Расписывать людей может старший пуджари' using errcode = '42501';
    end if;
    if p_date is null then raise exception 'Не указан день'; end if;
    if num_nonnulls(p_service, p_override) <> 1 then
        raise exception 'Укажите либо службу, либо разовую службу дня';
    end if;

    select * into v_человек from worship_people where id = p_person;
    if not found then raise exception 'Человек не найден в отделе'; end if;
    if not v_человек.is_active then
        raise exception 'Человек больше не в отделе — верните его в состав или выберите другого';
    end if;

    -- единственная жёсткая проверка: он сам сказал, что его не будет
    if worship_is_away(p_person, p_date) then
        raise exception 'На этот день стоит отметка недоступности. Снимите её или поставьте другого';
    end if;

    if p_service is not null then
        select * into v_служба from worship_services where id = p_service;
        if not found then raise exception 'Служба не найдена'; end if;
        if not v_служба.is_active then raise exception 'Служба отключена'; end if;
        v_время := v_служба.time_of_day;
        if exists (select 1 from worship_day_overrides o
                    where o.duty_date = p_date and o.service_id = p_service) then
            raise exception 'В этот день служба не проводится';
        end if;
    else
        select * into v_разовая from worship_day_overrides where id = p_override;
        if not found or v_разовая.title is null then raise exception 'Разовая служба не найдена'; end if;
        if v_разовая.duty_date <> p_date then raise exception 'Разовая служба назначена на другой день'; end if;
        v_время := v_разовая.time_of_day;
    end if;

    -- предупреждения: решение остаётся за старшим
    if v_человек.active_to is not null and p_date > v_человек.active_to then
        v_предупр := array_append(v_предупр, 'срок участия к этому дню истекает');
    end if;
    if v_человек.active_from is not null and p_date < v_человек.active_from then
        v_предупр := array_append(v_предупр, 'человек ещё не приступил');
    end if;
    if p_service is not null and not exists (
        select 1 from worship_person_services ps
         where ps.person_id = p_person and ps.service_id = p_service) then
        v_предупр := array_append(v_предупр, 'не отмечен допуск на эту службу');
    end if;
    if exists (
        select 1 from worship_duties d
          left join worship_services s on s.id = d.service_id
          left join worship_day_overrides o on o.id = d.override_id
         where d.duty_date = p_date and d.person_id = p_person
           and coalesce(s.time_of_day, o.time_of_day) = v_время
           and coalesce(d.service_id, d.override_id) is distinct from coalesce(p_service, p_override)) then
        v_предупр := array_append(v_предупр, 'в это же время он уже на другой службе');
    end if;

    insert into worship_duties (duty_date, service_id, override_id, person_id, role, created_by)
    values (p_date, p_service, p_override, p_person, coalesce(p_role, 'pujari'), auth.uid())
    on conflict do nothing
    returning id into v_id;

    -- повторное нажатие не удваивает назначение
    if v_id is null then
        select id into v_id from worship_duties
         where duty_date = p_date and person_id = p_person and role = coalesce(p_role, 'pujari')
           and coalesce(service_id, override_id) = coalesce(p_service, p_override);
        return jsonb_build_object('ok', true, 'повтор', true, 'duty_id', v_id,
                                  'предупреждения', to_jsonb(v_предупр));
    end if;

    return jsonb_build_object('ok', true, 'duty_id', v_id, 'предупреждения', to_jsonb(v_предупр));
end $$;

revoke all on function worship_duty_set(date, uuid, uuid, uuid, text) from public, anon;
grant execute on function worship_duty_set(date, uuid, uuid, uuid, text) to authenticated;