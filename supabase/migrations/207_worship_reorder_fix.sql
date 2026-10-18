-- Починка 206, найденная сразу на проверке: пока у всех статей раздела
-- порядковый номер нулевой (а так и будет до первой перестановки), поиск соседа
-- по паре (номер, заголовок) выбирал не соседа, а край, и «вверх» перебрасывало
-- статью через две позиции, а «вниз» перемешивало раздел.
--
-- Стало: сначала раздаём номера по текущему видимому порядку, потом меняем
-- местами ровно двух соседей. Нормализация заодно лечит раздел, уже перепутанный
-- прежней версией.
create or replace function worship_reorder(p_article uuid, p_direction integer)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья worship_articles%rowtype;
    v_мой    integer;
    v_сосед  uuid;
begin
    if not worship_can_write() then
        raise exception 'Менять порядок статей может пуджари' using errcode = '42501';
    end if;
    if p_direction not in (-1, 1) then
        raise exception 'Двигать можно на одну позицию вверх или вниз';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;

    -- номера по текущему видимому порядку: 0, 1, 2 …
    with упорядоченные as (
        select id, (row_number() over (order by sort_order, title, id) - 1)::int as n
          from worship_articles
         where kind = v_статья.kind
           and section_id is not distinct from v_статья.section_id
    )
    update worship_articles a
       set sort_order = у.n
      from упорядоченные у
     where a.id = у.id and a.sort_order is distinct from у.n;

    select sort_order into v_мой from worship_articles where id = p_article;

    select id into v_сосед
      from worship_articles
     where kind = v_статья.kind
       and section_id is not distinct from v_статья.section_id
       and sort_order = v_мой + p_direction
     limit 1;

    if v_сосед is null then return jsonb_build_object('ok', true, 'край', true); end if;

    update worship_articles set sort_order = v_мой, updated_at = now() where id = v_сосед;
    update worship_articles set sort_order = v_мой + p_direction, updated_at = now() where id = p_article;

    return jsonb_build_object('ok', true, 'позиция', v_мой + p_direction);
end $$;

revoke all on function worship_reorder(uuid, integer) from public, anon, authenticated;
grant execute on function worship_reorder(uuid, integer) to authenticated;
