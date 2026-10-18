-- Поправка к 214: обрезка по-прежнему рвала слово. Виноват coalesce,
-- стоявший снаружи вычитания: когда разделитель не найден, strpos даёт 0,
-- и «длина − 0 + 1» оказывалось больше всех настоящих позиций, то есть
-- побеждал именно отсутствующий разделитель.
--
-- Считаем позицию только для тех разделителей, которые действительно нашлись.
create or replace function worship_cut(p_text text, p_limit integer default 3900)
returns text
language plpgsql immutable
as $$
declare
    v_кусок   text;
    v_обратно text;
    v_место   integer := 0;
    v_где     integer;
begin
    if p_text is null or length(p_text) <= p_limit then return p_text; end if;

    v_кусок := left(p_text, p_limit);
    v_обратно := reverse(v_кусок);

    v_где := strpos(v_обратно, E'\n');
    if v_где > 0 then v_место := greatest(v_место, length(v_кусок) - v_где + 1); end if;

    v_где := strpos(v_обратно, ' ');
    if v_где > 0 then v_место := greatest(v_место, length(v_кусок) - v_где + 1); end if;

    -- разделителя нет вовсе (сплошное полотно) — режем по пределу
    if v_место < p_limit / 2 then v_место := p_limit; end if;

    return btrim(btrim(left(v_кусок, v_место - 1), ' ,' || E'\n'))
           || E'\n… и ещё. Весь список — в модуле «Поклонение».';
end $$;

revoke all on function worship_cut(text, integer) from public, anon;
