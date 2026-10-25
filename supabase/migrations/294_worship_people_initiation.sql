-- 294: посвящение у участников «Поклонения» (просьба Адриана 25.10.2026):
-- «нет инициации», «первая» (харинама), «вторая» (дикша); null — не указано.
-- Ставит старший (политика update на worship_people — worship_approve).
-- Значок — в окне «Поставить», в списке людей и в карточке.

alter table worship_people add column if not exists initiation text
    check (initiation in ('none', 'first', 'second'));

drop function if exists worship_people_list();
create function worship_people_list()
returns table(id uuid, vaishnava_id uuid, kind text, is_active boolean, active_from date, active_to date,
              name text, user_id uuid, has_telegram boolean, phone text, worldly text, removed_at timestamptz,
              initiation text)
language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select p.id, p.vaishnava_id, p.kind, p.is_active, p.active_from, p.active_to,
           coalesce(nullif(v.spiritual_name, ''),
                    nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                    'без имени'),
           v.user_id,
           exists (select 1 from tg_user_links l where l.vaishnava_id = v.id),
           case when is_superuser(auth.uid()) or is_staff(auth.uid())
                     or has_permission(auth.uid(), 'view_vaishnavas')
                     or has_permission(auth.uid(), 'edit_vaishnava')
                then v.phone end,
           nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
           p.removed_at,
           p.initiation
      from worship_people p
      join vaishnavas v on v.id = p.vaishnava_id
     where worship_can_view()
$$;
revoke all on function worship_people_list() from public, anon;
grant execute on function worship_people_list() to authenticated;
