-- Блок 1.7: закладки и недавно открытое.
--
-- Хранятся в базе, а не в браузере: человек читает с телефона у алтаря и
-- с компьютера в офисе, и закладки должны быть теми же. Недавнее лежит здесь же
-- с пометкой вида — списки одинаковые по устройству, разные по смыслу.
create table if not exists worship_bookmarks (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null,
    kind       text not null check (kind in ('bookmark', 'recent')),
    article_id uuid references worship_articles(id) on delete cascade,
    album_id   uuid,                       -- наборы фото появятся на третьем этапе
    created_at timestamptz not null default now(),
    constraint worship_bookmarks_target
        check (num_nonnulls(article_id, album_id) = 1)
);

create unique index if not exists worship_bookmarks_article_once
    on worship_bookmarks (user_id, kind, article_id) where article_id is not null;
create index if not exists worship_bookmarks_user_idx
    on worship_bookmarks (user_id, kind, created_at desc);

alter table worship_bookmarks enable row level security;

-- Свои и только свои: чужие закладки — это чужое чтение.
create policy "worship bookmarks own" on worship_bookmarks for select
    using (user_id = auth.uid());
create policy "worship bookmarks add" on worship_bookmarks for insert
    with check (user_id = auth.uid() and worship_can_view());
create policy "worship bookmarks drop" on worship_bookmarks for delete
    using (user_id = auth.uid());

-- ── отметка «открыл» ──────────────────────────────────────────────────────────
-- Недавнее — это пять-семь строк, а не журнал чтения: лишнее подрезается здесь,
-- иначе таблица растёт на каждое открытие статьи у алтаря.
create or replace function worship_touch_recent(p_article uuid)
returns void
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_me uuid := auth.uid();
begin
    if v_me is null or not worship_can_view() then return; end if;

    insert into worship_bookmarks (user_id, kind, article_id)
    values (v_me, 'recent', p_article)
    on conflict (user_id, kind, article_id) where article_id is not null
    do update set created_at = now();

    delete from worship_bookmarks
     where user_id = v_me and kind = 'recent'
       and id not in (
           select id from worship_bookmarks
            where user_id = v_me and kind = 'recent'
            order by created_at desc limit 7);
end $$;

revoke all on function worship_touch_recent(uuid) from public, anon, authenticated;
grant execute on function worship_touch_recent(uuid) to authenticated;
