-- 590: даты заезда/выезда обязательны для движения сделки (дыры в 391)
--
-- В 391 проверка дат срабатывала только при расхождении рейса с ретритом
-- (статус «не уточнено»). Проходили дальше без вопросов:
--   • сделки совсем без дат — ни рейса, ни своей даты: сравнивать не с чем;
--   • «Не совпадает с рейсом» / «Билеты не нужны» без вписанной своей даты;
--   • прыжок через стадию (счёт выставлен → чек-лист/готов): запрет стоял
--     только на шаге «Забронировано → Чек-лист».
-- На Сева-ретрите так в чек-лист прошли 7 сделок без даты приезда и 24 без
-- даты выезда — кухня не знала, когда их кормить (ВГ, 29.09.2026).
--
-- Теперь:
--   • crm_deal_dates_missing — каких дат не хватает; «сам живёт и сам ест» —
--     даты нам не нужны;
--   • вход в «Чек-лист», «Готов», «Завершено» с более ранней стадии — только
--     при известных датах (и без «не уточнено»);
--   • задача «Уточнить даты» по сделкам без дат — со стадии «Забронировано»,
--     за 60 дней до начала ретрита (решение ВГ), пока ретрит не закончился.
--     Красная точка на карточке — сразу, это в crm/index.html.

create or replace function crm_deal_dates_missing(d crm_deals)
returns text[]
language sql
stable
set search_path to 'public'
as $function$
    select case
        when d.checklist_accommodation = 'self' and d.checklist_meals = 'self' then '{}'::text[]
        else array_remove(array[
            case when not (
                case when d.arrival_dates_status = 'custom' or d.checklist_tickets = 'not_needed'
                     then d.stay_check_in is not null
                     else d.arrival_datetime is not null end) then 'заезда' end,
            case when not (
                case when d.departure_dates_status = 'custom' or d.checklist_tickets = 'not_needed'
                     then d.stay_check_out is not null
                     else d.departure_datetime is not null end) then 'выезда' end
        ], null)
    end;
$function$;

create or replace function public.crm_guard_status_transition()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_missing text[];
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

    -- Вход в чек-лист и дальше — с любой более ранней стадии, не только с «Забронировано»
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
    -- Расхождение рейса с ретритом (как в 391)
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

    -- Дат нет совсем: со стадии «Забронировано», за 60 дней до начала ретрита
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
    return v_created;
end;
$function$;
