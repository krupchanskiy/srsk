-- «Повторить неделю»: копия не должна расставлять тех, кого поставить нельзя,
-- и не должна вписываться поверх того, что старший уже расписал руками.
--
-- Было:
--   * волонтёр с истёкшим сроком (или ещё не приехавший) переезжал в новую
--     неделю — шахматка тут же зачёркивала его «срок истёк»;
--   * если клетку на новой неделе старший уже закрыл другим человеком,
--     копия ставила туда второго пуджари;
--   * повторный запуск отвечал «перенесено 0, пропущено 0», и страница
--     говорила «в той неделе никого не ставили», хотя ставили — просто
--     всё уже стояло.
-- Теперь каждая причина считается отдельно, и страница может сказать
-- по-человечески, что произошло.
create or replace function public.worship_week_copy(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_сдвиг     integer;
    v_перенос   integer := 0;
    v_уже       integer := 0;
    v_занято    integer := 0;
    v_отмена    integer := 0;
    v_отъезд    text[] := '{}';
    v_срок      text[] := '{}';
    v_занятые   text[];
    v_цель      date;
    v_имя       text;
    r           record;
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

    -- что на новой неделе уже расписано до копии: клетка «дата · служба · роль»
    select coalesce(array_agg(distinct d.duty_date || '|' || d.service_id || '|' || d.role), '{}')
      into v_занятые
      from worship_duties d
     where d.duty_date between p_to and p_to + 6 and d.service_id is not null;

    for r in
        select d.*, p.active_from, p.active_to,
               v.spiritual_name, v.first_name, v.last_name
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
          -- отключённая служба не переезжает: её больше нет в распорядке
          join worship_services s on s.id = d.service_id and s.is_active
         where d.duty_date between p_from and p_from + 6
           and p.is_active
         order by d.duty_date
    loop
        v_цель := r.duty_date + v_сдвиг;
        v_имя := coalesce(r.spiritual_name,
            nullif(btrim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')), ''),
            'без имени');

        -- тот же человек уже стоит в этой клетке — повторный запуск
        if exists (select 1 from worship_duties d2
                    where d2.duty_date = v_цель and d2.service_id = r.service_id
                      and d2.person_id = r.person_id) then
            v_уже := v_уже + 1;
            continue;
        end if;

        if (r.active_to is not null and r.active_to < v_цель)
           or (r.active_from is not null and r.active_from > v_цель) then
            v_срок := array_append(v_срок, v_имя);
            continue;
        end if;

        if worship_is_away(r.person_id, v_цель) then
            v_отъезд := array_append(v_отъезд, v_имя);
            continue;
        end if;

        if exists (select 1 from worship_day_overrides o
                    where o.duty_date = v_цель and o.service_id = r.service_id) then
            v_отмена := v_отмена + 1;
            continue;
        end if;

        -- клетку в этой роли старший уже закрыл другим человеком
        if (v_цель || '|' || r.service_id || '|' || r.role) = any(v_занятые) then
            v_занято := v_занято + 1;
            continue;
        end if;

        insert into worship_duties (duty_date, service_id, person_id, role, created_by)
        values (v_цель, r.service_id, r.person_id, r.role, auth.uid())
        on conflict do nothing;
        if found then v_перенос := v_перенос + 1; end if;
    end loop;

    return jsonb_build_object(
        'ok', true,
        'перенесено', v_перенос,
        'уже_стояли', v_уже,
        'занято', v_занято,
        'отменено', v_отмена,
        'недоступны', to_jsonb(array(select distinct unnest(v_отъезд))),
        'срок_вышел', to_jsonb(array(select distinct unnest(v_срок))),
        -- для старых страниц: всё, что не перенесено и не стояло раньше
        'пропущено', v_занято + v_отмена
                     + coalesce(array_length(v_отъезд, 1), 0)
                     + coalesce(array_length(v_срок, 1), 0));
end $function$;
