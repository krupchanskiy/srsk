-- 293: бот узнаёт человека по нику из любого из двух полей карточки.
--
-- Ник лежит то в vaishnavas.telegram (правка профиля), то в
-- vaishnavas.telegram_username (анкета команды, гостевые формы). Бот искал
-- только в первом — у 85 человек ник был лишь во втором, и написавшего боту
-- он не узнавал (так было с Ачинтьей-чайтаньей, 25.10.2026).
--
-- Совпадение по-прежнему строго одно: два человека с одним ником — не гадаем.
-- Удалённые карточки не в счёт.

do $$
declare
    d text := pg_get_functiondef('tg_resolve_user'::regproc);
    было text := 'WHERE tg_norm_username(v.telegram) = v_norm';
    стало text := 'WHERE v_norm IN (tg_norm_username(v.telegram), tg_norm_username(v.telegram_username))'
               || ' AND NOT coalesce(v.is_deleted, false)';
    н integer := (length(d) - length(replace(d, было, ''))) / length(было);
begin
    if н <> 2 then raise exception 'tg_resolve_user: ожидал 2 места сверки ника, нашёл %', н; end if;
    execute replace(d, было, стало);
end $$;
