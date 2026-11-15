-- 301: кто ведёт расписание, тот выводит людей в резерв и возвращает
-- (просьба для Ямуны-расы, 15.11.2026).
--
-- Раньше «В резерв» и «Вернуть» были только у старшего (worship_approve):
-- правка шла прямо в worship_people, а её политика пускает лишь старших.
-- Расширять ту политику нельзя — она открыла бы и остальные поля состава.
-- Поэтому одна узкая функция: меняет только is_active (и при возврате
-- снимает истёкший срок). Добавлять людей, убирать из резерва совсем,
-- заметки и утверждение остаются у старших.

create or replace function worship_can_reserve()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
    select worship_can_approve() or abk_current_user_has_permission('worship_schedule')
$$;
revoke all on function worship_can_reserve() from public, anon;
grant execute on function worship_can_reserve() to authenticated;

create or replace function worship_person_set_reserve(p_person uuid, p_reserve boolean)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    v_человек worship_people%rowtype;
begin
    if not worship_can_reserve() then
        raise exception 'Резерв ведёт старший пуджари или тот, кто ведёт расписание' using errcode = '42501';
    end if;
    select * into v_человек from worship_people where id = p_person for update;
    if not found or v_человек.removed_at is not null then
        raise exception 'Человек не найден в отделе';
    end if;

    update worship_people
       set is_active  = not p_reserve,
           -- вернувшийся не должен сразу гореть «срок истёк»
           active_to  = case when not p_reserve and active_to < current_date then null else active_to end,
           updated_at = now(),
           updated_by = auth.uid()
     where id = p_person;

    return jsonb_build_object('ok', true);
end $$;
revoke all on function worship_person_set_reserve(uuid, boolean) from public, anon;
grant execute on function worship_person_set_reserve(uuid, boolean) to authenticated;

-- что потеряется при выводе в резерв: теперь и для ведущих расписание.
-- Число заметок о человеке — только старшему: сами заметки видит лишь он.
create or replace function worship_person_impact(p_person uuid)
returns jsonb language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select case when not worship_can_reserve() then jsonb_build_object('ok', false) else jsonb_build_object(
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
        'заметок', case when worship_can_approve()
                        then (select count(*) from worship_person_notes n where n.person_id = p_person) end) end
$$;
