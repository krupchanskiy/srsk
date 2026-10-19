-- 282: приветствие «Поклонения» при привязке телеграма и включение рассылки.
--
-- Рабочий бот на /start отвечает про расходы («могу записывать расходы от
-- вашего имени») — пуджари это сбивает. Бот общий с финансами, его не
-- трогаем: следом из очереди уходит своё сообщение участнику отдела.
--
-- Рубильник включён по решению Адриана 19.10.2026: пока только личные
-- сообщения, чат отдела (department_chat_id) не задан и остаётся пустым.

create or replace function worship_tg_welcome()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
    if tg_op = 'UPDATE' and new.vaishnava_id is not distinct from old.vaishnava_id then return null; end if;
    if not exists (select 1 from worship_settings where key = 'notify_enabled' and value = 'true') then
        return null;
    end if;
    if not exists (select 1 from worship_people p
                    where p.vaishnava_id = new.vaishnava_id and p.is_active) then
        return null;
    end if;
    insert into tg_outbox (chat_id, text, kind)
    values (new.tg_user_id,
            E'<b>Поклонение:</b> напоминания будут приходить сюда.\n'
            || E'Накануне вечером — какие у вас завтра службы. Если старший поменяет расписание — сразу скажем.\n'
            || '<a href="https://in.rupaseva.com/worship/schedule.html">Расписание</a>',
            'worship');
    return null;
end $$;

drop trigger if exists tg_user_links_worship_welcome on tg_user_links;
create trigger tg_user_links_worship_welcome after insert or update on tg_user_links
    for each row execute function worship_tg_welcome();

update worship_settings set value = 'true', updated_at = now() where key = 'notify_enabled';
