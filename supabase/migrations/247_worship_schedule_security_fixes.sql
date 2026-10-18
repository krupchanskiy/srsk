-- Починки по разбору прав расписания.
--
-- Главное: сравнение с NULL — не «ложь», а «неизвестно», и условие
-- `not v_свой and not worship_can_approve()` при v_свой = NULL не срабатывало
-- вовсе. У кого нет карточки в отделе, тот проходил проверку прав насквозь
-- и ставил отметку недоступности любому человеку — а это единственная
-- жёсткая проверка в назначении, то есть способ вывести человека
-- из расписания целиком.
create or replace function worship_absence_set(
    p_person uuid, p_from date, p_to date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
    v_свой    boolean;
    v_id      uuid;
    v_клеток  integer;
    v_имя     text;
    v_старший uuid;
begin
    if p_person is null or p_from is null then raise exception 'Не указан человек или дата'; end if;
    if not worship_can_view() then
        raise exception 'Расписание отдела недоступно' using errcode = '42501';
    end if;

    -- coalesce обязателен: вызывающего может не быть в отделе вовсе
    v_свой := coalesce(p_person = worship_my_person(), false);
    if not v_свой and not worship_can_approve() then
        raise exception 'Отмечать недоступность может сам человек или старший пуджари' using errcode = '42501';
    end if;
    if p_to is not null and p_to < p_from then
        raise exception 'Дата окончания раньше начала';
    end if;

    begin
        insert into worship_absences (person_id, date_from, date_to, reason, created_by)
        values (p_person, p_from, p_to, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
        returning id into v_id;
    exception when exclusion_violation then
        raise exception 'На эти дни отметка уже стоит';
    end;

    -- назначения не снимаем молча: старший должен решить сам, кем заменить
    select count(*) into v_клеток from worship_duties d
     where d.person_id = p_person
       and d.duty_date between p_from and coalesce(p_to, p_from + 30);

    select coalesce(v.spiritual_name, btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')))
      into v_имя
      from worship_people p join vaishnavas v on v.id = p.vaishnava_id
     where p.id = p_person;

    -- старшему — отметка о событии; рассылка живёт отдельно и включается рубильником
    if v_свой then
        for v_старший in select worship_holders('worship_approve') loop
            perform worship_event('absence_set', null, null, null, v_старший,
                                  'absence:' || v_id || ':' || v_старший,
                                  jsonb_build_object('имя', v_имя, 'с', p_from, 'по', p_to,
                                                     'клеток', v_клеток));
        end loop;
    end if;

    return jsonb_build_object('ok', true, 'absence_id', v_id, 'назначений', v_клеток);
end $$;

revoke all on function worship_absence_set(uuid, date, date, text) from public, anon;
grant execute on function worship_absence_set(uuid, date, date, text) to authenticated;

-- Снятие отметки: там же явная проверка доступа к модулю.
create or replace function worship_absence_clear(p_absence uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_person uuid;
begin
    if not worship_can_view() then
        raise exception 'Расписание отдела недоступно' using errcode = '42501';
    end if;
    select person_id into v_person from worship_absences where id = p_absence;
    if not found then return jsonb_build_object('ok', true); end if;
    if not coalesce(v_person = worship_my_person(), false) and not worship_can_approve() then
        raise exception 'Снять отметку может сам человек или старший пуджари' using errcode = '42501';
    end if;
    delete from worship_absences where id = p_absence;
    return jsonb_build_object('ok', true);
end $$;

revoke all on function worship_absence_clear(uuid) from public, anon;
grant execute on function worship_absence_clear(uuid) to authenticated;

-- Служебные функции отвечали кому угодно вошедшему: кто из старших в отъезде,
-- сколько у человека заметок (самих заметок не видит даже пуджари), занят ли он.
create or replace function worship_approvers_away()
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select case when not worship_can_view() then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
               'имя', coalesce(v.spiritual_name,
                       btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))),
               'по', a.date_to)
           order by a.date_from), '[]'::jsonb) end
      from worship_absences a
      join worship_people p on p.id = a.person_id
      join vaishnavas v on v.id = p.vaishnava_id
     where v.user_id in (select worship_holders('worship_approve'))
       and current_date between a.date_from and coalesce(a.date_to, 'infinity'::date)
$$;

revoke all on function worship_approvers_away() from public, anon;
grant execute on function worship_approvers_away() to authenticated;

create or replace function worship_is_away(p_person uuid, p_date date) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select worship_can_view() and exists (
        select 1 from worship_absences a
         where a.person_id = p_person
           and p_date between a.date_from and coalesce(a.date_to, 'infinity'::date))
$$;

revoke all on function worship_is_away(uuid, date) from public, anon;
grant execute on function worship_is_away(uuid, date) to authenticated;

create or replace function worship_approvers_count() returns integer
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select case when worship_can_view()
                then (select count(*)::integer from (select worship_holders('worship_approve')) t)
                else 0 end
$$;

revoke all on function worship_approvers_count() from public, anon;
grant execute on function worship_approvers_count() to authenticated;

-- Последствия вывода из отдела считает тот, кто выводит.
create or replace function worship_person_impact(p_person uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select case when not worship_can_approve() then jsonb_build_object('ok', false) else jsonb_build_object(
        'назначений_впереди', (select count(*) from worship_duties d
                                where d.person_id = p_person and d.duty_date >= current_date),
        'ближайшая', (select min(d.duty_date) from worship_duties d
                       where d.person_id = p_person and d.duty_date >= current_date),
        'черновиков', (select count(*) from worship_versions v
                         join worship_people p on p.id = p_person
                         join vaishnavas vs on vs.id = p.vaishnava_id
                        where v.status in ('draft', 'submitted') and v.created_by = vs.user_id),
        'наборов', (select count(*) from worship_albums al
                      join worship_people p on p.id = p_person
                      join vaishnavas vs on vs.id = p.vaishnava_id
                     where al.created_by = vs.user_id),
        'заметок', (select count(*) from worship_person_notes n where n.person_id = p_person)) end
$$;

revoke all on function worship_person_impact(uuid) from public, anon;
grant execute on function worship_person_impact(uuid) to authenticated;

-- «Кто я в отделе» — сведение о себе, но модуль всё же должен быть доступен.
create or replace function worship_my_person() returns uuid
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select p.id from worship_people p
      join vaishnavas v on v.id = p.vaishnava_id
     where v.user_id = auth.uid() and worship_can_view()
     limit 1
$$;

revoke all on function worship_my_person() from public, anon;
grant execute on function worship_my_person() to authenticated;

-- Копия недели переносила назначения на отключённую службу — в шахматке
-- появлялись люди на службе, которой в расписании больше нет. И сдвиг
-- обязан быть кратен неделе: иначе источник и цель перекрываются.
create or replace function worship_week_copy(p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
    v_сдвиг    integer;
    v_перенос  integer := 0;
    v_пропуск  integer := 0;
    v_имена    text[] := '{}';
    r          record;
begin
    if not worship_can_approve() then
        raise exception 'Расписывать людей может старший пуджари' using errcode = '42501';
    end if;
    if p_from is null or p_to is null then raise exception 'Не указаны недели'; end if;

    v_сдвиг := p_to - p_from;
    if v_сдвиг = 0 then raise exception 'Это одна и та же неделя'; end if;
    if v_сдвиг % 7 <> 0 then
        raise exception 'Переносить можно только на целое число недель';
    end if;

    for r in
        select d.*, v.spiritual_name, v.first_name, v.last_name
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
          -- отключённая служба не переезжает: её больше нет в распорядке
          join worship_services s on s.id = d.service_id and s.is_active
         where d.duty_date between p_from and p_from + 6
           and p.is_active
         order by d.duty_date
    loop
        if worship_is_away(r.person_id, r.duty_date + v_сдвиг) then
            v_пропуск := v_пропуск + 1;
            v_имена := array_append(v_имена, coalesce(r.spiritual_name,
                btrim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, ''))));
            continue;
        end if;
        if exists (select 1 from worship_day_overrides o
                    where o.duty_date = r.duty_date + v_сдвиг and o.service_id = r.service_id) then
            v_пропуск := v_пропуск + 1;
            continue;
        end if;

        insert into worship_duties (duty_date, service_id, person_id, role, created_by)
        values (r.duty_date + v_сдвиг, r.service_id, r.person_id, r.role, auth.uid())
        on conflict do nothing;
        if found then v_перенос := v_перенос + 1; end if;
    end loop;

    return jsonb_build_object('ok', true, 'перенесено', v_перенос, 'пропущено', v_пропуск,
                              'недоступны', to_jsonb(array(select distinct unnest(v_имена))));
end $$;

revoke all on function worship_week_copy(date, date) from public, anon;
grant execute on function worship_week_copy(date, date) to authenticated;

-- «Срок участия к этому дню истекает» про уже истёкший срок читается странно.
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
        v_предупр := array_append(v_предупр, case when v_человек.active_to < current_date
            then 'срок участия истёк' else 'срок участия к этому дню истекает' end);
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

-- Журнал «кто завёл» не переписывается с клиента.
drop policy if exists "worship services write" on worship_services;
create policy "worship services write" on worship_services for insert
with check (worship_can_approve() and (created_by is null or created_by = auth.uid()));

drop policy if exists "worship people write" on worship_people;
create policy "worship people write" on worship_people for insert
with check (worship_can_approve() and (created_by is null or created_by = auth.uid()));

drop policy if exists "worship day overrides write" on worship_day_overrides;
create policy "worship day overrides write" on worship_day_overrides for insert
with check (worship_can_approve() and (created_by is null or created_by = auth.uid()));

drop trigger if exists worship_services_lock on worship_services;
create trigger worship_services_lock before update on worship_services
for each row execute function worship_lock_columns('created_by');

drop trigger if exists worship_people_lock on worship_people;
create trigger worship_people_lock before update on worship_people
for each row execute function worship_lock_columns('created_by', 'vaishnava_id');

-- Аноним получал 403 от worship_can_view вместо пустого ответа: функция
-- и так возвращает false без вошедшего пользователя.
grant execute on function worship_can_view() to anon;
