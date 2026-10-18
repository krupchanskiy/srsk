-- Этап 2, блок 2.2: назначения, копия недели, недоступность.
--
-- Жёстко проверяется только недоступность: человек сам сказал, что его нет.
-- Отсутствие допуска, занятость в то же время и перегруз — предупреждения,
-- которые функция возвращает интерфейсу. Иначе ломается сценарий, ради
-- которого всё и делается: старший вправе поставить кого угодно.

-- кто я в отделе
create or replace function worship_my_person() returns uuid
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select p.id from worship_people p
      join vaishnavas v on v.id = p.vaishnava_id
     where v.user_id = auth.uid()
     limit 1
$$;

revoke all on function worship_my_person() from public, anon;
grant execute on function worship_my_person() to authenticated;

-- недоступен ли человек в этот день
create or replace function worship_is_away(p_person uuid, p_date date) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select exists (
        select 1 from worship_absences a
         where a.person_id = p_person
           and p_date between a.date_from and coalesce(a.date_to, 'infinity'::date))
$$;

revoke all on function worship_is_away(uuid, date) from public, anon;
grant execute on function worship_is_away(uuid, date) to authenticated;

-- ── поставить человека на службу ─────────────────────────────────────────────
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
        v_предупр := v_предупр || 'срок участия к этому дню истекает';
    end if;
    if v_человек.active_from is not null and p_date < v_человек.active_from then
        v_предупр := v_предупр || 'человек ещё не приступил';
    end if;
    if p_service is not null and not exists (
        select 1 from worship_person_services ps
         where ps.person_id = p_person and ps.service_id = p_service) then
        v_предупр := v_предупр || 'не отмечен допуск на эту службу';
    end if;
    if exists (
        select 1 from worship_duties d
          left join worship_services s on s.id = d.service_id
          left join worship_day_overrides o on o.id = d.override_id
         where d.duty_date = p_date and d.person_id = p_person
           and coalesce(s.time_of_day, o.time_of_day) = v_время
           and coalesce(d.service_id, d.override_id) is distinct from coalesce(p_service, p_override)) then
        v_предупр := v_предупр || 'в это же время он уже на другой службе';
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

-- ── снять назначение ──────────────────────────────────────────────────────────
create or replace function worship_duty_clear(p_duty uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
    if not worship_can_approve() then
        raise exception 'Снимать назначения может старший пуджари' using errcode = '42501';
    end if;
    delete from worship_duties where id = p_duty;
    return jsonb_build_object('ok', true);
end $$;

revoke all on function worship_duty_clear(uuid) from public, anon;
grant execute on function worship_duty_clear(uuid) to authenticated;

-- ── «как на прошлой неделе» ───────────────────────────────────────────────────
-- Повторное нажатие ничего не удваивает: уже стоящие назначения пропускаются,
-- недоступные в новую дату — тоже, и о них сообщается отдельно.
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

    for r in
        select d.*, v.spiritual_name, v.first_name, v.last_name
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
         where d.duty_date between p_from and p_from + 6
           -- разовые службы не переносятся: праздник был один раз
           and d.service_id is not null
           and p.is_active
         order by d.duty_date
    loop
        if worship_is_away(r.person_id, r.duty_date + v_сдвиг) then
            v_пропуск := v_пропуск + 1;
            v_имена := v_имена || coalesce(r.spiritual_name,
                btrim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')));
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

-- ── недоступность: человек отмечает её сам ────────────────────────────────────
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
    v_свой := (p_person = worship_my_person());
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
        for v_старший in
            select distinct v.user_id
              from vaishnavas v
             where v.user_id is not null
               and abk_user_has_permission_by_user(v.user_id, 'worship_approve')
        loop
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

create or replace function worship_absence_clear(p_absence uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_person uuid;
begin
    select person_id into v_person from worship_absences where id = p_absence;
    if not found then return jsonb_build_object('ok', true); end if;
    if v_person is distinct from worship_my_person() and not worship_can_approve() then
        raise exception 'Снять отметку может сам человек или старший пуджари' using errcode = '42501';
    end if;
    delete from worship_absences where id = p_absence;
    return jsonb_build_object('ok', true);
end $$;

revoke all on function worship_absence_clear(uuid) from public, anon;
grant execute on function worship_absence_clear(uuid) to authenticated;

-- ── последствия исключения человека ───────────────────────────────────────────
create or replace function worship_person_impact(p_person uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select jsonb_build_object(
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
        'заметок', (select count(*) from worship_person_notes n where n.person_id = p_person))
$$;

revoke all on function worship_person_impact(uuid) from public, anon;
grant execute on function worship_person_impact(uuid) to authenticated;

-- ── для портала гостя: времена служб на день, без имён ───────────────────────
create or replace function worship_day_for_guest(p_date date)
returns jsonb language sql security definer set search_path to 'public', 'pg_temp' as $$
    select jsonb_build_object('ok', true, 'дата', p_date, 'службы', coalesce((
        select jsonb_agg(служба order by служба->>'время')
          from (
            select jsonb_build_object('название', s.name_ru, 'name_en', s.name_en,
                                      'name_hi', s.name_hi, 'время', to_char(s.time_of_day, 'HH24:MI'),
                                      'разовая', false) as служба
              from worship_services s
             where s.is_active
               and not exists (select 1 from worship_day_overrides o
                                where o.duty_date = p_date and o.service_id = s.id)
            union all
            select jsonb_build_object('название', o.title, 'name_en', null, 'name_hi', null,
                                      'время', to_char(o.time_of_day, 'HH24:MI'),
                                      'разовая', true)
              from worship_day_overrides o
             where o.duty_date = p_date and o.title is not null
          ) t), '[]'::jsonb))
$$;

revoke all on function worship_day_for_guest(date) from public, anon, authenticated;
