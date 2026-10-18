-- Починки по разбору прав этапа 3.
-- Главное: файл снимка из закрытого набора доставался через текст стандарта
-- и через вложение материала — политика бакета смотрела на статью, а не на набор.

-- 1. Ключевые поля после вставки не меняются.
--    Без этого пуджари переносил чужой закрытый снимок в свой открытый набор
--    или перевешивал вложение чужого материала на закрытый путь.
create or replace function worship_lock_columns() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
    к text;
    v_old jsonb := to_jsonb(old);
    v_new jsonb := to_jsonb(new);
begin
    foreach к in array tg_argv loop
        if v_old->>к is distinct from v_new->>к then
            raise exception 'Поле «%» у записи % после сохранения не меняется', к, tg_table_name
                using errcode = '42501';
        end if;
    end loop;
    return new;
end $$;

revoke all on function worship_lock_columns() from public, anon, authenticated;

drop trigger if exists worship_albums_lock on worship_albums;
create trigger worship_albums_lock before update on worship_albums
for each row execute function worship_lock_columns('created_by');

drop trigger if exists worship_images_lock on worship_images;
create trigger worship_images_lock before update on worship_images
for each row execute function worship_lock_columns('created_by', 'album_id', 'storage_path');

drop trigger if exists worship_attachments_lock on worship_attachments;
create trigger worship_attachments_lock before update on worship_attachments
for each row execute function worship_lock_columns('created_by', 'article_id', 'storage_path');

drop trigger if exists worship_kits_lock on worship_kits;
create trigger worship_kits_lock before update on worship_kits
for each row execute function worship_lock_columns('created_by');

drop trigger if exists worship_kit_items_lock on worship_kit_items;
create trigger worship_kit_items_lock before update on worship_kit_items
for each row execute function worship_lock_columns('created_by', 'kit_id', 'album_id', 'article_id');

-- 2. Снимок закрытого (или убранного в архив) набора не отдаётся никаким путём.
--    Закрыли набор позже — доступ пропадает сам, даже если путь остался в тексте.
drop policy if exists "worship files read" on storage.objects;
create policy "worship files read" on storage.objects for select to authenticated
using (
    bucket_id = 'worship' and worship_can_view() and (
        worship_can_write() or (
            not exists (
                select 1 from worship_images i
                  join worship_albums al on al.id = i.album_id
                 where i.storage_path = objects.name
                   and (al.is_private or al.is_archived))
            and (
                -- снимок в тексте утверждённой или прежней редакции
                exists (
                    select 1 from worship_versions v,
                           lateral jsonb_array_elements(coalesce(v.doc->'blocks', '[]'::jsonb)) b
                     where v.status in ('published', 'superseded')
                       and b.value->>'path' = objects.name)
                -- снимок открытого набора
                or exists (
                    select 1 from worship_images i
                      join worship_albums al on al.id = i.album_id
                     where i.storage_path = objects.name
                       and not al.is_private and not al.is_archived)
                -- файл материала библиотеки: архивный тоже открывается,
                -- раз карточка и список вложений у него видны
                or exists (
                    select 1 from worship_attachments t
                      join worship_articles a on a.id = t.article_id
                     where t.storage_path = objects.name
                       and a.status in ('published', 'archived'))
            )
        )
    )
);

-- 3. Путь закрытого снимка не попадает в текст: раньше это проверял только браузер.
create or replace function worship_version_images_open() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_закрытые text[];
begin
    select array_agg(distinct al.title) into v_закрытые
      from jsonb_array_elements(coalesce(new.doc->'blocks', '[]'::jsonb)) b
      join worship_images i on i.storage_path = b.value->>'path'
      join worship_albums al on al.id = i.album_id
     where al.is_private or al.is_archived;

    if v_закрытые is not null then
        raise exception 'В тексте снимок из закрытого набора: %. Откройте набор или уберите снимок',
            array_to_string(v_закрытые, ', ') using errcode = '42501';
    end if;
    return new;
end $$;

revoke all on function worship_version_images_open() from public, anon, authenticated;

drop trigger if exists worship_versions_images_open on worship_versions;
create trigger worship_versions_images_open before insert or update on worship_versions
for each row execute function worship_version_images_open();

-- 4. Закрытый набор нельзя положить в подборку (раньше держала только выдача).
drop policy if exists "worship kit items write" on worship_kit_items;
create policy "worship kit items write" on worship_kit_items for insert
with check (
    worship_can_write() and created_by = auth.uid()
    and (album_id is null or exists (
        select 1 from worship_albums a
         where a.id = album_id and not a.is_private and not a.is_archived))
);

-- мёртвая: проверка переехала в политику
drop function if exists worship_kit_album_allowed(uuid);

-- 5. Пункт подборки с недоступной целью не виден вовсе — иначе читатель
--    получал id закрытого набора и дыру в нумерации дорожки.
drop policy if exists "worship kit items view" on worship_kit_items;
create policy "worship kit items view" on worship_kit_items for select
using (
    exists (select 1 from worship_kits k where k.id = worship_kit_items.kit_id)
    and (
        worship_can_write()
        or (
            (album_id is null or exists (
                select 1 from worship_albums a where a.id = worship_kit_items.album_id))
            and (article_id is null or exists (
                select 1 from worship_articles a where a.id = worship_kit_items.article_id))
        )
    )
);

-- 6. Имя тега не выдаёт закрытую тему: читателю видны только теги,
--    у которых есть хотя бы одна доступная ему связь.
drop policy if exists "worship tags view" on worship_tags;
create policy "worship tags view" on worship_tags for select
using (
    worship_can_view() and (
        worship_can_write()
        or exists (select 1 from worship_tag_links l where l.tag_id = worship_tags.id)
    )
);

-- 7. Ссылка во вложении — только http(s). Проверка была лишь в браузере,
--    а открывается она через window.open.
alter table worship_attachments drop constraint if exists worship_attachments_url_scheme;
alter table worship_attachments add constraint worship_attachments_url_scheme
    check (url is null or url ~* '^https?://');

-- 8. Гигиена прав на функции.
revoke all on function worship_version_search_vector() from public, anon, authenticated;
alter function worship_tag_slug(text) set search_path to 'public', 'pg_temp';
revoke all on function worship_tag_slug(text) from public, anon, authenticated;

-- 9. Записи лекций: бакет принимал только картинки и pdf.
update storage.buckets
   set allowed_mime_types = array[
       'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
       'application/pdf',
       'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-m4a',
       'video/mp4', 'video/quicktime']
 where id = 'worship';
