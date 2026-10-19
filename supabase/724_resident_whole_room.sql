-- «Номер целиком (без подселения)» (ВГ 19.10): одноместное расселение в многоместном номере.
-- Отметка у места; на его ночи в номер нельзя поставить никого вне этой брони
-- (семья в номере целиком — одна бронь, ей можно).

alter table public.residents add column whole_room boolean not null default false;
comment on column public.residents.whole_room is 'Номер снят целиком: подселять никого вне этой брони нельзя (мигр. 724)';

create or replace function public.residents_conflict_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

        -- 1а) номер снят целиком — в эти ночи в нём только люди одной брони (724)
        select g::date into v_night
          from generate_series(v_from, v_to - 1, interval '1 day') g
          join residents o on o.room_id = r.room_id
                          and o.status in ('confirmed', 'booked')
                          and o.check_in <= g::date
                          and coalesce(o.check_out, current_date + 365) > g::date
         group by g
        having bool_or(o.whole_room) and count(distinct coalesce(o.booking_id, o.id)) > 1
         order by g
         limit 1;
        if v_night is not null then
            raise exception 'Накладка: % — в ночь на % номер снят целиком (без подселения). Выберите другой номер или поправьте даты.',
                v_room, to_char(v_night, 'DD.MM')
                using errcode = 'P0001', hint = 'room_whole';
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
$function$;

insert into translations (key, ru, en, hi, context) values
('timeline_whole_room', 'Номер целиком (без подселения)', 'Whole room (no sharing)', 'पूरा कमरा (कोई साझा नहीं)', 'Бронь «Человек или семья»: одноместное расселение'),
('timeline_whole_room_hint', 'Остальные места номера на эти даты будут закрыты', 'Other beds in the room will be blocked for these dates', 'इन तिथियों पर कमरे के बाकी बिस्तर बंद रहेंगे', 'Бронь «Человек или семья»'),
('timeline_whole_room_short', 'номер целиком', 'whole room', 'पूरा कमरा', 'Шахматка: метка на плашке'),
('timeline_room_not_empty', 'в номере уже кто-то есть', 'someone is already in the room', 'कमरे में पहले से कोई है', 'Бронь «Человек или семья»')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
