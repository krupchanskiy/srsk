-- Скорость RLS и внешних ключей модуля «Поклонение» (советник Supabase).
--
-- 1. Политики вызывали auth.uid() и worship_can_*() на КАЖДУЮ строку:
--    worship_can_view() — это ещё и поиск по правам пользователя. Обёртка
--    (select …) превращает вызов в однократный для всего запроса (initplan).
--    Смысл политик не меняется — только когда считается проверка.
--    Переписываем по живому определению, а не копией текста: так миграция
--    не откатит ничего, что поменялось в политиках после её написания.
do $$
declare
    п record;
    условие text;
    проверка text;
begin
    for п in
        select policyname, tablename, qual, with_check
          from pg_policies
         where schemaname = 'public' and tablename like 'worship\_%'
           and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(auth\.uid\(\)|worship_can_[a-z]+\(\))'
           and (coalesce(qual, '') || coalesce(with_check, '')) !~* 'select auth\.uid'
    loop
        условие := regexp_replace(regexp_replace(п.qual,
            'auth\.uid\(\)', '(select auth.uid())', 'g'),
            '(worship_can_[a-z]+)\(\)', '(select \1())', 'g');
        проверка := regexp_replace(regexp_replace(п.with_check,
            'auth\.uid\(\)', '(select auth.uid())', 'g'),
            '(worship_can_[a-z]+)\(\)', '(select \1())', 'g');
        execute format('alter policy %I on public.%I%s%s', п.policyname, п.tablename,
            case when условие is not null then ' using (' || условие || ')' else '' end,
            case when проверка is not null then ' with check (' || проверка || ')' else '' end);
    end loop;
end $$;

-- 2. Индексы под внешние ключи: без них удаление статьи, службы или папки
--    просматривает связанные таблицы целиком, а выборки «назначения службы»
--    и «пункты подборки со статьёй» идут перебором.
create index if not exists worship_albums_article_idx          on worship_albums (article_id);
create index if not exists worship_albums_cover_idx            on worship_albums (cover_image_id);
create index if not exists worship_articles_current_version_idx on worship_articles (current_version_id);
create index if not exists worship_articles_replaced_by_idx    on worship_articles (replaced_by_id);
create index if not exists worship_articles_source_version_idx on worship_articles (source_version_id);
create index if not exists worship_articles_translation_of_idx on worship_articles (translation_of);
create index if not exists worship_bookmarks_article_idx       on worship_bookmarks (article_id);
create index if not exists worship_day_overrides_service_idx   on worship_day_overrides (service_id);
create index if not exists worship_duties_override_idx         on worship_duties (override_id);
create index if not exists worship_duties_service_idx          on worship_duties (service_id);
create index if not exists worship_kit_items_album_idx         on worship_kit_items (album_id);
create index if not exists worship_kit_items_article_idx       on worship_kit_items (article_id);
create index if not exists worship_notifications_article_idx   on worship_notifications (article_id);
create index if not exists worship_notifications_remark_idx    on worship_notifications (remark_id);
create index if not exists worship_notifications_version_idx   on worship_notifications (version_id);
create index if not exists worship_person_services_service_idx on worship_person_services (service_id);
create index if not exists worship_services_article_idx        on worship_services (article_id);
