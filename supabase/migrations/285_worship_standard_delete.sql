-- 285: удалить стандарт из архива может старший пуджари (решение Адриана
-- 19.10.2026). Порядок как у материалов: сначала в архив, потом удалять —
-- действующий стандарт одним нажатием не пропадёт.
--
-- Вместе со стандартом уходят его редакции, замечания, теги, закладки и
-- пункты подборок (каскад). Ссылки других стандартов на него («заменил»,
-- «перевод») обнуляются — иначе база не даст удалить.

create or replace function worship_standard_delete(p_article uuid)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
declare
    v_статья worship_articles%rowtype;
    v_подборок integer;
begin
    if not worship_can_approve() then
        raise exception 'Удалять стандарты может старший пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Стандарт не найден'; end if;
    if v_статья.kind <> 'standard' then
        raise exception 'Это не стандарт';
    end if;
    if v_статья.status <> 'archived' then
        raise exception 'Сначала отмените стандарт — удалить можно только из архива';
    end if;

    select count(distinct kit_id) into v_подборок from worship_kit_items where article_id = p_article;

    update worship_articles set replaced_by_id = null where replaced_by_id = p_article;
    update worship_articles set translation_of = null where translation_of = p_article;
    delete from worship_articles where id = p_article;

    return jsonb_build_object('ok', true, 'подборок', v_подборок);
end $$;
revoke all on function worship_standard_delete(uuid) from public, anon;
grant execute on function worship_standard_delete(uuid) to authenticated;
