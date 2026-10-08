-- 654: накладки в шахматке для красного оповещения (ВГ 08.10, «Шахматка 8»).
-- overbook    — в номере в одну ночь больше людей, чем мест (стык не накладка:
--               выезд в день заезда другого — ночи не пересекаются);
-- same_person — один и тот же человек стоит в двух местах в одну ночь.
-- Смотрим с сегодняшнего дня на год вперёд; открытый выезд — до конца окна.
-- Права вызывающего (security invoker): видно ровно то, что видно в шахматке.

create or replace function public.room_conflicts(p_days int default 365)
returns table (kind text, room_id uuid, building text, room_number text,
               d_from date, d_to date, peak int, capacity int,
               resident_ids uuid[], who text)
language sql stable
set search_path to 'public'
as $$
  with p as (select current_date as f, current_date + p_days as t),
  act as (
    select r.id, r.room_id, r.vaishnava_id, r.check_in,
           coalesce(r.check_out, p.t) as co
      from residents r, p
     where r.status in ('confirmed', 'booked')
       and coalesce(r.check_out, p.t) > p.f
       and r.check_in < p.t
  ),
  -- занятые ночи по номерам: ночь d — с d на d+1
  nights as (
    select a.room_id, g::date as d, array_agg(a.id) as ids, count(*)::int as cnt
      from act a, p,
           generate_series(greatest(a.check_in, p.f), least(a.co, p.t) - 1, interval '1 day') g
     where a.room_id is not null
     group by 1, 2
  ),
  over as (
    select n.*, rm.capacity,
           n.d - (row_number() over (partition by n.room_id order by n.d))::int as grp
      from nights n join rooms rm on rm.id = n.room_id
     where n.cnt > rm.capacity
  ),
  over_r as (
    select 'overbook'::text as kind, o.room_id, min(o.d) as d_from, max(o.d) + 1 as d_to,
           max(o.cnt) as peak, max(o.capacity) as capacity,
           (select array_agg(distinct x) from over o2, unnest(o2.ids) x
             where o2.room_id = o.room_id and o2.grp = o.grp) as ids
      from over o
     group by o.room_id, o.grp
  ),
  same as (
    select 'same_person'::text, a.room_id, greatest(a.check_in, b.check_in, (select f from p)),
           least(a.co, b.co), 2, null::int, array[a.id, b.id]
      from act a
      join act b on a.vaishnava_id = b.vaishnava_id and a.id < b.id
                and a.check_in < b.co and b.check_in < a.co
     where a.vaishnava_id is not null
  )
  select x.kind, x.room_id, bl.name_ru, rm.number, x.d_from, x.d_to, x.peak, x.capacity, x.ids,
         -- одинаковые места одной брони — одной строкой «×N»; у двойного места
         -- одного человека — где стоит каждое
         (select string_agg(l.lbl || case when l.n > 1 then ' ×' || l.n else '' end, '; ' order by l.ci)
            from (select coalesce(nullif(v.spiritual_name, ''),
                                  nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                                  nullif(r.guest_name, ''),
                                  nullif(b.name, ''), '—')
                         || ' ' || to_char(r.check_in, 'DD.MM') || '–' || coalesce(to_char(r.check_out, 'DD.MM'), '…')
                         || case when x.kind = 'same_person'
                                 then coalesce(' (' || rb.name_ru || ' №' || rr.number || ')', ' (без номера)')
                                 else '' end as lbl,
                         count(*) as n, min(r.check_in) as ci
                    from residents r
                    left join vaishnavas v on v.id = r.vaishnava_id
                    left join bookings b on b.id = r.booking_id
                    left join rooms rr on rr.id = r.room_id
                    left join buildings rb on rb.id = rr.building_id
                   where r.id = any(x.ids)
                   group by 1) l)
    from (select * from over_r union all select * from same) x
    left join rooms rm on rm.id = x.room_id
    left join buildings bl on bl.id = rm.building_id
   order by x.d_from, bl.name_ru, rm.number;
$$;

grant execute on function public.room_conflicts(int) to authenticated;
