-- 275: у материала библиотеки достаточно названия — описание необязательно
-- (решение Адриана 19.10.2026). Из worship_save_draft убирается только
-- проверка непустого summary для kind = 'material', остальное не меняется.
do $$
declare
    d text := pg_get_functiondef('worship_save_draft'::regproc);
    блок text := E'    if v_kind = ''material''\n       and coalesce(btrim(coalesce(payload->>''summary'', v_статья.summary, '''')), '''') = '''' then\n        raise exception ''Напишите одной фразой, о чём материал'';\n    end if;\n\n';
begin
    if position(блок in d) = 0 then
        raise exception 'проверка описания не найдена — функция изменилась, правка не применена';
    end if;
    execute replace(d, блок, '');
end $$;
