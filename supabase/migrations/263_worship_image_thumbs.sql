-- Миниатюры снимков для плиток галереи (решение Адриана 19.10.2026).
--
-- В плитку 160 px грузился снимок 1500 px: папка в сорок кадров весила
-- 10–15 МБ. Теперь рядом с оригиналом лежит копия ~480 px (thumb_path),
-- плитки показывают её, а оригинал открывается при просмотре.
-- Для старых снимков миниатюру дописывает страница папки, когда её
-- открывает пуджари, — функцией worship_image_set_thumb.

alter table public.worship_images add column if not exists thumb_path text;
-- в колонке может стоять только миниатюра: иначе через неё можно было бы
-- открыть читателям любой файл бакета, вписав его путь
alter table public.worship_images drop constraint if exists worship_images_thumb_suffix;
alter table public.worship_images add constraint worship_images_thumb_suffix
    check (thumb_path is null or thumb_path like '%.thumb.jpg');
comment on column public.worship_images.thumb_path is
    'уменьшенная копия (~480 px) для плиток; null — пока нет, показывается оригинал';

-- закрытость папки распространяется и на миниатюру
create or replace function public.worship_image_is_hidden(p_path text)
returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' set timezone to 'Asia/Kolkata'
as $function$
    select exists (
        select 1 from worship_images i
          join worship_albums al on al.id = i.album_id
         where p_path in (i.storage_path, i.thumb_path)
           and (al.is_private or al.is_archived))
$function$;

-- чтение файла: миниатюра открыта тем же, кому открыт её снимок
alter policy "worship files read" on storage.objects using (
    bucket_id = 'worship'
    and (select worship_can_view())
    and ((select worship_can_write())
         or (not worship_image_is_hidden(name)
             and (exists (select 1
                            from worship_versions v,
                                 lateral jsonb_array_elements(coalesce(v.doc -> 'blocks', '[]'::jsonb)) b(value)
                           where v.status in ('published', 'superseded')
                             and b.value ->> 'path' = objects.name)
                  or exists (select 1
                               from worship_images i
                               join worship_albums al on al.id = i.album_id
                              where objects.name in (i.storage_path, i.thumb_path)
                                and not al.is_private and not al.is_archived)
                  or exists (select 1
                               from worship_attachments t
                               join worship_articles a on a.id = t.article_id
                              where t.storage_path = objects.name
                                and a.status in ('published', 'archived'))))));

-- удаление снимка отдаёт и путь миниатюры: страница уберёт оба файла
create or replace function public.worship_image_delete(p_image uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp' set timezone to 'Asia/Kolkata'
as $function$
declare v_путь text; v_мини text;
begin
    if not worship_can_write() then
        raise exception 'Убирать снимки может пуджари' using errcode = '42501';
    end if;

    select storage_path, thumb_path into v_путь, v_мини from worship_images where id = p_image;
    if v_путь is null then raise exception 'Снимок не найден'; end if;

    delete from worship_images where id = p_image;
    return jsonb_build_object('ok', true, 'путь', v_путь, 'миниатюра', v_мини);
end $function$;

-- записать миниатюру старого снимка; файл кладёт сам пуджари в свою папку
create or replace function public.worship_image_set_thumb(p_image uuid, p_path text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp' set timezone to 'Asia/Kolkata'
as $function$
begin
    if not worship_can_write() then
        raise exception 'Миниатюры пишет пуджари' using errcode = '42501';
    end if;
    -- только свой файл из своей папки: чужой путь сюда не подставить
    if p_path is null or p_path not like auth.uid()::text || '/%.thumb.jpg' then
        raise exception 'Неверный путь миниатюры';
    end if;
    update worship_images set thumb_path = p_path
     where id = p_image and thumb_path is null;
    return jsonb_build_object('ok', true, 'записано', found);
end $function$;

revoke all on function public.worship_image_set_thumb(uuid, text) from public, anon;
grant execute on function public.worship_image_set_thumb(uuid, text) to authenticated;
