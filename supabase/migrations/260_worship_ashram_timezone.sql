-- «Сегодня» в модуле «Поклонение» — по часам ашрама (Индия), а не по UTC.
--
-- База живёт в UTC, и current_date в функциях модуля с 00:00 до 05:30 по
-- Индии возвращал вчерашний день: «кто старший в отъезде сегодня»,
-- предупреждение «срок участия истекает», «назначений впереди» считались
-- по чужому календарю. Решение Адриана 19.10.2026: Индия.
--
-- Пояс задаётся самой функции (set timezone), а не всей базе: остальные
-- модули этим не задеты. Внутри функции current_date, now()::date и
-- to_char от меток времени дают время ашрама; сами метки времени
-- (timestamptz) хранятся как и прежде.
do $$
declare ф record;
begin
    for ф in
        select p.oid::regprocedure as сигнатура
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'worship\_%' and p.prokind = 'f'
    loop
        execute format('alter function %s set timezone to %L', ф.сигнатура, 'Asia/Kolkata');
    end loop;
end $$;
