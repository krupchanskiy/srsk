-- Две дыры, найденные ночным аудитом. Ключ anon публичен: он лежит в каждой
-- странице сайта, поэтому всё, что ему доступно, доступно любому в интернете.

-- 1. Задания на удаление сообщений Telegram: RLS был выключен, и аноним
--    читал 36 строк с chat_id и message_id, а мог вставлять и менять
--    задания — то есть удалять чужие сообщения в чатах бота.
--    Пользуются таблицей только функции tg_schedule_delete и
--    tg_scheduled_deletes_flush (definer, владелец postgres — RLS их
--    не касается) и функция tg-webhook с сервисным ключом.
alter table public.tg_scheduled_deletes enable row level security;
revoke all on table public.tg_scheduled_deletes from anon, authenticated;
revoke execute on function public.tg_schedule_delete(bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function public.tg_scheduled_deletes_flush() from public, anon, authenticated;

-- 2. Представление «непокрытые ночи размещения»: definer-view с правом
--    select для anon. Аноним читал имена гостей, даты приезда и отъезда,
--    номера сделок. Страница шахматки (timeline.js) читает его под
--    вошедшим пользователем — ей право остаётся.
revoke all on table public.v_placement_uncovered from anon;
revoke insert, update, delete, truncate, references, trigger
    on table public.v_placement_uncovered from authenticated;
