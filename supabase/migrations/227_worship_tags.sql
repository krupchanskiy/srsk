-- Блок 3.3, часть первая: теги.
--
-- Словарь один на весь модуль: тег «Экадаши» — тот же у стандарта, у материала
-- и у набора фотографий. Поэтому на странице стандарта честно показывается
-- «по этим тегам есть ещё материалы и фото».
create table if not exists worship_tags (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    -- ключ нормализован: иначе появятся «Экадаши», «экадаши» и « Экадаши »
    slug       text not null unique,
    created_at timestamptz not null default now(),
    created_by uuid
);

-- Связь с целью — ДВА отдельных поля со ссылками, а не «тип цели плюс номер».
-- Иначе теряется целостность при удалении и, что хуже, правило доступа не может
-- проверить, видна ли человеку цель: по тегу «Экадаши» рядовой сотрудник
-- получил бы список закрытых наборов и неутверждённых статей.
create table if not exists worship_tag_links (
    id         uuid primary key default gen_random_uuid(),
    tag_id     uuid not null references worship_tags(id) on delete cascade,
    article_id uuid references worship_articles(id) on delete cascade,
    album_id   uuid references worship_albums(id) on delete cascade,
    created_at timestamptz not null default now(),
    created_by uuid,
    constraint worship_tag_link_target check (num_nonnulls(article_id, album_id) = 1)
);

create unique index if not exists worship_tag_links_article_once
    on worship_tag_links (tag_id, article_id) where article_id is not null;
create unique index if not exists worship_tag_links_album_once
    on worship_tag_links (tag_id, album_id) where album_id is not null;
create index if not exists worship_tag_links_article_idx on worship_tag_links (article_id);
create index if not exists worship_tag_links_album_idx on worship_tag_links (album_id);

alter table worship_tags enable row level security;
alter table worship_tag_links enable row level security;

create policy "worship tags view" on worship_tags for select using (worship_can_view());
create policy "worship tags insert" on worship_tags for insert
    with check (worship_can_write() and created_by = auth.uid());

-- Связь видна тогда, когда видна её цель: правило доступа само проверяет
-- статью и набор, поэтому по тегу не утекут ни черновики, ни закрытые наборы.
create policy "worship tag links view" on worship_tag_links for select
    using (worship_can_view() and (
        (article_id is not null and exists (select 1 from worship_articles a where a.id = article_id))
     or (album_id is not null and exists (select 1 from worship_albums al where al.id = album_id))));
create policy "worship tag links insert" on worship_tag_links for insert
    with check (worship_can_write() and created_by = auth.uid());
create policy "worship tag links delete" on worship_tag_links for delete
    using (worship_can_write());

-- ── ключ тега ────────────────────────────────────────────────────────────────
create or replace function worship_tag_slug(p_name text)
returns text
language sql immutable
as $$ select nullif(regexp_replace(lower(btrim(coalesce(p_name, ''))), '\s+', ' ', 'g'), '') $$;

-- Тег заводится прямо при написании, с подсказкой существующих: совпадение
-- ищется по нормализованному ключу, а не по написанию.
create or replace function worship_tag_ensure(p_name text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_slug text := worship_tag_slug(p_name);
    v_tag  worship_tags%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Заводить теги может пуджари' using errcode = '42501';
    end if;
    if v_slug is null then raise exception 'Пустой тег ни о чём не говорит'; end if;

    select * into v_tag from worship_tags where slug = v_slug;
    if found then
        return jsonb_build_object('ok', true, 'tag_id', v_tag.id, 'name', v_tag.name, 'повтор', true);
    end if;

    insert into worship_tags (name, slug, created_by)
    values (btrim(p_name), v_slug, auth.uid())
    returning * into v_tag;

    return jsonb_build_object('ok', true, 'tag_id', v_tag.id, 'name', v_tag.name);
end $$;

-- ── переименование и слияние ─────────────────────────────────────────────────
-- Слияние идемпотентно: объект, у которого стояли оба тега, не ломает операцию.
create or replace function worship_tag_rename(p_tag uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_slug text := worship_tag_slug(p_name);
begin
    if not worship_can_approve() then
        raise exception 'Переименовывать теги может старший пуджари' using errcode = '42501';
    end if;
    if v_slug is null then raise exception 'Пустое название тега'; end if;
    if exists (select 1 from worship_tags where slug = v_slug and id <> p_tag) then
        raise exception 'Такой тег уже есть: слейте их вместо переименования';
    end if;

    update worship_tags set name = btrim(p_name), slug = v_slug where id = p_tag;
    return jsonb_build_object('ok', true);
end $$;

create or replace function worship_tag_merge(p_from uuid, p_into uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_перенесено integer;
begin
    if not worship_can_approve() then
        raise exception 'Сливать теги может старший пуджари' using errcode = '42501';
    end if;
    if p_from = p_into then raise exception 'Это один и тот же тег'; end if;
    if not exists (select 1 from worship_tags where id = p_into) then
        raise exception 'Тег, в который сливаем, не найден';
    end if;

    -- там, где уже стоит целевой тег, связь просто исчезает вместе с исходным
    update worship_tag_links l set tag_id = p_into
     where l.tag_id = p_from
       and not exists (
           select 1 from worship_tag_links e
            where e.tag_id = p_into
              and e.article_id is not distinct from l.article_id
              and e.album_id is not distinct from l.album_id);
    get diagnostics v_перенесено = row_count;

    delete from worship_tags where id = p_from;
    return jsonb_build_object('ok', true, 'перенесено', v_перенесено);
end $$;

do $$
declare f text;
begin
    foreach f in array array['worship_tag_ensure(text)', 'worship_tag_rename(uuid,text)',
                             'worship_tag_merge(uuid,uuid)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
    execute 'revoke all on function worship_tag_slug(text) from public, anon';
end $$;

comment on table worship_tags is
    'Словарь тегов, один на модуль. Ключ (slug) нормализован: по нему ищется совпадение.';
comment on table worship_tag_links is
    'Связь тега с целью: ровно одно из двух полей — статья либо набор снимков.';
