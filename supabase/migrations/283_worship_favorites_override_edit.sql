-- 283: «Избранное» вместо «Закладок» (решение Адриана 19.10.2026) и правка
-- разовой службы: время, название, длительность, причина, день.
--
-- День разовой службы меняется вместе с людьми на ней: назначение хранит
-- свою дату, и без переноса люди остались бы на старом дне при службе,
-- которой там уже нет. Тем, кто стоит на службе, — событие «перенесли»:
-- в телеграм уходит «изменилось время», а не молчание.

update translations set ru = 'Избранное', en = 'Favourites', hi = 'पसंदीदा'
 where key in ('nav_worship_bookmarks', 'worship_bookmarks', 'worship_bookmarks_title', 'worship_marks_title');

alter table worship_notifications drop constraint worship_notifications_kind_check;
alter table worship_notifications add constraint worship_notifications_kind_check
    check (kind = any (array['submitted', 'approved', 'returned', 'remark', 'stale', 'kit_granted',
                             'absence_set', 'duty_set', 'duty_cleared', 'service_cancelled',
                             'service_restored', 'service_moved', 'tomorrow', 'gaps']));

-- ---- перенос дня: люди переезжают вместе со службой ----
create or replace function worship_override_move_duties()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
begin
    if new.service_id is distinct from old.service_id then
        raise exception 'Другую службу так не выбрать — уберите отмену и поставьте новую';
    end if;
    if new.duty_date is distinct from old.duty_date then
        if new.service_id is not null then
            raise exception 'День отмены не переносится — уберите её и отметьте нужный день';
        end if;
        update worship_duties set duty_date = new.duty_date where override_id = new.id;
    end if;
    return new;
end $$;

drop trigger if exists worship_day_overrides_move on worship_day_overrides;
create trigger worship_day_overrides_move before update on worship_day_overrides
    for each row execute function worship_override_move_duties();

-- ---- событие людям на службе ----
create or replace function worship_override_moved_notify()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare д record;
begin
    if new.title is null then return null; end if;
    if new.duty_date is not distinct from old.duty_date
       and new.time_of_day is not distinct from old.time_of_day then return null; end if;
    if greatest(new.duty_date, old.duty_date) < current_date then return null; end if;

    for д in
        select d.person_id, v.user_id
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
         where d.override_id = new.id
           and v.user_id is not null and v.user_id is distinct from auth.uid()
    loop
        perform worship_event('service_moved', null, null, null, д.user_id,
                              'moved:' || new.id || ':' || д.person_id || ':' || gen_random_uuid(),
                              jsonb_build_object('цель', new.id, 'человек', д.person_id,
                                                 'было_дата', old.duty_date,
                                                 'было_время', to_char(old.time_of_day, 'HH24:MI')));
    end loop;
    return null;
end $$;

drop trigger if exists worship_day_overrides_moved on worship_day_overrides;
create trigger worship_day_overrides_moved after update on worship_day_overrides
    for each row execute function worship_override_moved_notify();

-- ---- текст сводки: + «перенесли» ----
create or replace function worship_schedule_text(p_events uuid[])
returns text language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    with e as (
        select n.kind, n.created_at,
               case when n.kind in ('duty_set', 'duty_cleared') then 'duty'
                    when n.kind = 'service_moved' then 'moved' else 'day' end as вид,
               (n.payload->>'дата')::date as дата,
               (n.payload->>'цель')::uuid as цель,
               (n.payload->>'человек')::uuid as человек,
               coalesce(n.payload->>'роль', 'pujari') as роль,
               n.payload->>'служба' as служба,
               n.payload->>'время' as время,
               (n.payload->>'было_дата')::date as было_дата,
               n.payload->>'было_время' as было_время
          from worship_notifications n
         where n.id = any(p_events)
           and n.kind in ('duty_set', 'duty_cleared', 'service_cancelled', 'service_restored', 'service_moved')
    ),
    -- первое событие по клетке + то, что в базе сейчас = итог.
    -- У переноса ключ — служба и человек: день мог смениться дважды
    первые as (
        select distinct on (вид, case when вид = 'moved' then null else дата end, цель, человек,
                            case when вид = 'duty' then роль end) *
          from e
         order by вид, case when вид = 'moved' then null else дата end, цель, человек,
                  case when вид = 'duty' then роль end, created_at
    ),
    сейчас as (
        select ф.*, o.duty_date as сейчас_дата, to_char(o.time_of_day, 'HH24:MI') as сейчас_время,
               o.title as сейчас_служба
          from первые ф
          left join worship_day_overrides o on ф.вид = 'moved' and o.id = ф.цель
    ),
    итог as (
        select ф.*,
               case
                   when ф.вид = 'moved' then
                       case when ф.сейчас_дата >= current_date
                             and (ф.сейчас_дата, ф.сейчас_время) is distinct from (ф.было_дата, ф.было_время)
                             and exists (select 1 from worship_duties d
                                          where d.override_id = ф.цель and d.person_id = ф.человек)
                            then 'перенесли' end
                   when ф.дата < current_date then null
                   when ф.kind = 'duty_set' and exists (
                        select 1 from worship_duties d
                         where d.duty_date = ф.дата and coalesce(d.service_id, d.override_id) = ф.цель
                           and d.person_id = ф.человек and d.role = ф.роль) then 'поставили'
                   when ф.kind = 'duty_cleared' and not exists (
                        select 1 from worship_duties d
                         where d.duty_date = ф.дата and coalesce(d.service_id, d.override_id) = ф.цель
                           and d.person_id = ф.человек and d.role = ф.роль) then 'сняли'
                   when ф.kind = 'service_cancelled'
                        and exists (select 1 from worship_day_overrides o
                                     where o.duty_date = ф.дата and o.service_id = ф.цель)
                        and exists (select 1 from worship_duties d
                                     where d.duty_date = ф.дата and d.service_id = ф.цель
                                       and d.person_id = ф.человек) then 'отменена'
                   when ф.kind = 'service_restored'
                        and not exists (select 1 from worship_day_overrides o
                                         where o.duty_date = ф.дата and o.service_id = ф.цель)
                        and exists (select 1 from worship_duties d
                                     where d.duty_date = ф.дата and d.service_id = ф.цель
                                       and d.person_id = ф.человек) then 'вернули'
               end as что
          from сейчас ф
    ),
    строки as (
        select что,
               string_agg(
                   case when что = 'перенесли'
                        then concat_ws(' ', worship_day_label(сейчас_дата) || ',', сейчас_время,
                                       worship_html(сейчас_служба))
                             || ' (было: ' || concat_ws(' ',
                                    case when сейчас_дата <> было_дата then worship_day_label(было_дата) end,
                                    case when сейчас_время is distinct from было_время then было_время end) || ')'
                        else concat_ws(' ', worship_day_label(дата) || ',', время, worship_html(служба))
                             || case when что in ('поставили', 'сняли')
                                     then ' — ' || worship_role_label(роль) else '' end
                   end,
                   E'\n' order by coalesce(сейчас_дата, дата), coalesce(сейчас_время, время)) as список
          from итог where что is not null
         group by что
    )
    select nullif(concat_ws(E'\n\n',
               (select E'<b>Вас поставили:</b>\n' || список from строки where что = 'поставили'),
               (select E'<b>Вас сняли:</b>\n' || список from строки where что = 'сняли'),
               (select E'<b>Изменились время или день:</b>\n' || список from строки where что = 'перенесли'),
               (select E'<b>Не проводится — приходить не нужно:</b>\n' || список from строки where что = 'отменена'),
               (select E'<b>Снова проводится — вы на месте:</b>\n' || список from строки where что = 'вернули')), '')
           || E'\n<a href="https://in.rupaseva.com/worship/schedule.html">Расписание</a>'
$$;
revoke all on function worship_schedule_text(uuid[]) from public, anon, authenticated;

-- ---- отправщик: перенос тоже ждёт 10 минут тишины ----
do $$
declare
    d text := pg_get_functiondef('worship_notify_pack'::regproc);
    было text := '''duty_set'', ''duty_cleared'', ''service_cancelled'', ''service_restored'')';
begin
    if position(было in d) = 0 then raise exception 'worship_notify_pack: список видов не найден'; end if;
    execute replace(d, было, '''duty_set'', ''duty_cleared'', ''service_cancelled'', ''service_restored'', ''service_moved'')');
end $$;
