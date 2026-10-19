-- 287: «Сдвинуть время» — та же служба в другое время на день или на
-- несколько дней (праздник, ретрит). Решение Адриана 19.10.2026: по одной
-- службе, гостям в портале — актуальное время.
--
-- Особый день теперь трёх видов (worship_day_overrides):
--   отмена   — service_id, без времени и названия;
--   сдвиг    — service_id + time_of_day (новое время), без названия;
--   разовая  — title + time_of_day, без service_id.
-- Одна запись на службу в день (индекс worship_day_overrides_cancel):
-- отменить и сдвинуть одну службу в один день нельзя.
--
-- Дни одного сдвига связаны group_id: ретрит в списке — одна строка,
-- правится и убирается разом. Люди остаются на своих клетках; им в
-- телеграм — «изменилось время».

alter table worship_day_overrides drop constraint worship_day_overrides_kind;
alter table worship_day_overrides add constraint worship_day_overrides_kind check (
       (service_id is not null and title is null)                              -- отмена или сдвиг
    or (service_id is null and title is not null and time_of_day is not null)  -- разовая
);
alter table worship_day_overrides add column if not exists group_id uuid;
create index if not exists worship_day_overrides_group on worship_day_overrides (group_id) where group_id is not null;

alter table worship_notifications drop constraint worship_notifications_kind_check;
alter table worship_notifications add constraint worship_notifications_kind_check
    check (kind = any (array['submitted', 'approved', 'returned', 'remark', 'stale', 'kit_granted',
                             'absence_set', 'duty_set', 'duty_cleared', 'service_cancelled',
                             'service_restored', 'service_moved', 'service_retimed', 'tomorrow', 'gaps']));

-- время службы в этот день: сдвиг или обычное; null — служба отменена
create or replace function worship_service_time(p_service uuid, p_date date)
returns time language sql stable security definer
set search_path = public, pg_temp
as $$
    select case
             when o.id is null then s.time_of_day
             else o.time_of_day          -- у отмены времени нет — null
           end
      from worship_services s
      left join worship_day_overrides o on o.service_id = s.id and o.duty_date = p_date
     where s.id = p_service
$$;
revoke all on function worship_service_time(uuid, date) from public, anon;
grant execute on function worship_service_time(uuid, date) to authenticated;

-- ---- сдвинуть время службы на день или диапазон ----
create or replace function worship_service_retime(p_service uuid, p_from date, p_to date,
                                                  p_time time, p_reason text default null,
                                                  p_group uuid default null)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    v_служба  worship_services%rowtype;
    v_по      date := coalesce(p_to, p_from);
    v_группа  uuid := coalesce(p_group, gen_random_uuid());
    v_день    date;
    v_дней    integer := 0;
    v_мимо    date[] := '{}';
begin
    if not worship_can_approve() then
        raise exception 'Менять время служб может старший пуджари' using errcode = '42501';
    end if;
    if p_service is null or p_from is null or p_time is null then
        raise exception 'Укажите службу, день и новое время';
    end if;
    if v_по < p_from then raise exception 'День окончания раньше начала'; end if;
    if v_по - p_from > 60 then raise exception 'Больше двух месяцев — это уже новое время службы, поменяйте его в «Службах»'; end if;

    select * into v_служба from worship_services where id = p_service;
    if not found then raise exception 'Служба не найдена'; end if;
    if p_time = v_служба.time_of_day then
        raise exception 'Это и так обычное время службы';
    end if;

    -- правка группы: дни, выпавшие из нового диапазона, возвращаются к обычному времени
    if p_group is not null then
        delete from worship_day_overrides
         where group_id = p_group and (duty_date < p_from or duty_date > v_по);
    end if;

    for v_день in select generate_series(p_from, v_по, interval '1 day')::date loop
        -- отменённый день не трогаем: отмена важнее сдвига
        if exists (select 1 from worship_day_overrides
                    where duty_date = v_день and service_id = p_service and time_of_day is null) then
            v_мимо := array_append(v_мимо, v_день);
            continue;
        end if;
        update worship_day_overrides
           set time_of_day = p_time, reason = nullif(btrim(coalesce(p_reason, '')), ''), group_id = v_группа
         where duty_date = v_день and service_id = p_service;
        if not found then
            insert into worship_day_overrides (duty_date, service_id, time_of_day, reason, created_by, group_id)
            values (v_день, p_service, p_time, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid(), v_группа);
        end if;
        v_дней := v_дней + 1;
    end loop;

    return jsonb_build_object('ok', true, 'group_id', v_группа, 'дней', v_дней,
                              'отменены', to_jsonb(v_мимо));
end $$;
revoke all on function worship_service_retime(uuid, date, date, time, text, uuid) from public, anon;
grant execute on function worship_service_retime(uuid, date, date, time, text, uuid) to authenticated;

-- ---- назначение и повтор недели: «не проводится» — только отмена ----
do $$
declare d text; н integer;
begin
    d := pg_get_functiondef('worship_duty_set'::regproc);
    н := (length(d) - length(replace(d, 'o.service_id = p_service) then', ''))) / length('o.service_id = p_service) then');
    if н <> 1 then raise exception 'worship_duty_set: якорь отмены найден % раз', н; end if;
    d := replace(d, 'o.service_id = p_service) then', 'o.service_id = p_service and o.time_of_day is null) then');
    if position('v_время := v_служба.time_of_day;' in d) = 0 then raise exception 'worship_duty_set: время не найдено'; end if;
    d := replace(d, 'v_время := v_служба.time_of_day;',
                 'v_время := coalesce(worship_service_time(p_service, p_date), v_служба.time_of_day);');
    execute d;

    d := pg_get_functiondef('worship_week_copy'::regproc);
    н := (length(d) - length(replace(d, 'o.service_id = r.service_id) then', ''))) / length('o.service_id = r.service_id) then');
    if н <> 1 then raise exception 'worship_week_copy: якорь отмены найден % раз', н; end if;
    execute replace(d, 'o.service_id = r.service_id) then', 'o.service_id = r.service_id and o.time_of_day is null) then');

    d := pg_get_functiondef('worship_notify_pack'::regproc);
    if position('''service_moved'')' in d) = 0 then raise exception 'worship_notify_pack: список видов не найден'; end if;
    execute replace(d, '''service_moved'')', '''service_moved'', ''service_retimed'')');
end $$;

-- ---- гостевой портал: актуальное время ----
create or replace function worship_day_for_guest(p_date date)
returns jsonb language sql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select jsonb_build_object('ok', true, 'дата', p_date, 'службы', coalesce((
        select jsonb_agg(служба order by служба->>'время')
          from (
            select jsonb_build_object('название', s.name_ru, 'name_en', s.name_en,
                                      'name_hi', s.name_hi,
                                      'время', to_char(coalesce(o.time_of_day, s.time_of_day), 'HH24:MI'),
                                      'обычное_время', case when o.time_of_day is not null
                                                            then to_char(s.time_of_day, 'HH24:MI') end,
                                      'разовая', false) as служба
              from worship_services s
              left join worship_day_overrides o on o.duty_date = p_date and o.service_id = s.id
             where s.is_active
               and not (o.id is not null and o.time_of_day is null)     -- отменена
            union all
            select jsonb_build_object('название', o.title, 'name_en', null, 'name_hi', null,
                                      'время', to_char(o.time_of_day, 'HH24:MI'),
                                      'разовая', true)
              from worship_day_overrides o
             where o.duty_date = p_date and o.title is not null
          ) t), '[]'::jsonb))
$$;

-- ---- событие о назначении: время дня, а не обычное ----
create or replace function worship_duty_notify()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    r       worship_duties;
    v_кому  uuid;
    v_имя   text;
    v_время time;
begin
    r := case when tg_op = 'DELETE' then old else new end;
    if r.duty_date < current_date then return null; end if;

    select v.user_id into v_кому
      from worship_people p join vaishnavas v on v.id = p.vaishnava_id
     where p.id = r.person_id;
    if v_кому is null or v_кому = auth.uid() then return null; end if;

    if r.service_id is not null then
        select name_ru, coalesce(worship_service_time(id, r.duty_date), time_of_day)
          into v_имя, v_время from worship_services where id = r.service_id;
    else
        select title, time_of_day into v_имя, v_время from worship_day_overrides where id = r.override_id;
    end if;

    perform worship_event(case when tg_op = 'DELETE' then 'duty_cleared' else 'duty_set' end,
                          null, null, null, v_кому,
                          'duty:' || r.id || ':' || gen_random_uuid(),
                          jsonb_build_object('дата', r.duty_date,
                                             'цель', coalesce(r.service_id, r.override_id),
                                             'человек', r.person_id, 'роль', r.role,
                                             'служба', coalesce(v_имя, 'разовая служба'),
                                             'время', to_char(v_время, 'HH24:MI')));
    return null;
end $$;

-- ---- отмена / сдвиг службы: событие людям на ней ----
create or replace function worship_override_notify()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    r       worship_day_overrides;
    д       record;
    v_вид   text;
    v_было  time;
begin
    r := case when tg_op = 'DELETE' then old else new end;
    if r.service_id is null or r.duty_date < current_date then return null; end if;

    if tg_op = 'UPDATE' then
        if new.time_of_day is not distinct from old.time_of_day then return null; end if;
        v_вид := 'service_retimed'; v_было := old.time_of_day;
    elsif r.time_of_day is null then
        v_вид := case when tg_op = 'DELETE' then 'service_restored' else 'service_cancelled' end;
    else
        -- сдвиг появился (было обычное время) или убран (было сдвинутое)
        v_вид := 'service_retimed';
        v_было := case when tg_op = 'DELETE' then old.time_of_day
                       else (select time_of_day from worship_services where id = r.service_id) end;
    end if;

    for д in
        select d.id, d.person_id, d.role, v.user_id, s.name_ru, s.time_of_day
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
          join worship_services s on s.id = d.service_id
         where d.duty_date = r.duty_date and d.service_id = r.service_id
           and v.user_id is not null and v.user_id is distinct from auth.uid()
    loop
        perform worship_event(v_вид, null, null, null, д.user_id,
                              'day:' || r.id || ':' || д.id || ':' || gen_random_uuid(),
                              jsonb_build_object('дата', r.duty_date, 'цель', r.service_id,
                                                 'человек', д.person_id, 'роль', д.role,
                                                 'служба', д.name_ru,
                                                 'время', to_char(д.time_of_day, 'HH24:MI'),
                                                 'было_время', to_char(v_было, 'HH24:MI'),
                                                 'причина', r.reason));
    end loop;
    return null;
end $$;

drop trigger if exists worship_day_overrides_notify on worship_day_overrides;
create trigger worship_day_overrides_notify after insert or update or delete on worship_day_overrides
    for each row execute function worship_override_notify();

-- ---- текст сводки: сдвиг времени — в «Изменились время или день» ----
create or replace function worship_schedule_text(p_events uuid[])
returns text language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    with e as (
        select n.kind, n.created_at,
               case when n.kind in ('duty_set', 'duty_cleared') then 'duty'
                    when n.kind = 'service_moved' then 'moved'
                    when n.kind = 'service_retimed' then 'retimed' else 'day' end as вид,
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
           and n.kind in ('duty_set', 'duty_cleared', 'service_cancelled', 'service_restored',
                          'service_moved', 'service_retimed')
    ),
    первые as (
        select distinct on (вид, case when вид = 'moved' then null else дата end, цель, человек,
                            case when вид = 'duty' then роль end) *
          from e
         order by вид, case when вид = 'moved' then null else дата end, цель, человек,
                  case when вид = 'duty' then роль end, created_at
    ),
    сейчас as (
        select ф.*,
               case when ф.вид = 'moved' then o.duty_date when ф.вид = 'retimed' then ф.дата end as сейчас_дата,
               case when ф.вид = 'moved' then to_char(o.time_of_day, 'HH24:MI')
                    when ф.вид = 'retimed' then to_char(worship_service_time(ф.цель, ф.дата), 'HH24:MI') end as сейчас_время,
               case when ф.вид = 'moved' then o.title
                    when ф.вид = 'retimed' then (select name_ru from worship_services where id = ф.цель) end as сейчас_служба
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
                   when ф.вид = 'retimed' then
                       -- отменили после сдвига — об этом скажет «не проводится»
                       case when ф.дата >= current_date and ф.сейчас_время is not null
                             and ф.сейчас_время is distinct from ф.было_время
                             and exists (select 1 from worship_duties d
                                          where d.duty_date = ф.дата and d.service_id = ф.цель
                                            and d.person_id = ф.человек)
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
                                     where o.duty_date = ф.дата and o.service_id = ф.цель and o.time_of_day is null)
                        and exists (select 1 from worship_duties d
                                     where d.duty_date = ф.дата and d.service_id = ф.цель
                                       and d.person_id = ф.человек) then 'отменена'
                   when ф.kind = 'service_restored'
                        and not exists (select 1 from worship_day_overrides o
                                         where o.duty_date = ф.дата and o.service_id = ф.цель and o.time_of_day is null)
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

-- ---- «Завтра у вас»: сдвинутое время и пометка «обычно в …» ----
create or replace function worship_notify_tomorrow(p_dry boolean default true)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    v_завтра date := current_date + 1;
    v_живьём boolean;
    r        record;
    v_текст  text;
    v_адрес  bigint;
    v_ушло   boolean;
    v_итог   jsonb := '[]'::jsonb;
begin
    select coalesce(value = 'true', false) into v_живьём from worship_settings where key = 'notify_enabled';
    if not coalesce(v_живьём, false) then p_dry := true; end if;

    for r in
        with живые as (
            select d.id, d.person_id, d.role, d.service_id, d.override_id,
                   coalesce(x.time_of_day, s.time_of_day, o.time_of_day) as время,
                   case when x.time_of_day is not null then s.time_of_day end as обычно,
                   coalesce(s.name_ru, o.title) as служба,
                   s.article_id
              from worship_duties d
              left join worship_services s on s.id = d.service_id
              left join worship_day_overrides o on o.id = d.override_id
              left join worship_day_overrides x on x.duty_date = v_завтра and x.service_id = d.service_id
             where d.duty_date = v_завтра
               and (d.override_id is not null
                    or (s.is_active and not (x.id is not null and x.time_of_day is null)))
        ),
        люди as (
            select p.id, v.user_id,
                   coalesce(nullif(v.spiritual_name, ''),
                            nullif(btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                            'без имени') as имя,
                   exists (select 1 from worship_absences a
                            where a.person_id = p.id
                              and v_завтра between a.date_from and coalesce(a.date_to, 'infinity'::date)) as в_отъезде
              from worship_people p join vaishnavas v on v.id = p.vaishnava_id
             where p.is_active
        )
        select л.user_id, л.id as person_id,
               string_agg(
                   concat_ws(' ', to_char(ж.время, 'HH24:MI')
                                  || coalesce(' (обычно ' || to_char(ж.обычно, 'HH24:MI') || ')', ''),
                             case when ж.article_id is not null
                                  then format('<a href="https://in.rupaseva.com/worship/article.html?id=%s">%s</a>',
                                              ж.article_id, worship_html(ж.служба))
                                  else worship_html(ж.служба) end)
                   || ' — ' || worship_role_label(ж.role)
                   || coalesce(' (вместе: ' || (
                          select string_agg(worship_html(л2.имя), ', ' order by л2.имя)
                            from живые ж2 join люди л2 on л2.id = ж2.person_id
                           where coalesce(ж2.service_id, ж2.override_id) = coalesce(ж.service_id, ж.override_id)
                             and ж2.person_id <> ж.person_id and not л2.в_отъезде) || ')', ''),
                   E'\n' order by ж.время) as строки
          from живые ж join люди л on л.id = ж.person_id
         where л.user_id is not null and not л.в_отъезде
         group by л.user_id, л.id
    loop
        v_текст := format(E'<b>Завтра, %s, у вас:</b>\n%s\n\nНе сможете — отметьте «Меня не будет» в '
                          || '<a href="https://in.rupaseva.com/worship/schedule.html">расписании</a>, старший найдёт замену.',
                          worship_day_label(v_завтра), r.строки);
        v_адрес := worship_tg_address(r.user_id);
        v_ушло := false;

        if not p_dry and v_адрес is not null then
            insert into worship_notifications (kind, recipient, event_key, payload, sent_at)
            values ('tomorrow', r.user_id, 'tomorrow:' || r.person_id || ':' || v_завтра,
                    jsonb_build_object('дата', v_завтра), now())
            on conflict (event_key) do nothing;
            if found then
                insert into tg_outbox (chat_id, text, kind) values (v_адрес, v_текст, 'worship');
                insert into worship_notification_log (batch_id, recipient, message, events, dry_run)
                values (gen_random_uuid(), r.user_id, v_текст, 1, false);
                v_ушло := true;
            end if;
        end if;

        v_итог := v_итог || jsonb_build_object('кому', r.user_id, 'адрес_есть', v_адрес is not null,
                                               'ушло', v_ушло, 'текст', v_текст);
    end loop;

    return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'день', v_завтра, 'сообщения', v_итог);
end $$;
revoke all on function worship_notify_tomorrow(boolean) from public, anon, authenticated;

-- ---- старшему: дыры на завтра — со сдвинутым временем ----
create or replace function worship_notify_gaps(p_dry boolean default true)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    v_завтра  date := current_date + 1;
    v_живьём  boolean;
    v_строки  text;
    v_текст   text;
    v_старший uuid;
    v_адрес   bigint;
    v_ушло    boolean;
    v_итог    jsonb := '[]'::jsonb;
begin
    select coalesce(value = 'true', false) into v_живьём from worship_settings where key = 'notify_enabled';
    if not coalesce(v_живьём, false) then p_dry := true; end if;

    with клетки as (
        select s.id as цель, coalesce(x.time_of_day, s.time_of_day) as время, s.name_ru as служба
          from worship_services s
          left join worship_day_overrides x on x.duty_date = v_завтра and x.service_id = s.id
         where s.is_active
           and not (x.id is not null and x.time_of_day is null)
        union all
        select o.id, o.time_of_day, o.title
          from worship_day_overrides o
         where o.duty_date = v_завтра and o.title is not null
    ),
    стоят as (
        select coalesce(d.service_id, d.override_id) as цель, d.role,
               coalesce(nullif(v.spiritual_name, ''),
                        nullif(btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                        'без имени') as имя,
               exists (select 1 from worship_absences a
                        where a.person_id = d.person_id
                          and v_завтра between a.date_from and coalesce(a.date_to, 'infinity'::date)) as в_отъезде
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
         where d.duty_date = v_завтра
    ),
    беды as (
        select к.время, к.служба,
               concat_ws('; ',
                   case when not exists (select 1 from стоят с where с.цель = к.цель
                                            and с.role = 'pujari' and not с.в_отъезде)
                        then 'нет ведущего' end,
                   (select string_agg(worship_html(с.имя) || ' не сможет', ', ' order by с.имя)
                      from стоят с where с.цель = к.цель and с.в_отъезде)) as что
          from клетки к
    )
    select string_agg(concat_ws(' ', to_char(время, 'HH24:MI'), worship_html(служба)) || ' — ' || что,
                      E'\n' order by время)
      into v_строки
      from беды where что <> '';

    if v_строки is null then
        return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'день', v_завтра, 'сообщения', '[]'::jsonb);
    end if;

    v_текст := format(E'<b>Завтра, %s, не закрыто:</b>\n%s\n\n'
                      || '<a href="https://in.rupaseva.com/worship/schedule.html?день=%s">Открыть день в расписании</a>',
                      worship_day_label(v_завтра), v_строки, v_завтра);

    for v_старший in select worship_holders('worship_approve') loop
        v_адрес := worship_tg_address(v_старший);
        v_ушло := false;
        if not p_dry and v_адрес is not null then
            insert into worship_notifications (kind, recipient, event_key, payload, sent_at)
            values ('gaps', v_старший, 'gaps:' || v_старший || ':' || v_завтра,
                    jsonb_build_object('дата', v_завтра), now())
            on conflict (event_key) do nothing;
            if found then
                insert into tg_outbox (chat_id, text, kind) values (v_адрес, v_текст, 'worship');
                insert into worship_notification_log (batch_id, recipient, message, events, dry_run)
                values (gen_random_uuid(), v_старший, v_текст, 1, false);
                v_ушло := true;
            end if;
        end if;
        v_итог := v_итог || jsonb_build_object('кому', v_старший, 'адрес_есть', v_адрес is not null,
                                               'ушло', v_ушло, 'текст', v_текст);
    end loop;

    return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'день', v_завтра, 'сообщения', v_итог);
end $$;
revoke all on function worship_notify_gaps(boolean) from public, anon, authenticated;
