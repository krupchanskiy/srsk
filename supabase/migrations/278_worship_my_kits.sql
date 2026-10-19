-- 278: подборки, выданные мне. Выдачи (worship_kit_grants) читают только
-- пишущие, поэтому волонтёр не мог узнать, что ему выдали: подборка жила
-- внизу главной среди прочих. Отдаём свои — выданные лично или ретриту,
-- где я волонтёр или в команде (то же правило, что worship_kit_for_guest).
create or replace function worship_my_kits()
returns table (kit_id uuid, title text, articles uuid[], albums int)
language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    with я as (
        select v.id from vaishnavas v
         where v.user_id = auth.uid() and not v.is_deleted limit 1
    )
    select k.id, k.title,
           coalesce(array_agg(i.article_id order by i.sort_order)
                    filter (where i.article_id is not null), '{}'),
           count(i.album_id)::int
      from worship_kits k
      join я on true
      left join worship_kit_items i on i.kit_id = k.id
     where worship_can_view() and k.is_active
       and exists (
           select 1 from worship_kit_grants g
            where g.kit_id = k.id and g.revoked_at is null
              and (g.vaishnava_id = я.id
                   or g.retreat_id in (select rr.retreat_id from retreat_registrations rr
                                        where rr.vaishnava_id = я.id
                                          and rr.status in ('volunteer', 'team'))))
     group by k.id, k.title
     order by k.title
$$;
revoke all on function worship_my_kits() from public, anon;
grant execute on function worship_my_kits() to authenticated;
