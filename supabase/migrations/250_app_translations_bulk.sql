-- Переводы грузились пятью запросами подряд: PostgREST отдаёт не больше
-- тысячи строк, а их 4600, и клиент ходил страницами, каждый раз ожидая
-- предыдущий ответ. До первой отрисовки — пять поездок до Мумбаи.
-- Отдаём всё одним объектом: ключ → три языка.
create or replace function app_translations()
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select coalesce(jsonb_object_agg(key, jsonb_build_array(ru, en, hi)), '{}'::jsonb)
      from translations
$$;

-- переводы нужны и тому, кто ещё не вошёл: на странице входа тоже есть подписи
revoke all on function app_translations() from public;
grant execute on function app_translations() to anon, authenticated;
