-- Окно «Начислить группе» (ВГ, 29.09.2026): сняты ПОСЛЕДНИЕ дни строки — человек уехал
-- раньше. Строка приносит depart_on (новый выезд), fin_group_save переносит его в шахматку
-- (residents.check_out) — кухня поправится сама, бронь следует за местом (583/584).
-- Только раньше прежнего выезда и не раньше заезда; снятые дни в середине (экскурсия)
-- сюда не приходят — шахматку не трогают. Ранний выезд пишется и у строк «не начисляем»:
-- уехал — значит уехал, независимо от денег.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.fin_group_save(jsonb)'::regprocedure) into v_def;

  v_new := replace(v_def,
    $a$'extra_bed', 'extra_bed_price']);$a$,
    $a$'extra_bed', 'extra_bed_price', 'depart_on']);$a$);

  v_new := replace(v_new,
    $a$        if not coalesce((l->>'included')::boolean, true) then$a$,
    $a$        -- уехал раньше: выезд из окна → шахматка (только раньше прежнего и не раньше заезда)
        if v_rid is not null and nullif(l->>'depart_on', '') is not null then
            update residents set check_out = (l->>'depart_on')::date
             where id = v_rid and (l->>'depart_on')::date >= check_in
               and (l->>'depart_on')::date < coalesce(check_out, 'infinity'::date);
        end if;
        if not coalesce((l->>'included')::boolean, true) then$a$);

  if v_new = v_def or position('depart_on'']);' in v_new) = 0 or position('уехал раньше' in v_new) = 0 then
    raise exception 'fin_group_save: не найдено место для правки';
  end if;
  execute v_new;
end $$;
