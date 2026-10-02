-- Департамент у места в шахматке (ТЗ брони 01.10, п. 5; решение ВГ 02.10.2026).
-- Волонтёра и команду бронируют сразу под департамент — раньше его писали в «Примечания».
-- Если в месте есть человек, департамент пишется в его историю служения (мигр. 599)
-- ровно на даты проживания: периоды вне этих дат не трогаются, соседние того же
-- департамента склеиваются. vaishnavas.department_id (текущий) — по истории на сегодня.
-- Ограничение: снятая или укороченная бронь историю назад не откатывает — она про то,
-- где человек служил, и правится в карточке.

alter table residents add column if not exists department_id uuid references departments(id);

-- Записать департамент на период [p_from; p_to] (null — без границы)
create or replace function vaishnava_department_set_range(p_vaishnava uuid, p_department uuid, p_from date, p_to date)
returns void language plpgsql security definer set search_path = public as $$
declare
    r   vaishnava_departments;
    f   date := coalesce(p_from, '-infinity'::date);
    t   date := coalesce(p_to, 'infinity'::date);
    v_new uuid;
    v_nb  vaishnava_departments;
begin
    if p_vaishnava is null or p_department is null then return; end if;
    -- вырезаем период из пересекающихся записей
    for r in select * from vaishnava_departments
              where vaishnava_id = p_vaishnava
                and coalesce(date_from, '-infinity'::date) <= t
                and coalesce(date_to, 'infinity'::date) >= f
              order by date_from nulls first for update loop
        if coalesce(r.date_from, '-infinity'::date) < f and coalesce(r.date_to, 'infinity'::date) > t then
            update vaishnava_departments set date_to = f - 1 where id = r.id;
            insert into vaishnava_departments (vaishnava_id, department_id, date_from, date_to)
            values (p_vaishnava, r.department_id, t + 1, r.date_to);
        elsif coalesce(r.date_from, '-infinity'::date) < f then
            update vaishnava_departments set date_to = f - 1 where id = r.id;
        elsif coalesce(r.date_to, 'infinity'::date) > t then
            update vaishnava_departments set date_from = t + 1 where id = r.id;
        else
            delete from vaishnava_departments where id = r.id;
        end if;
    end loop;

    insert into vaishnava_departments (vaishnava_id, department_id, date_from, date_to)
    values (p_vaishnava, p_department, p_from, p_to) returning id into v_new;

    -- склеиваем с соседями того же департамента (сначала удалить соседа — периоды не пересекаются)
    if p_from is not null then
        select * into v_nb from vaishnava_departments
         where vaishnava_id = p_vaishnava and department_id = p_department and date_to = p_from - 1;
        if found then
            delete from vaishnava_departments where id = v_nb.id;
            update vaishnava_departments set date_from = v_nb.date_from where id = v_new;
        end if;
    end if;
    if p_to is not null then
        select * into v_nb from vaishnava_departments
         where vaishnava_id = p_vaishnava and department_id = p_department and date_from = p_to + 1;
        if found then
            delete from vaishnava_departments where id = v_nb.id;
            update vaishnava_departments set date_to = v_nb.date_to where id = v_new;
        end if;
    end if;

    -- текущий департамент — по истории на сегодня (триггер мигр. 599 увидит совпадение и ничего не тронет)
    update vaishnavas set department_id = vaishnava_department_on(p_vaishnava, current_date)
     where id = p_vaishnava
       and department_id is distinct from vaishnava_department_on(p_vaishnava, current_date);
end $$;
revoke all on function vaishnava_department_set_range(uuid, uuid, date, date) from public, anon, authenticated;

-- Место с человеком и департаментом → история служения на даты места
create or replace function trg_resident_department_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.vaishnava_id is null or new.department_id is null or new.status = 'cancelled' then return null; end if;
    if tg_op = 'UPDATE'
       and new.department_id is not distinct from old.department_id
       and new.vaishnava_id is not distinct from old.vaishnava_id
       and new.check_in is not distinct from old.check_in
       and new.check_out is not distinct from old.check_out
       and new.status is not distinct from old.status then
        return null;
    end if;
    perform vaishnava_department_set_range(new.vaishnava_id, new.department_id, new.check_in, new.check_out);
    return null;
end $$;

drop trigger if exists trg_resident_department_history on residents;
create trigger trg_resident_department_history
    after insert or update of department_id, vaishnava_id, check_in, check_out, status on residents
    for each row execute function trg_resident_department_history();
