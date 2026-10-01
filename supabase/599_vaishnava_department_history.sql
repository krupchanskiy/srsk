-- История департаментов человека: кто в каком департаменте служил и с какого по какое число.
-- Питание команды и волонтёров ложится на департамент того дня, когда человек ел, —
-- перевод в другой департамент не перетаскивает прошлые расходы (случай Амалы-Камалы, 01.10.2026).
-- vaishnavas.department_id остаётся «текущим» департаментом и синхронизируется с историей.

create table if not exists vaishnava_departments (
    id            uuid primary key default gen_random_uuid(),
    vaishnava_id  uuid not null references vaishnavas(id) on delete cascade,
    department_id uuid not null references departments(id),
    date_from     date,          -- null — с самого начала
    date_to       date,          -- null — по сей день
    created_at    timestamptz not null default now(),
    created_by    uuid default auth.uid(),
    check (date_from is null or date_to is null or date_to >= date_from),
    -- периоды одного человека не пересекаются
    exclude using gist (vaishnava_id with =,
        daterange(coalesce(date_from, '-infinity'::date), coalesce(date_to, 'infinity'::date), '[]') with &&)
);
create index if not exists vaishnava_departments_vaishnava_idx on vaishnava_departments (vaishnava_id);

alter table vaishnava_departments enable row level security;
drop policy if exists vaishnava_departments_select on vaishnava_departments;
create policy vaishnava_departments_select on vaishnava_departments
    for select to authenticated using (true);
-- Записи — только через функции ниже

-- «С даты p_from — департамент p_department» (null — без департамента).
-- Всё, что было с этой даты и позже, заменяется; предыдущий период закрывается днём раньше.
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
end $$;
revoke all on function vaishnava_department_apply(uuid, uuid, date) from public, anon, authenticated;

-- Департамент человека на дату
create or replace function vaishnava_department_on(p_vaishnava uuid, p_date date)
returns uuid language sql stable security definer set search_path = public as $$
    select department_id from vaishnava_departments
     where vaishnava_id = p_vaishnava
       and coalesce(date_from, '-infinity'::date) <= p_date
       and coalesce(date_to, 'infinity'::date) >= p_date
$$;
grant execute on function vaishnava_department_on(uuid, date) to authenticated;

-- Перевод из карточки человека: с какой даты (не позже сегодня) — какой департамент
create or replace function set_vaishnava_department(p_vaishnava uuid, p_department uuid, p_from date)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
begin
    if not exists (select 1 from vaishnavas v where v.id = p_vaishnava and (
            is_superuser(v_uid) or has_permission(v_uid, 'edit_vaishnava')
            or (v.user_id = v_uid and has_permission(v_uid, 'edit_own_profile')))) then
        raise exception 'Нет прав менять департамент';
    end if;
    if p_from is null or p_from > current_date then
        raise exception 'Дата перевода — не позже сегодняшней';
    end if;
    perform vaishnava_department_apply(p_vaishnava, p_department, p_from);
    -- текущий департамент — по истории на сегодня (триггер ниже увидит совпадение и ничего не тронет)
    update vaishnavas set department_id = vaishnava_department_on(p_vaishnava, current_date)
     where id = p_vaishnava;
end $$;
grant execute on function set_vaishnava_department(uuid, uuid, date) to authenticated;

-- Любая другая правка vaishnavas.department_id (без даты) — перевод с сегодняшнего дня;
-- департамент при создании человека — с самого начала
create or replace function trg_vaishnava_department_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if tg_op = 'INSERT' then
        if new.department_id is not null then
            perform vaishnava_department_apply(new.id, new.department_id, null);
        end if;
    elsif new.department_id is distinct from old.department_id
          and new.department_id is distinct from vaishnava_department_on(new.id, current_date) then
        perform vaishnava_department_apply(new.id, new.department_id, current_date);
    end if;
    return null;
end $$;

drop trigger if exists trg_vaishnava_department_history on vaishnavas;
create trigger trg_vaishnava_department_history
    after insert or update of department_id on vaishnavas
    for each row execute function trg_vaishnava_department_history();

-- Перенос: у кого департамент уже указан — считаем, что с самого начала
insert into vaishnava_departments (vaishnava_id, department_id, date_from)
select v.id, v.department_id, null from vaishnavas v
 where v.department_id is not null
   and not exists (select 1 from vaishnava_departments h where h.vaishnava_id = v.id);

insert into translations (key, ru, en, hi, context) values
('dept_from_date', 'С какого числа в этом департаменте', 'In this department since', 'इस विभाग में किस तिथि से', 'Карточка'),
('dept_from_date_hint', 'Питание до этой даты остаётся на прежнем департаменте', 'Meals before this date stay with the previous department', 'इस तिथि से पहले का भोजन पिछले विभाग पर ही रहेगा', 'Карточка'),
('dept_history', 'История департаментов', 'Department history', 'विभागों का इतिहास', 'Карточка'),
('dept_since_start', 'с начала', 'from the start', 'शुरुआत से', 'Карточка'),
('dept_till_now', 'по сей день', 'to date', 'अब तक', 'Карточка'),
('cost_by_department_hint', 'Департамент — на каждый день по истории в карточке человека: после перевода прошлые дни остаются на прежнем департаменте. Стоимость — приёмы пищи человека по стоимости приёма пищи его ретрита или категории.', 'Department is taken for each day from the person''s department history: after a transfer, earlier days stay with the previous department. Cost is the person''s meals at the meal cost of their retreat or category.', 'विभाग — व्यक्ति के कार्ड के इतिहास से हर दिन के लिए: स्थानांतरण के बाद पिछले दिन पुराने विभाग पर रहते हैं। लागत — व्यक्ति के भोजन, उसके रिट्रीट या श्रेणी की प्रति भोजन लागत पर।', 'Себестоимость')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
