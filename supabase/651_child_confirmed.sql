-- 651: «Ребёнок подтверждён» (ВГ, 08.10.2026, «Шахматка 9»).
-- Ребёнок = есть дата рождения + отметка «подтверждён» (кто и когда). Без отметки человек
-- взрослый — и для кухни (eating_detail, 652), и для детских скидок CRM, даже если дата
-- «детская»: так ошибка в дате (Мадхави Гопи дд, род. «2025») не делает взрослого ребёнком.
-- Подтверждают менеджер CRM (вопрос «Это ребёнок?» при детской дате) или ВГ на месте;
-- «+ ребёнок (без кровати)» в шахматке подтверждает сам.
-- Чтобы менеджер не забыл: задача «Проверить ребёнка» в сделке и запрет перехода в «Готов»,
-- пока вопрос не решён (только для ретритов, которые ещё не закончились).
-- Ребёнок «+1» у родителя (resident_children, 650) за проживание не платит — CRM сама
-- пишет «живёт с родителем (+1)» вместо ручной скидки 100%.

alter table public.vaishnavas
    add column if not exists child_confirmed_at timestamptz,
    add column if not exists child_confirmed_by uuid;

comment on column public.vaishnavas.child_confirmed_at is
    'Ребёнок подтверждён (дата рождения проверена) — только тогда возраст даёт детскую порцию и скидки CRM (651)';

-- Поставить / снять отметку; кто — из сессии
create or replace function public.vaishnava_set_child_confirmed(p_vaishnava uuid, p_confirmed boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if not is_staff(auth.uid()) then raise exception 'forbidden'; end if;
    update vaishnavas
       set child_confirmed_at = case when p_confirmed then now() end,
           child_confirmed_by = case when p_confirmed then auth.uid() end
     where id = p_vaishnava;
end;
$function$;
revoke all on function public.vaishnava_set_child_confirmed(uuid, boolean) from public, anon;
grant execute on function public.vaishnava_set_child_confirmed(uuid, boolean) to authenticated;

-- «+ ребёнок (без кровати)» с карточкой — это и есть подтверждение
create or replace function public.trg_resident_child_confirms()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if new.vaishnava_id is not null then
        update vaishnavas set child_confirmed_at = now(), child_confirmed_by = auth.uid()
         where id = new.vaishnava_id and child_confirmed_at is null;
    end if;
    return new;
end;
$function$;
drop trigger if exists trg_resident_child_confirms on public.resident_children;
create trigger trg_resident_child_confirms after insert on public.resident_children
    for each row execute function public.trg_resident_child_confirms();

-- Что не так с ребёнком в сделке (null — всё в порядке)
create or replace function public.crm_deal_child_issue(d crm_deals)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
    with x as (
        select v.birth_date, v.child_confirmed_at,
               extract(year from age(r.start_date, v.birth_date))::int as возраст,
               exists (select 1 from crm_deal_terms t where t.deal_id = d.id and t.condition_type = 'child')
               or exists (select 1 from retreat_registrations rr
                           where rr.vaishnava_id = d.vaishnava_id and rr.retreat_id = d.retreat_id
                             and not rr.is_deleted and rr.meal_type = 'child') as отмечен
          from vaishnavas v
          join retreats r on r.id = d.retreat_id
         where v.id = d.vaishnava_id
    )
    select case
        when x.child_confirmed_at is not null and x.birth_date is not null then null
        when x.birth_date is null and x.отмечен
            then 'отмечен ребёнком, но нет даты рождения — уточните и впишите её в сделке'
        when x.birth_date is not null and x.возраст < 14
            then format('по дате рождения %s — подтвердите в сделке, что это ребёнок, или исправьте дату',
                        x.возраст || ' ' || case when x.возраст % 10 = 1 and x.возраст % 100 <> 11 then 'год'
                                                 when x.возраст % 10 between 2 and 4 and x.возраст % 100 not between 12 and 14 then 'года'
                                                 else 'лет' end)
        when x.birth_date is not null and x.отмечен
            then format('отмечен ребёнком, а по дате рождения %s лет — проверьте дату', x.возраст)
    end
    from x;
$function$;

create or replace function public.crm_guard_status_transition()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_missing text[];
    v_child text;
begin
    if new.status is not distinct from old.status then return new; end if;

    if old.status = 'working' and new.status = 'invoiced' then
        if coalesce(new.checklist_accommodation, 'unknown') = 'unknown'
           or coalesce(new.checklist_meals, 'unknown') = 'unknown' then
            raise exception 'Нельзя выставить счёт: заполните в чек-листе %', concat_ws(' и ',
                case when coalesce(new.checklist_accommodation, 'unknown') = 'unknown' then 'проживание' end,
                case when coalesce(new.checklist_meals, 'unknown') = 'unknown' then 'питание' end);
        end if;
    end if;

    if new.status in ('checklist', 'ready', 'completed')
       and old.status in ('lead', 'working', 'invoiced', 'booked') then
        if new.arrival_dates_status = 'unconfirmed' or new.departure_dates_status = 'unconfirmed' then
            raise exception 'Нельзя перейти дальше: даты % не уточнены — подтвердите статус дат в чек-листе сделки', concat_ws(' и ',
                case when new.arrival_dates_status = 'unconfirmed' then 'заезда' end,
                case when new.departure_dates_status = 'unconfirmed' then 'выезда' end);
        end if;
        v_missing := crm_deal_dates_missing(new);
        if cardinality(v_missing) > 0 then
            raise exception 'Нельзя перейти дальше: нет даты % — впишите рейс или дату %в ШРСК в чек-листе сделки',
                array_to_string(v_missing, ' и '),
                case when new.checklist_accommodation = 'self' then '(ест с нами) ' else '' end;
        end if;
    end if;

    -- Ребёнок (651): в «Готов» — только когда дата рождения проверена; прошедшие ретриты не трогаем
    if new.status = 'ready' and old.status in ('lead', 'working', 'invoiced', 'booked', 'checklist')
       and exists (select 1 from retreats r where r.id = new.retreat_id and r.end_date >= current_date) then
        v_child := crm_deal_child_issue(new);
        if v_child is not null then
            raise exception 'Нельзя перейти в «Готов»: ребёнок — %', v_child;
        end if;
    end if;

    return new;
end;
$function$;

create or replace function public.crm_create_date_tasks()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_created int := 0; r record;
begin
    for r in
        select d.id, d.manager_id, coalesce(v.spiritual_name, trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), 'гость') as имя
          from crm_deals d
          left join vaishnavas v on v.id = d.vaishnava_id
         where (d.arrival_dates_status = 'unconfirmed' or d.departure_dates_status = 'unconfirmed')
           and d.status in ('working', 'invoiced', 'booked')
           and d.dates_mismatch_detected_at < now() - interval '10 minute'
           and d.manager_id is not null
           and not exists (select 1 from crm_tasks t
                            where t.deal_id = d.id and t.completed_at is null
                              and t.title like 'Уточнить даты%')
    loop
        insert into crm_tasks (deal_id, assignee_id, title, description, due_date, priority, is_auto_created)
        values (r.id, r.manager_id,
                'Уточнить даты: ' || r.имя,
                'Даты рейса расходятся с датами ретрита. Уточните у гостя фактические даты заезда и выезда и подтвердите статус в чек-листе сделки.',
                current_date, 'high', true);
        v_created := v_created + 1;
    end loop;

    for r in
        select d.id, d.manager_id, d.checklist_accommodation,
               coalesce(v.spiritual_name, trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), 'гость') as имя,
               crm_deal_dates_missing(d) as нет
          from crm_deals d
          join retreats ret on ret.id = d.retreat_id
          left join vaishnavas v on v.id = d.vaishnava_id
         where d.status in ('booked', 'checklist', 'ready')
           and ret.start_date - 60 <= current_date
           and ret.end_date >= current_date
           and d.manager_id is not null
           and cardinality(crm_deal_dates_missing(d)) > 0
           and not exists (select 1 from crm_tasks t
                            where t.deal_id = d.id and t.completed_at is null
                              and t.title like 'Уточнить даты%')
    loop
        insert into crm_tasks (deal_id, assignee_id, title, description, due_date, priority, is_auto_created)
        values (r.id, r.manager_id,
                'Уточнить даты: ' || r.имя,
                'Нет даты ' || array_to_string(r.нет, ' и ') || '. Узнайте у гостя, '
                || case when r.checklist_accommodation = 'self'
                        then 'с какого и по какой день он ест с нами (живёт сам),'
                        else 'когда он приезжает к нам и когда уезжает,' end
                || ' и впишите рейс или свою дату в чек-листе сделки. Без дат сделка не перейдёт в чек-лист.',
                current_date, 'high', true);
        v_created := v_created + 1;
    end loop;

    -- Ребёнок (651): детская дата без подтверждения или «ребёнок» без даты — менеджеру сделки
    for r in
        select d.id, d.manager_id, crm_deal_child_issue(d) as что,
               coalesce(v.spiritual_name, trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), 'гость') as имя
          from crm_deals d
          join retreats ret on ret.id = d.retreat_id
          left join vaishnavas v on v.id = d.vaishnava_id
         where d.status in ('working', 'invoiced', 'booked', 'checklist')
           and ret.end_date >= current_date
           and d.manager_id is not null
           and crm_deal_child_issue(d) is not null
           and not exists (select 1 from crm_tasks t
                            where t.deal_id = d.id and t.completed_at is null
                              and t.title like 'Проверить ребёнка%')
    loop
        insert into crm_tasks (deal_id, assignee_id, title, description, due_date, priority, is_auto_created)
        values (r.id, r.manager_id,
                'Проверить ребёнка: ' || r.имя,
                'Ребёнок ' || r.что || '. Ребёнком считается только тот, у кого есть дата рождения и отметка '
                || '«Ребёнок подтверждён»: до 7 лет — не порция и питание бесплатно, до 14 — скидка на оргвзнос. '
                || 'Без этого сделка не перейдёт в «Готов».',
                current_date, 'high', true);
        v_created := v_created + 1;
    end loop;
    return v_created;
end;
$function$;

-- Расчёт участия: возраст — только у подтверждённого ребёнка; «+1» у родителя — без проживания
do $patch$
declare
    src text := pg_get_functiondef('public.crm_calc_participation(uuid)'::regprocedure);
    a text := 'from vaishnavas v where v.id = d.vaishnava_id and v.birth_date is not null;';
    b text := 'from vaishnavas v where v.id = d.vaishnava_id and v.birth_date is not null'
              || E'\n       and v.child_confirmed_at is not null;  -- 651: только подтверждённый ребёнок';
    c text := E'if not v_has_room then\n        acc_note := ''размещение ещё не назначено'';\n    end if;';
    e text := E'if not v_has_room then\n'
              || E'        -- 651: ребёнок «+1» у родителя на этом ретрите — места не занимает, проживание не начисляется\n'
              || E'        acc_note := case when exists (select 1 from resident_children k join residents p on p.id = k.resident_id\n'
              || E'                                       where k.vaishnava_id = d.vaishnava_id and p.retreat_id = d.retreat_id\n'
              || E'                                         and p.status in (''active'', ''confirmed'', ''checked_out''))\n'
              || E'                         then ''живёт с родителем (+1) — проживание не начисляется''\n'
              || E'                         else ''размещение ещё не назначено'' end;\n'
              || E'    end if;';
begin
    if (length(src) - length(replace(src, a, ''))) / length(a) <> 1 then raise exception 'crm_calc_participation: возраст — не найдено'; end if;
    if (length(src) - length(replace(src, c, ''))) / length(c) <> 1 then raise exception 'crm_calc_participation: размещение — не найдено'; end if;
    execute replace(replace(src, a, b), c, e);
end
$patch$;

insert into translations (key, ru, en, hi, context) values
('child_confirmed', 'Ребёнок подтверждён', 'Child confirmed', 'बच्चा पुष्टि', 'Карточка'),
('child_confirm_q', 'По дате рождения — {age}. Это ребёнок?', 'By date of birth — {age}. Is this a child?', 'जन्म तिथि के अनुसार — {age}। क्या यह बच्चा है?', 'CRM'),
('child_not_confirmed', 'Детская дата не подтверждена — считаем взрослым', 'Child date not confirmed — counted as adult', 'बच्चे की तिथि पुष्टि नहीं — वयस्क माना', 'CRM'),
('child_confirm_btn', 'Это ребёнок', 'This is a child', 'यह बच्चा है', 'CRM'),
('prasad_child_unconfirmed', 'Детская дата без подтверждения', 'Child date not confirmed', 'बच्चे की तिथि पुष्टि नहीं', 'Прасад')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
