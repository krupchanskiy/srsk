-- 292: снимки галереи в «Избранном» (просьба Адриана 25.10.2026).
-- Звёздочка в просмотре снимка; на странице «Избранное» — раздел «Снимки».
-- Удалили снимок — пропадает и из избранного (каскад).

alter table worship_bookmarks
    add column if not exists image_id uuid references worship_images(id) on delete cascade;

alter table worship_bookmarks drop constraint worship_bookmarks_target;
alter table worship_bookmarks add constraint worship_bookmarks_target
    check (num_nonnulls(article_id, album_id, image_id) = 1);

-- снимок в избранном один раз; «недавнее» для снимков не ведём
create unique index if not exists worship_bookmarks_image_once
    on worship_bookmarks (user_id, kind, image_id) where image_id is not null;
create index if not exists worship_bookmarks_image_idx on worship_bookmarks (image_id);
