-- Ночной аудит базы модуля «Поклонение»: права и молчаливые потери.

-- 1. Аноним модулю не нужен вовсе: все проверки начинаются с auth.uid(),
--    гостевой портал модуль не трогает. TRUNCATE, REFERENCES и TRIGGER
--    не нужны и вошедшим — TRUNCATE к тому же идёт мимо RLS.
do $$
declare t text;
begin
    for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname like 'worship\_%' and c.relkind in ('r', 'v')
    loop
        execute format('revoke all on table public.%I from anon', t);
        execute format('revoke truncate, references, trigger on table public.%I from authenticated', t);
    end loop;
end $$;

-- 2. Прямые правки мимо функций. Страницы меняют наборы и снимки только
--    через worship_album_update / worship_album_visibility /
--    worship_image_caption / worship_image_delete / worship_image_reorder —
--    там проверки «снимки стоят в стандартах» и «закрыть может автор или
--    старший». А политика UPDATE пускала любого пуджари напрямую: запрос
--    is_private=true из консоли браузера молча вырезал снимок из
--    действующего стандарта у всех, кроме отдела. Функции — definer,
--    им эти права не нужны.
revoke update on table public.worship_albums from authenticated;
revoke update, delete on table public.worship_images from authenticated;
-- вложения материалов правятся только добавлением и удалением
revoke update on table public.worship_attachments from authenticated;

-- 3. Кому слать письма: учитывать отзыв личного права (is_granted = false)
--    и снятую роль (is_active = false) — так же, как это делает проверка
--    прав abk_current_user_has_permission. Раньше человек, у которого
--    право отозвали, продолжал получать «ждёт вашего решения».
--    Суперпользователей по-прежнему не берём — см. миграцию 251.
create or replace function public.worship_holders(p_permission text)
returns setof uuid
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
    with личные as (
        -- последняя запись о личном праве перекрывает роль
        select distinct on (up.user_id) up.user_id, up.is_granted
          from user_permissions up
          join permissions p on p.id = up.permission_id
         where p.code = p_permission
         order by up.user_id, up.created_at desc
    ),
    по_роли as (
        select distinct ur.user_id
          from user_roles ur
          join role_permissions rp on rp.role_id = ur.role_id
          join permissions p on p.id = rp.permission_id
         where p.code = p_permission and ur.is_active
    )
    select л.user_id from личные л where л.is_granted and л.user_id is not null
    union
    select р.user_id from по_роли р
     where р.user_id is not null
       and not exists (select 1 from личные л where л.user_id = р.user_id)
$function$;

-- 4. «Человек в отъезде» не должен зависеть от права на просмотр:
--    старший с правом утверждения, но без просмотра, получал «не в отъезде»
--    и ставил в расписание того, кого не будет. Видеть отметку может любой
--    с правом в модуле.
create or replace function public.worship_is_away(p_person uuid, p_date date)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
    select (worship_can_view() or worship_can_write() or worship_can_approve())
       and exists (
        select 1 from worship_absences a
         where a.person_id = p_person
           and p_date between a.date_from and coalesce(a.date_to, 'infinity'::date))
$function$;

-- 5. У простых функций текста не было search_path (предупреждение советника).
alter function public.worship_cut(text, integer) set search_path to 'public', 'pg_temp';
alter function public.worship_html(text) set search_path to 'public', 'pg_temp';

-- 6. Отметка «меня не будет» создавала событие absence_set, но сборщик писем
--    этого вида не знал: текст выходил пустым, письмо пропускалось, а через
--    14 дней событие помечалось отправленным. Старший так и не узнавал,
--    что на службу нужна замена.
create or replace function public.worship_notify_pack(p_dry boolean default true, p_log boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_batch   uuid := gen_random_uuid();
    v_строка  record;
    v_текст   text;
    v_часть   text;
    v_штук    integer;
    v_всего   integer := 0;
    v_писем   integer := 0;
    v_старьё  integer := 0;
    v_итог    jsonb := '[]'::jsonb;
    v_живьём  boolean;
    v_чат     bigint;
    v_адрес   bigint;
    v_ушло    boolean;
begin
    select coalesce(value = 'true', false) into v_живьём
      from worship_settings where key = 'notify_enabled';
    if not coalesce(v_живьём, false) then p_dry := true; end if;

    select nullif(value, '')::bigint into v_чат
      from worship_settings where key = 'department_chat_id';

    update worship_notifications
       set sent_at = now(), batch_id = v_batch
     where sent_at is null and created_at < now() - interval '14 days';
    get diagnostics v_старьё = row_count;

    for v_строка in
        select n.recipient,
               array_agg(n.id order by n.created_at) as события,
               count(*) as штук
          from worship_notifications n
         where n.sent_at is null
         group by n.recipient
    loop
        v_текст := '';
        v_штук := v_строка.штук;

        select case when count(*) = 0 then null
                    when count(*) = 1 then
                        format('Утверждён стандарт «%s» (версия %s).',
                               worship_html(max(payload->>'заголовок')), max(payload->>'номер'))
                        || coalesce(' ' || worship_html(nullif(max(payload->>'примечание'), '')), '')
                    else format('Утверждены стандарты (%s): %s.', count(*),
                                string_agg(format('«%s»', worship_html(payload->>'заголовок')),
                                           ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'approved';
        if v_часть is not null then v_текст := v_текст || v_часть; end if;

        select case when count(*) = 0 then null
                    when count(*) = 1 then
                        format('Ждёт вашего решения: «%s».',
                               worship_html(max(payload->>'заголовок')))
                        || coalesce(' ' || worship_html(nullif(max(payload->>'примечание'), '')), '')
                    else format('Ждут вашего решения (%s): %s.', count(*),
                                string_agg(format('«%s»', worship_html(payload->>'заголовок')),
                                           ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'submitted';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select string_agg(format('Вернули на доработку «%s»: %s',
                                 worship_html(payload->>'заголовок'),
                                 worship_html(payload->>'причина')), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'returned';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select string_agg(format('Замечание к «%s»: %s',
                                 worship_html(payload->>'заголовок'),
                                 worship_html(payload->>'текст')), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'remark';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        -- выдача подборки: письмо адресату со ссылкой, по которой он её откроет
        select string_agg(format('Вам открыта подборка «%s»: https://in.rupaseva.com/worship/kit.html?id=%s',
                                 worship_html(payload->>'заголовок'),
                                 payload->>'kit_id'), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'kit_granted';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        -- «меня не будет»: старшему — кто, когда и сколько клеток остались без человека
        select string_agg(
                   format('%s не сможет служить %s%s',
                          worship_html(coalesce(nullif(payload->>'имя', ''), 'Кто-то из отдела')),
                          case when nullif(payload->>'по', '') is null
                               then 'с ' || to_char((payload->>'с')::date, 'DD.MM') || ', без срока'
                               when payload->>'по' = payload->>'с'
                               then to_char((payload->>'с')::date, 'DD.MM')
                               else to_char((payload->>'с')::date, 'DD.MM') || '–'
                                    || to_char((payload->>'по')::date, 'DD.MM') end,
                          case when coalesce((payload->>'клеток')::integer, 0) > 0
                               then format(' — назначений на эти дни: %s, нужна замена.',
                                           payload->>'клеток')
                               else '.' end),
                   E'\n' order by created_at)
               || E'\nРасписание: https://in.rupaseva.com/worship/schedule.html'
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'absence_set';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select case when count(*) = 0 then null
                    else format('Дольше месяца ждут решения: %s.',
                                string_agg(format('«%s»', worship_html(payload->>'заголовок')),
                                           ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'stale';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        v_текст := worship_cut(btrim(v_текст));
        if coalesce(v_текст, '') = '' then continue; end if;

        if v_строка.recipient is null then
            v_адрес := v_чат;
        else
            select telegram_chat_id into v_адрес from vaishnavas
             where user_id = v_строка.recipient and telegram_chat_id is not null;
        end if;

        v_ушло := not p_dry and v_адрес is not null;

        if p_log or v_ушло then
            insert into worship_notification_log (batch_id, recipient, message, events, dry_run)
            values (v_batch, v_строка.recipient, v_текст, v_штук, not v_ушло);
        end if;

        if v_ушло then
            insert into tg_outbox (chat_id, text, kind) values (v_адрес, v_текст, 'worship');
            update worship_notifications
               set sent_at = now(), batch_id = v_batch
             where id = any(v_строка.события);
        end if;

        v_писем := v_писем + 1;
        v_всего := v_всего + v_штук;
        v_итог := v_итог || jsonb_build_object(
            'кому', coalesce(v_строка.recipient::text, 'чат отдела'),
            'адрес_есть', v_адрес is not null,
            'ушло', v_ушло,
            'событий', v_штук, 'текст', v_текст);
    end loop;

    return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'batch_id', v_batch,
                              'писем', v_писем, 'событий', v_всего,
                              'просрочено', v_старьё, 'сообщения', v_итог);
end $function$;
