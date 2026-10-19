-- 276: библиотека и галерея — добавлять могут все, кто видит модуль,
-- удалять — только старший пуджари и суперпользователи (решение Адриана
-- 19.10.2026).
--
-- «Участник» — любой с worship_view. Он создаёт материал и правит свой,
-- прикладывает файлы и ссылки к материалам, грузит снимки в папки.
-- Заводит папки галереи — только старший (worship_approve).
-- Стандарты, чужие материалы, правка папок, подписи и порядок снимков,
-- теги — по-прежнему пуджари (worship_write).
-- Убрать вложение, снимок или файл из хранилища — только worship_approve.

create or replace function worship_can_contribute()
returns boolean language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$ select worship_can_view() $$;
revoke all on function worship_can_contribute() from public, anon;
grant execute on function worship_can_contribute() to authenticated;

-- ---- материалы: создать может участник, править — свой ----
do $$
declare
    d text := pg_get_functiondef('worship_save_draft'::regproc);
    было text := E'    if not worship_can_write() then\n        raise exception ''Писать стандарты может пуджари'' using errcode = ''42501'';\n    end if;\n';
    стало text := E'    -- материал библиотеки добавляет любой, кто видит модуль, и правит свой;\n'
        || E'    -- стандарты и чужие материалы — пуджари (миграция 276)\n'
        || E'    if not worship_can_write() then\n'
        || E'        if not worship_can_contribute() then\n'
        || E'            raise exception ''Добавлять в библиотеку может тот, кто видит модуль'' using errcode = ''42501'';\n'
        || E'        end if;\n'
        || E'        if v_article is null and v_kind <> ''material'' then\n'
        || E'            raise exception ''Писать стандарты может пуджари'' using errcode = ''42501'';\n'
        || E'        end if;\n'
        || E'        if v_article is not null and not exists (select 1 from worship_articles\n'
        || E'                where id = v_article and kind = ''material'' and created_by = auth.uid()) then\n'
        || E'            raise exception ''Чужой материал правит пуджари; приложить к нему файл может каждый'' using errcode = ''42501'';\n'
        || E'        end if;\n'
        || E'    end if;\n';
begin
    if position(было in d) = 0 then raise exception 'worship_save_draft: проверка не найдена'; end if;
    execute replace(d, было, стало);
end $$;

-- ---- вложения материалов ----
drop policy if exists "worship attachments write" on worship_attachments;
create policy "worship attachments write" on worship_attachments for insert to authenticated
with check (
    created_by = (select auth.uid())
    and ((select worship_can_write())
         or ((select worship_can_contribute())
             and exists (select 1 from worship_articles a
                          where a.id = worship_attachments.article_id and a.kind = 'material')))
);
drop policy if exists "worship attachments delete" on worship_attachments;
create policy "worship attachments delete" on worship_attachments for delete to authenticated
using ((select worship_can_approve()));

-- ---- папки: заводит только старший, снимки в них грузят все ----
drop policy if exists "worship albums insert" on worship_albums;
create policy "worship albums insert" on worship_albums for insert to authenticated
with check ((select worship_can_approve()) and created_by = (select auth.uid()));

-- ---- снимки ----
drop policy if exists "worship images insert" on worship_images;
create policy "worship images insert" on worship_images for insert to authenticated
with check (
    (select worship_can_contribute()) and created_by = (select auth.uid())
    and exists (select 1 from worship_albums a where a.id = worship_images.album_id and not a.is_archived)
);
drop policy if exists "worship images delete" on worship_images;
create policy "worship images delete" on worship_images for delete to authenticated
using ((select worship_can_approve()));

do $$
declare d text; было text;
begin
    d := pg_get_functiondef('worship_image_delete(uuid)'::regprocedure);
    было := E'    if not worship_can_write() then\n        raise exception ''Убирать снимки может пуджари'' using errcode = ''42501'';\n    end if;\n';
    if position(было in d) = 0 then raise exception 'worship_image_delete: проверка не найдена'; end if;
    execute replace(d, было,
        E'    if not worship_can_approve() then\n'
        || E'        raise exception ''Убирать снимки может старший пуджари'' using errcode = ''42501'';\n'
        || E'    end if;\n');

    d := pg_get_functiondef('worship_image_set_thumb(uuid,text)'::regprocedure);
    было := E'    if not worship_can_write() then\n        raise exception ''Миниатюры пишет пуджари'' using errcode = ''42501'';\n    end if;\n';
    if position(было in d) = 0 then raise exception 'worship_image_set_thumb: проверка не найдена'; end if;
    execute replace(d, было,
        E'    if not worship_can_contribute() then\n'
        || E'        raise exception ''Миниатюры пишет тот, кто видит модуль'' using errcode = ''42501'';\n'
        || E'    end if;\n');
end $$;

-- ---- файлы в хранилище ----
drop policy if exists "worship files upload" on storage.objects;
create policy "worship files upload" on storage.objects for insert to authenticated
with check (bucket_id = 'worship' and worship_can_contribute()
            and (storage.foldername(name))[1] = (auth.uid())::text);
drop policy if exists "worship files update" on storage.objects;
create policy "worship files update" on storage.objects for update to authenticated
using (bucket_id = 'worship' and worship_can_contribute()
       and (storage.foldername(name))[1] = (auth.uid())::text);
drop policy if exists "worship files delete" on storage.objects;
create policy "worship files delete" on storage.objects for delete to authenticated
using (bucket_id = 'worship' and worship_can_approve());
