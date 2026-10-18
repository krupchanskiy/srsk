-- Старшие берутся тем же способом, что и в этапе 1: worship_holders.
-- Выдуманной abk_user_has_permission_by_user в базе нет, и отметка
-- недоступности падала бы ровно в момент, когда человек болен.
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
