-- 284: «Резерв» вместо «Вышли из отдела» и «Убрать из резерва».
--
-- Человек не рядом — его выводят в резерв (is_active = false) и потом
-- возвращают. Кого-то из резерва убирают совсем (решение Адриана
-- 19.10.2026). Строку не удаляем: на ней держатся прошлые службы, по
-- которым считается «Загрузка», и авторство правок. Убранный просто
-- пропадает со страницы людей; добавить его снова можно как нового.

alter table worship_people
    add column if not exists removed_at timestamptz,
    add column if not exists removed_by uuid;

-- в списке — мирское имя для поиска и пометка «убран»
drop function if exists worship_people_list();
create function worship_people_list()
returns table(id uuid, vaishnava_id uuid, kind text, is_active boolean, active_from date, active_to date,
              name text, user_id uuid, has_telegram boolean, phone text, worldly text, removed_at timestamptz)
language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select p.id, p.vaishnava_id, p.kind, p.is_active, p.active_from, p.active_to,
           coalesce(nullif(v.spiritual_name, ''),
                    nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                    'без имени'),
           v.user_id,
           exists (select 1 from tg_user_links l where l.vaishnava_id = v.id),
           case when is_superuser(auth.uid()) or is_staff(auth.uid())
                     or has_permission(auth.uid(), 'view_vaishnavas')
                     or has_permission(auth.uid(), 'edit_vaishnava')
                then v.phone end,
           nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
           p.removed_at
      from worship_people p
      join vaishnavas v on v.id = p.vaishnava_id
     where worship_can_view()
$$;
revoke all on function worship_people_list() from public, anon;
grant execute on function worship_people_list() to authenticated;

-- убрать из резерва: только старший и только того, кто уже в резерве
create or replace function worship_person_remove(p_person uuid)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    v_человек worship_people%rowtype;
    v_снято   integer;
begin
    if not worship_can_approve() then
        raise exception 'Убирать людей может старший пуджари' using errcode = '42501';
    end if;
    select * into v_человек from worship_people where id = p_person for update;
    if not found then raise exception 'Человек не найден в отделе'; end if;
    if v_человек.is_active then
        raise exception 'Сначала выведите человека в резерв';
    end if;

    -- впереди ему не служить: клетки освобождаем, прошлое не трогаем
    delete from worship_duties where person_id = p_person and duty_date >= current_date;
    get diagnostics v_снято = row_count;

    update worship_people
       set removed_at = now(), removed_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
     where id = p_person;

    return jsonb_build_object('ok', true, 'снято_назначений', v_снято);
end $$;
revoke all on function worship_person_remove(uuid) from public, anon;
grant execute on function worship_person_remove(uuid) to authenticated;
