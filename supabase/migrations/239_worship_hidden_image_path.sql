-- Ловушка: условие «путь не принадлежит закрытому снимку», написанное прямо
-- в политике, проверяется с правами читателя. Строку закрытого снимка он не
-- видит — значит «не принадлежит» всегда истинно, и файл открывался.
-- Смотреть на скрытые строки должна функция, которая видит всё.
create or replace function worship_image_is_hidden(p_path text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select exists (
        select 1 from worship_images i
          join worship_albums al on al.id = i.album_id
         where i.storage_path = p_path
           and (al.is_private or al.is_archived))
$$;

revoke all on function worship_image_is_hidden(text) from public, anon, authenticated;

drop policy if exists "worship files read" on storage.objects;
create policy "worship files read" on storage.objects for select to authenticated
using (
    bucket_id = 'worship' and worship_can_view() and (
        worship_can_write() or (
            not worship_image_is_hidden(objects.name)
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
