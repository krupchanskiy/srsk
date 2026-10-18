-- Блок 1.7: порядок статей внутри раздела задаётся руками.
--
-- Без этого сверху оказывается «Если пуджари опоздал», а основная статья тонет
-- ниже: алфавит и дата тут не помогают. Правка идёт через функцию только потому,
-- что политик записи у worship_articles нет вовсе — состояние и номера версий
-- ставят функции, и делать исключение для одной колонки было бы хуже.
create or replace function worship_reorder(p_article uuid, p_direction integer)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья worship_articles%rowtype;
    v_сосед  worship_articles%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Менять порядок статей может пуджари' using errcode = '42501';
    end if;
    if p_direction not in (-1, 1) then
        raise exception 'Двигать можно на одну позицию вверх или вниз';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;

    -- сосед — ближайшая статья того же раздела по ту сторону; при равных
    -- порядковых номерах (их ставит по умолчанию ноль) разбираем по заголовку,
    -- иначе соседа не найти и кнопка молча ничего не делает
    select * into v_сосед
      from worship_articles
     where kind = v_статья.kind
       and section_id is not distinct from v_статья.section_id
       and id <> v_статья.id
       and ((sort_order, title) < (v_статья.sort_order, v_статья.title)) = (p_direction = -1)
     order by case when p_direction = -1 then -1 else 1 end * sort_order,
              case when p_direction = -1 then '' else title end desc,
              case when p_direction = -1 then title else '' end
     limit 1
     for update;

    if not found then return jsonb_build_object('ok', true, 'край', true); end if;

    -- одинаковые номера пришлось бы разруливать вечно: раздаём их заново по месту
    update worship_articles set sort_order = v_сосед.sort_order, updated_at = now() where id = v_статья.id;
    update worship_articles set sort_order = v_статья.sort_order, updated_at = now() where id = v_сосед.id;

    if v_статья.sort_order = v_сосед.sort_order then
        update worship_articles set sort_order = v_сосед.sort_order + p_direction where id = v_статья.id;
    end if;

    return jsonb_build_object('ok', true);
end $$;

revoke all on function worship_reorder(uuid, integer) from public, anon, authenticated;
grant execute on function worship_reorder(uuid, integer) to authenticated;
