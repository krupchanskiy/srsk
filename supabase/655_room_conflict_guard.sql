-- 655: запрет накладок в шахматке (ВГ 08.10, «Шахматка 8»: «нахлёстов не должно быть»).
-- База не даёт сохранить место, если с ним:
--   1) в номере в какую-то ночь людей больше, чем мест;
--   2) тот же человек в эту ночь уже стоит в другом месте с номером.
-- Стык можно: выезд в день заезда другого — ночи не пересекаются.
-- Проверяются ночи с сегодняшнего дня (как оповещение 654): прошлое не трогаем —
-- там есть старые записи (группа Aditya Gupta 08.2026: id старшего у всех 47 мест),
-- и исправления задним числом не должны упираться в запрет.
-- Место без номера («Самостоятельное проживание», бронь из CRM «Сам организует»)
-- в п. 2 не участвует: его создаёт crm_self_stay_sync, сделка не должна падать;
-- такие двойные видно в красном оповещении.
-- Отложенная проверка (на конец транзакции): функции, которые режут проживание
-- внутри одной транзакции, видят итог, а не промежуточный шаг.

create or replace function public.residents_conflict_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    r residents%rowtype;
    v_from date;
    v_to date;
    v_cap int;
    v_night date;
    v_cnt int;
    v_room text;
    v_other residents%rowtype;
    v_name text;
begin
    -- отложенный триггер: берём то, что лежит в базе на конец транзакции
    select * into r from residents where id = new.id;
    if r.id is null or r.status not in ('confirmed', 'booked') then return null; end if;

    v_from := greatest(r.check_in, current_date);
    v_to := coalesce(r.check_out, current_date + 365);
    if v_to <= v_from then return null; end if;

    if r.room_id is not null then
        select rm.capacity, b.name_ru || ' №' || rm.number into v_cap, v_room
          from rooms rm left join buildings b on b.id = rm.building_id
         where rm.id = r.room_id;

        -- 1) мест в номере не больше вместимости ни в одну ночь
        select g::date, count(o.id) into v_night, v_cnt
          from generate_series(v_from, v_to - 1, interval '1 day') g
          join residents o on o.room_id = r.room_id
                          and o.status in ('confirmed', 'booked')
                          and o.check_in <= g::date
                          and coalesce(o.check_out, current_date + 365) > g::date
         group by g
        having count(o.id) > coalesce(v_cap, 1)
         order by g
         limit 1;
        if v_night is not null then
            raise exception 'Накладка: % — в ночь на % будет % чел., а мест %. Поправьте даты или выберите другой номер.',
                v_room, to_char(v_night, 'DD.MM'), v_cnt, coalesce(v_cap, 1)
                using errcode = 'P0001', hint = 'room_overbook';
        end if;

        -- 2) тот же человек не стоит в эти ночи в другом номере
        if r.vaishnava_id is not null then
            select o.* into v_other
              from residents o
             where o.vaishnava_id = r.vaishnava_id and o.id <> r.id
               and o.room_id is not null
               and o.status in ('confirmed', 'booked')
               and o.check_in < v_to
               and coalesce(o.check_out, current_date + 365) > v_from
             order by o.check_in
             limit 1;
            if v_other.id is not null then
                select coalesce(nullif(v.spiritual_name, ''),
                                nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''), '—')
                  into v_name from vaishnavas v where v.id = r.vaishnava_id;
                select b.name_ru || ' №' || rm.number into v_room
                  from rooms rm left join buildings b on b.id = rm.building_id where rm.id = v_other.room_id;
                raise exception '% уже стоит в % с % по %. Поставьте стык: выезд в день заезда.',
                    v_name, v_room, to_char(v_other.check_in, 'DD.MM'),
                    coalesce(to_char(v_other.check_out, 'DD.MM'), '…')
                    using errcode = 'P0001', hint = 'same_person';
            end if;
        end if;
    end if;
    return null;
end;
$$;

drop trigger if exists trg_residents_conflict_guard on public.residents;
create constraint trigger trg_residents_conflict_guard
    after insert or update of room_id, check_in, check_out, status, vaishnava_id
    on public.residents
    deferrable initially deferred
    for each row
    execute function public.residents_conflict_guard();
