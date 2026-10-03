-- 631: перенос аванса группы на организатора — без сообщений в чат департамента (ВГ, 03.10.2026).
-- Перенос (630) — это сторно + платёж на том же счёте: деньги не двигаются, у держателя
-- остаток прежний. Но триггер tg_notify_dept_credit слал на каждую проводку отдельное
-- сообщение («Приход +30 000», «Операция отменена −30 000»), и они приходили в обратном
-- порядке — в чате Ашиша выглядело как списание 30 000. Глушим уведомления на время
-- переноса и возвращаем прежнее значение флага после.

do $mig$
declare
    v_def text;
    v_old_begin text := $a$        a record; v_r jsonb;
    begin
        for a in$a$;
    v_new_begin text := $a$        a record; v_r jsonb;
        v_sup text := current_setting('tg.suppress_chat_notify', true);
    begin
        -- деньги не двигаются: сообщения держателю счёта не нужны (631)
        perform set_config('tg.suppress_chat_notify', '1', true);
        for a in$a$;
    v_old_end text := $e$                    using detail = 'Аванс группы: ' || coalesce(v_r->'error'->>'message', 'не удалось провести платёж');
            end if;
        end loop;$e$;
    v_new_end text := $e$                    using detail = 'Аванс группы: ' || coalesce(v_r->'error'->>'message', 'не удалось провести платёж');
            end if;
        end loop;
        perform set_config('tg.suppress_chat_notify', coalesce(v_sup, ''), true);$e$;
begin
    v_def := pg_get_functiondef('public.fin_group_save(jsonb)'::regprocedure);
    if (length(v_def) - length(replace(v_def, v_old_begin, ''))) / length(v_old_begin) <> 1
       or (length(v_def) - length(replace(v_def, v_old_end, ''))) / length(v_old_end) <> 1 then
        raise exception 'fin_group_save: блок переноса аванса не найден';
    end if;
    v_def := replace(v_def, v_old_begin, v_new_begin);
    v_def := replace(v_def, v_old_end, v_new_end);
    execute v_def;
end;
$mig$;
