-- Департамент: одна база для карточки и шахматки (ВГ 08.10.2026, случай Джаганнатха Прасада).
-- Шахматка → карточка уже есть (мигр. 614: место пишет департамент в историю служения).
-- Здесь обратное: перевод в карточке → тот же департамент у мест человека в шахматке,
-- которые идут с даты перевода и позже. Место берёт департамент на свой первый день
-- после даты перевода. Историю служения это не переписывает (флаг srsk.dept_from_card
-- глушит триггер мигр. 614) — иначе перевод с середины проживания растянулся бы на всё место.
-- Места гостей без департамента не трогаем: только команда/волонтёр или где он уже указан.

create or replace function resident_department_from_card(p_vaishnava uuid, p_from date)
returns void language plpgsql security definer set search_path = public as $$
begin
    perform set_config('srsk.dept_from_card', 'on', true);
    update residents r
       set department_id = vaishnava_department_on(r.vaishnava_id, greatest(r.check_in, coalesce(p_from, r.check_in)))
     where r.vaishnava_id = p_vaishnava
       and r.status <> 'cancelled'
       and (p_from is null or coalesce(r.check_out, 'infinity'::date) >= p_from)
       and (r.department_id is not null
            or r.category_id in (select id from resident_categories where slug in ('team', 'volunteer')))
       and r.department_id is distinct from
           vaishnava_department_on(r.vaishnava_id, greatest(r.check_in, coalesce(p_from, r.check_in)));
    perform set_config('srsk.dept_from_card', 'off', true);
end $$;
revoke all on function resident_department_from_card(uuid, date) from public, anon, authenticated;

-- Перевод в истории (из карточки или прямой правкой vaishnavas.department_id) → места в шахматке
create or replace function vaishnava_department_apply(p_vaishnava uuid, p_department uuid, p_from date)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_prev vaishnava_departments;
begin
    delete from vaishnava_departments
     where vaishnava_id = p_vaishnava and p_from is not null and date_from >= p_from;
    if p_from is null then
        delete from vaishnava_departments where vaishnava_id = p_vaishnava;
    end if;
    update vaishnava_departments set date_to = p_from - 1
     where vaishnava_id = p_vaishnava and p_from is not null
       and coalesce(date_from, '-infinity'::date) < p_from
       and coalesce(date_to, 'infinity'::date) >= p_from;
    if p_department is not null then
        -- тот же департамент вплотную — продлеваем период, а не плодим новый
        select * into v_prev from vaishnava_departments
         where vaishnava_id = p_vaishnava and date_to = p_from - 1 and department_id = p_department;
        if found then
            update vaishnava_departments set date_to = null where id = v_prev.id;
        else
            insert into vaishnava_departments (vaishnava_id, department_id, date_from)
            values (p_vaishnava, p_department, p_from);
        end if;
    end if;
    perform resident_department_from_card(p_vaishnava, p_from);
end $$;
revoke all on function vaishnava_department_apply(uuid, uuid, date) from public, anon, authenticated;

-- Триггер мигр. 614: правка пришла из карточки — историю не трогаем
create or replace function trg_resident_department_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if current_setting('srsk.dept_from_card', true) = 'on' then return null; end if;
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

-- Разово: текущие и будущие места команды/волонтёров без департамента — из карточки
select set_config('srsk.dept_from_card', 'on', true);
update residents r
   set department_id = vaishnava_department_on(r.vaishnava_id, greatest(r.check_in, current_date))
 where r.department_id is null
   and r.vaishnava_id is not null
   and r.status <> 'cancelled'
   and coalesce(r.check_out, 'infinity'::date) >= current_date
   and r.category_id in (select id from resident_categories where slug in ('team', 'volunteer'))
   and vaishnava_department_on(r.vaishnava_id, greatest(r.check_in, current_date)) is not null;
select set_config('srsk.dept_from_card', 'off', true);
