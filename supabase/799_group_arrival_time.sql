-- 799: «Ожидается в ~» из окна «Расчёт группы» → место в шахматке.
-- Общее время приезда/выезда группы (ВГ 18.11): окно присылает arrival_time так же,
-- как departure_time (731). Точечная правка fin_group_save: новый ключ + запись в residents.
do $mig$
declare d text; n text;
begin
    d := pg_get_functiondef('public.fin_group_save(jsonb)'::regprocedure);
    n := replace(d, $a$'late_fee', 'departure_time']$a$, $a$'late_fee', 'departure_time', 'arrival_time']$a$);
    n := replace(n,
        $a$            update residents set departure_time = nullif(l->>'departure_time', '')::time where id = v_rid;
        end if;$a$,
        $a$            update residents set departure_time = nullif(l->>'departure_time', '')::time where id = v_rid;
        end if;
        -- «Ожидается в ~» из окна оплаты (799): общее время приезда группы
        if v_rid is not null and l ? 'arrival_time' then
            update residents set arrival_time = nullif(l->>'arrival_time', '')::time where id = v_rid;
        end if;$a$);
    if n = d or position('arrival_time' in n) = 0
       or (length(n) - length(replace(n, 'arrival_time', ''))) / length('arrival_time') <> 4 then
        raise exception 'fin_group_save: текст функции не тот, правка не применена';
    end if;
    execute n;
end
$mig$;
