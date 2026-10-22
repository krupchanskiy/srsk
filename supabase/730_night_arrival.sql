-- 730: ночной приезд (ВГ, 22.10.2026, «Шахматка 13»). Рейс 23.10 22:30 → в ашраме ~02:30 24.10:
-- заезд в шахматке ставится на 23.10 (номер держится с вечера, ночь — обычная ночь, без доплаты),
-- «Ожидается в ~02:30». Время раньше 6:00 у места = утро СЛЕДУЮЩЕГО дня после заезда:
-- в день заезда человек не ест, со следующего — завтрак и обед. Мест с таким временем до этой
-- миграции не было (проверено 22.10) — прежние записи не меняются.
do $mig$
declare
    d text := pg_get_functiondef('public.eating_detail'::regproc);
    n text := pg_get_functiondef('public.eating_day_notes'::regproc);
    old_arr text := 'CASE WHEN r.arrival_time IS NOT NULL THEN r.check_in + r.arrival_time ELSE rg.arr END AS arr,';
    new_arr text := 'CASE WHEN r.arrival_time IS NOT NULL
                THEN r.check_in + CASE WHEN r.arrival_time < time ''06:00'' THEN 1 ELSE 0 END + r.arrival_time
                ELSE rg.arr END AS arr,
           -- ночной приезд (730): заезд накануне, до времени приезда не ест
           COALESCE(r.arrival_time < time ''06:00'', false) AS night,';
    old_gone text := '           NOT x.gone';
    new_gone text := '           NOT x.gone AND NOT (x.night AND NOT x.early AND x.d < x.arr::date)';
    day_expr text := '(r.check_in + CASE WHEN r.arrival_time < time ''06:00'' THEN 1 ELSE 0 END)';
begin
    if position(old_arr in d) = 0 or (length(d) - length(replace(d, old_gone, ''))) / length(old_gone) <> 2 then
        raise exception 'eating_detail: место правки не найдено — функция менялась, правьте миграцию';
    end if;
    if position('SELECT r.check_in AS d,' in n) = 0 or position('WHERE r.check_in BETWEEN p_from AND p_to' in n) = 0 then
        raise exception 'eating_day_notes: место правки не найдено — функция менялась, правьте миграцию';
    end if;
    execute replace(replace(d, old_arr, new_arr), old_gone, new_gone);
    -- примечание поварам — в день, когда человек приедет
    execute replace(replace(n, 'SELECT r.check_in AS d,', 'SELECT ' || day_expr || ' AS d,'),
                    'WHERE r.check_in BETWEEN p_from AND p_to', 'WHERE ' || day_expr || ' BETWEEN p_from AND p_to');
end
$mig$;
