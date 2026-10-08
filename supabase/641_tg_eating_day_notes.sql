-- 641: примечание к дню из «Разового питания» (meal_group_days.note, миграция 640) —
-- поварам в сообщение бота о вкушающих (ВГ, 08.10.2026). Пример: Дикша-ретрит, 12.10 —
-- «19 человек возможно чуть позже приедут, нужно отложить им».
-- Меняем только конец tg_eating_text: подставляем в текущее определение.

do $mig$
declare
    src text := pg_get_functiondef('public.tg_eating_text(date,boolean)'::regprocedure);
    old_part text := $o$  RETURN v_line;
END;$o$;
    new_part text := $n$  -- примечания к этому дню для поваров (640)
  SELECT string_agg('• ' || replace(replace(replace(mg.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                    || ': ' || replace(replace(replace(gd.note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                    E'\n' ORDER BY mg.name)
    INTO parts
    FROM meal_group_days gd
    JOIN meal_groups mg ON mg.id = gd.group_id AND mg.by_day
   WHERE gd.d = p_date AND nullif(btrim(gd.note), '') IS NOT NULL;
  IF parts IS NOT NULL THEN
    v_line := v_line || E'\n\n📝 <b>Примечания</b>\n' || parts;
  END IF;

  RETURN v_line;
END;$n$;
begin
    if position(old_part in src) = 0 then
        raise exception 'tg_eating_text: конец функции не найден — функция менялась, правьте миграцию';
    end if;
    execute replace(src, old_part, new_part);
end
$mig$;
