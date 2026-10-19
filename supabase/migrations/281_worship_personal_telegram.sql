-- 281: личные оповещения «Поклонения» в телеграм (решение Адриана 19.10.2026:
-- пока только личка, группу отдела не трогаем).
--
-- 1. Адрес. Очередь tg_outbox шлёт рабочим ботом @SRSKteambot, а рассылка
--    искала адрес в vaishnavas.telegram_chat_id — это чат другого бота
--    (портал гостя). Ушло бы в пустоту или не тому боту. Берём привязку
--    рабочего бота: tg_user_links (кнопка «Подключить Телеграм»).
-- 2. Расписание. Поставили / сняли / служба в этот день не проводится —
--    событие человеку. Старший двигает клетки пачкой, поэтому отправка ждёт
--    10 минут тишины по этому человеку и считает итог: поставили и тут же
--    сняли — не пишем ничего.
-- 3. Вечером — «Завтра у вас» каждому, у кого есть службы; старшему за час
--    до этого — дыры на завтра. Пустой день — без сообщения.

-- ---- адрес ----
create or replace function worship_tg_address(p_user uuid)
returns bigint language sql stable security definer
set search_path = public, pg_temp
as $$
    select l.tg_user_id
      from tg_user_links l
      join vaishnavas v on v.id = l.vaishnava_id
     where v.user_id = p_user
     order by l.linked_at desc nulls last
     limit 1
$$;
revoke all on function worship_tg_address(uuid) from public, anon, authenticated;

-- «бот не подключён» в списке людей — по той же привязке
create or replace function worship_people_list()
returns table(id uuid, vaishnava_id uuid, kind text, is_active boolean, active_from date, active_to date,
              name text, user_id uuid, has_telegram boolean, phone text)
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
                then v.phone end
      from worship_people p
      join vaishnavas v on v.id = p.vaishnava_id
     where worship_can_view()
$$;

-- подключён ли я сам — для карточки «Подключите Телеграм» на главной
create or replace function worship_my_telegram()
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'в_отделе', worship_my_person() is not null,
        'подключён', worship_tg_address(auth.uid()) is not null)
$$;
revoke all on function worship_my_telegram() from public, anon;
grant execute on function worship_my_telegram() to authenticated;

-- ---- виды событий ----
alter table worship_notifications drop constraint worship_notifications_kind_check;
alter table worship_notifications add constraint worship_notifications_kind_check
    check (kind = any (array['submitted', 'approved', 'returned', 'remark', 'stale', 'kit_granted',
                             'absence_set', 'duty_set', 'duty_cleared', 'service_cancelled',
                             'service_restored', 'tomorrow', 'gaps']));

-- ---- назначения: событие человеку ----
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
    -- себя старший ставит сам — об этом ему писать незачем
    if v_кому is null or v_кому = auth.uid() then return null; end if;

    if r.service_id is not null then
        select name_ru, time_of_day into v_имя, v_время from worship_services where id = r.service_id;
    else
        -- при удалении разовой службы назначения уходят каскадом, её строки уже нет
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

drop trigger if exists worship_duties_notify on worship_duties;
create trigger worship_duties_notify after insert or delete on worship_duties
    for each row execute function worship_duty_notify();

-- ---- служба в этот день не проводится / снова проводится ----
create or replace function worship_override_notify()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    r worship_day_overrides;
    д record;
begin
    r := case when tg_op = 'DELETE' then old else new end;
    -- разовая служба (title) людей не задевает, пока на неё никого не поставили
    if r.service_id is null or r.duty_date < current_date then return null; end if;

    for д in
        select d.id, d.person_id, d.role, v.user_id, s.name_ru, s.time_of_day
          from worship_duties d
          join worship_people p on p.id = d.person_id
          join vaishnavas v on v.id = p.vaishnava_id
          join worship_services s on s.id = d.service_id
         where d.duty_date = r.duty_date and d.service_id = r.service_id
           and v.user_id is not null and v.user_id is distinct from auth.uid()
    loop
        perform worship_event(case when tg_op = 'DELETE' then 'service_restored' else 'service_cancelled' end,
                              null, null, null, д.user_id,
                              'day:' || r.id || ':' || д.id || ':' || gen_random_uuid(),
                              jsonb_build_object('дата', r.duty_date, 'цель', r.service_id,
                                                 'человек', д.person_id, 'роль', д.role,
                                                 'служба', д.name_ru,
                                                 'время', to_char(д.time_of_day, 'HH24:MI'),
                                                 'причина', r.reason));
    end loop;
    return null;
end $$;

drop trigger if exists worship_day_overrides_notify on worship_day_overrides;
create trigger worship_day_overrides_notify after insert or delete on worship_day_overrides
    for each row execute function worship_override_notify();

-- ---- текст об изменениях расписания: итог, а не история нажатий ----
create or replace function worship_day_label(p_date date)
returns text language sql immutable
set search_path = public, pg_temp
as $$
    select (array['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'])[extract(dow from p_date)::int + 1]
           || ' ' || to_char(p_date, 'DD.MM')
$$;

create or replace function worship_role_label(p_role text)
returns text language sql immutable
set search_path = public, pg_temp
as $$
    select case p_role when 'pujari' then 'ведёте' when 'helper' then 'помощник'
                       when 'kirtan' then 'киртания' else p_role end
$$;

create or replace function worship_schedule_text(p_events uuid[])
returns text language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    with e as (
        select n.kind, n.created_at,
               case when n.kind in ('duty_set', 'duty_cleared') then 'duty' else 'day' end as вид,
               (n.payload->>'дата')::date as дата,
               (n.payload->>'цель')::uuid as цель,
               (n.payload->>'человек')::uuid as человек,
               coalesce(n.payload->>'роль', 'pujari') as роль,
               n.payload->>'служба' as служба,
               n.payload->>'время' as время
          from worship_notifications n
         where n.id = any(p_events)
           and n.kind in ('duty_set', 'duty_cleared', 'service_cancelled', 'service_restored')
    ),
    -- первое событие по клетке + то, что в базе сейчас = итог
    первые as (
        select distinct on (вид, дата, цель, человек, case when вид = 'duty' then роль end) *
          from e
         order by вид, дата, цель, человек, case when вид = 'duty' then роль end, created_at
    ),
    итог as (
        select ф.*,
               case
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
          from первые ф
    ),
    строки as (
        select что,
               string_agg(concat_ws(' ', worship_day_label(дата) || ',', время, worship_html(служба))
                          || case when что in ('поставили', 'сняли')
                                  then ' — ' || worship_role_label(роль) else '' end,
                          E'\n' order by дата, время) as список
          from итог where что is not null
         group by что
    )
    select nullif(concat_ws(E'\n\n',
               (select E'<b>Вас поставили:</b>\n' || список from строки where что = 'поставили'),
               (select E'<b>Вас сняли:</b>\n' || список from строки where что = 'сняли'),
               (select E'<b>Не проводится — приходить не нужно:</b>\n' || список from строки where что = 'отменена'),
               (select E'<b>Снова проводится — вы на месте:</b>\n' || список from строки where что = 'вернули')), '')
           || E'\n<a href="https://in.rupaseva.com/worship/schedule.html">Расписание</a>'
$$;
revoke all on function worship_schedule_text(uuid[]) from public, anon, authenticated;

-- ---- отправщик: адрес, расписание, пачки ----
do $$
declare
    d text := pg_get_functiondef('worship_notify_pack'::regproc);
    было_адрес text := E'            select telegram_chat_id into v_адрес from vaishnavas\n             where user_id = v_строка.recipient and telegram_chat_id is not null;\n';
    было_выбор text := E'         where n.sent_at is null\n         group by n.recipient';
    было_конец text := E'        v_текст := worship_cut(btrim(v_текст));\n        if coalesce(v_текст, '''') = '''' then continue; end if;\n';
begin
    if position(было_адрес in d) = 0 then raise exception 'worship_notify_pack: адрес не найден'; end if;
    if position(было_выбор in d) = 0 then raise exception 'worship_notify_pack: выборка не найдена'; end if;
    if position(было_конец in d) = 0 then raise exception 'worship_notify_pack: конец не найден'; end if;

    d := replace(d, было_адрес,
        E'            -- рабочий бот @SRSKteambot: привязка из профиля (миграция 281)\n'
        || E'            v_адрес := worship_tg_address(v_строка.recipient);\n');

    d := replace(d, было_выбор,
        E'         where n.sent_at is null\n'
        || E'           -- расписание старший правит пачкой: ждём 10 минут тишины по человеку\n'
        || E'           and not (n.kind in (''duty_set'', ''duty_cleared'', ''service_cancelled'', ''service_restored'')\n'
        || E'                    and exists (select 1 from worship_notifications m\n'
        || E'                                 where m.recipient = n.recipient and m.sent_at is null\n'
        || E'                                   and m.kind in (''duty_set'', ''duty_cleared'', ''service_cancelled'', ''service_restored'')\n'
        || E'                                   and m.created_at > now() - interval ''10 minutes''))\n'
        || E'         group by n.recipient');

    d := replace(d, было_конец,
        E'        v_часть := worship_schedule_text(v_строка.события);\n'
        || E'        if v_часть is not null then v_текст := btrim(v_текст || E''\\n\\n'' || v_часть, E''\\n''); end if;\n'
        || E'\n'
        || E'        v_текст := worship_cut(btrim(v_текст));\n'
        || E'        -- поставили и сразу сняли — сказать нечего, но события закрыть\n'
        || E'        if coalesce(v_текст, '''') = '''' then\n'
        || E'            if not p_dry then\n'
        || E'                update worship_notifications set sent_at = now(), batch_id = v_batch\n'
        || E'                 where id = any(v_строка.события);\n'
        || E'            end if;\n'
        || E'            continue;\n'
        || E'        end if;\n');

    execute d;
end $$;

-- ---- «Завтра у вас» ----
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
            -- службы завтра: действующие и не отменённые на день, плюс разовые
            select d.id, d.person_id, d.role, d.service_id, d.override_id,
                   coalesce(s.time_of_day, o.time_of_day) as время,
                   coalesce(s.name_ru, o.title) as служба,
                   s.article_id
              from worship_duties d
              left join worship_services s on s.id = d.service_id
              left join worship_day_overrides o on o.id = d.override_id
             where d.duty_date = v_завтра
               and (d.override_id is not null
                    or (s.is_active and not exists (
                        select 1 from worship_day_overrides x
                         where x.duty_date = v_завтра and x.service_id = d.service_id)))
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
                   concat_ws(' ', to_char(ж.время, 'HH24:MI'),
                             case when ж.article_id is not null
                                  then format('<a href="https://in.rupaseva.com/worship/article.html?id=%s">%s</a>',
                                              ж.article_id, worship_html(ж.служба))
                                  else worship_html(ж.служба) end)
                   || ' — ' || worship_role_label(ж.role)
                   -- с кем вместе: договориться заранее, кто что готовит
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
            -- повторный запуск в тот же вечер не дублирует сообщение
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

-- ---- старшему: дыры на завтра ----
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
        select s.id as цель, s.time_of_day as время, s.name_ru as служба
          from worship_services s
         where s.is_active
           and not exists (select 1 from worship_day_overrides o
                            where o.duty_date = v_завтра and o.service_id = s.id)
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
                   -- клетка закрыта, только если придёт ведущий пуджари
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

-- ---- расписание рассылок (время — UTC; Индия = UTC+5:30) ----
-- пачки — раз в 10 минут: изменения расписания доходят через 10–20 минут
select cron.unschedule('worship-notify') where exists (select 1 from cron.job where jobname = 'worship-notify');
select cron.schedule('worship-notify', '*/10 * * * *', $c$select public.worship_notify_pack(false, false)$c$);
-- 18:30 по Индии — старшему дыры на завтра, за час до общей рассылки
select cron.unschedule('worship-gaps') where exists (select 1 from cron.job where jobname = 'worship-gaps');
select cron.schedule('worship-gaps', '0 13 * * *', $c$select public.worship_notify_gaps(false)$c$);
-- 19:30 по Индии — «Завтра у вас»
select cron.unschedule('worship-tomorrow') where exists (select 1 from cron.job where jobname = 'worship-tomorrow');
select cron.schedule('worship-tomorrow', '0 14 * * *', $c$select public.worship_notify_tomorrow(false)$c$);
