-- Починки по итогам проверки жизненного цикла.

-- Счётчик отправок: строка черновика переиспользуется на всём круге
-- «отправил → вернули → поправил → отправил», поэтому ключ события, собранный
-- из одного только номера версии, глушил вторую отправку навсегда — правка
-- после замечаний старшего уходила в тишину.
alter table worship_versions add column if not exists submit_no integer not null default 0;

-- ── отправка ─────────────────────────────────────────────────────────────────
create or replace function worship_submit(p_article uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья  worship_articles%rowtype;
    v_version worship_versions%rowtype;
    v_номер   integer;
    v_кому    uuid;
begin
    if not worship_can_write() then
        raise exception 'Отправлять на утверждение может пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status = 'archived' then
        raise exception 'Статья в архиве: сначала верните её из архива';
    end if;

    select * into v_version from worship_versions
     where article_id = p_article and status in ('draft', 'submitted');
    if not found then raise exception 'Отправлять нечего: черновика нет'; end if;

    if v_version.status = 'submitted' then
        return jsonb_build_object('ok', true, 'повтор', true, 'version_id', v_version.id);
    end if;

    -- пустой «стандарт» утверждать нечего: текст — это весь его смысл
    if coalesce(btrim(v_version.plain_text), '') = '' then
        raise exception 'В статье нет текста';
    end if;

    -- правка действующего стандарта без строки «что изменилось» оставляет
    -- пустую историю и пустое сообщение отделу; у первой версии не спрашиваем,
    -- а подставляем «первая редакция» прямо здесь, а не в браузере
    if exists (select 1 from worship_versions
                where article_id = p_article and status in ('published', 'superseded')) then
        if coalesce(btrim(v_version.change_note), '') = '' then
            raise exception 'Напишите одной строкой, что изменилось';
        end if;
    elsif coalesce(btrim(v_version.change_note), '') = '' then
        update worship_versions set change_note = 'первая редакция' where id = v_version.id;
        v_version.change_note := 'первая редакция';
    end if;

    update worship_versions
       set status = 'submitted', updated_at = now(), submit_no = submit_no + 1,
           return_reason = null, returned_at = null, returned_by = null
     where id = v_version.id
    returning submit_no into v_номер;

    update worship_articles set updated_at = now(), updated_by = auth.uid() where id = p_article;

    for v_кому in select worship_holders('worship_approve') loop
        if v_кому <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
            perform worship_event('submitted', p_article, v_version.id, null, v_кому,
                                  'submitted:' || v_version.id || ':' || v_номер || ':' || v_кому,
                                  jsonb_build_object('заголовок', v_version.title,
                                                     'примечание', v_version.change_note));
        end if;
    end loop;

    return jsonb_build_object('ok', true, 'version_id', v_version.id);
end $$;

-- ── отзыв: гасим неотправленное «ждёт вашего решения» ────────────────────────
create or replace function worship_withdraw(p_article uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_version worship_versions%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Отзывать правку может пуджари' using errcode = '42501';
    end if;

    perform 1 from worship_articles where id = p_article for update;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';
    if not found then
        return jsonb_build_object('ok', true, 'повтор', true);
    end if;

    update worship_versions set status = 'draft', updated_at = now() where id = v_version.id;

    -- письмо о том, чего больше нет на столе, только сбивает
    delete from worship_notifications
     where kind = 'submitted' and version_id = v_version.id and sent_at is null;

    update worship_articles set updated_at = now(), updated_by = auth.uid() where id = p_article;
    return jsonb_build_object('ok', true);
end $$;

-- ── возврат автору ───────────────────────────────────────────────────────────
create or replace function worship_return(p_article uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_version worship_versions%rowtype;
    v_когда   timestamptz := clock_timestamp();
begin
    if not worship_can_approve() then
        raise exception 'Возвращать правки может старший пуджари' using errcode = '42501';
    end if;
    if coalesce(btrim(p_reason), '') = '' then
        raise exception 'Без причины возврат бессмыслен: автор не поймёт, что поправить';
    end if;

    perform 1 from worship_articles where id = p_article for update;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';
    if not found then raise exception 'На утверждении ничего нет'; end if;

    update worship_versions
       set status = 'draft', updated_at = now(),
           return_reason = btrim(p_reason), returned_at = v_когда, returned_by = auth.uid()
     where id = v_version.id;

    delete from worship_notifications
     where kind = 'submitted' and version_id = v_version.id and sent_at is null;

    update worship_articles set updated_at = now(), updated_by = auth.uid() where id = p_article;

    -- ключ от номера попытки, а не от секунды: два возврата подряд — две причины
    if v_version.created_by is not null and v_version.created_by <> auth.uid() then
        perform worship_event('returned', p_article, v_version.id, null, v_version.created_by,
                              'returned:' || v_version.id || ':' || v_version.submit_no,
                              jsonb_build_object('заголовок', v_version.title,
                                                 'причина', btrim(p_reason)));
    end if;

    return jsonb_build_object('ok', true);
end $$;

-- ── утверждение ──────────────────────────────────────────────────────────────
create or replace function worship_approve(p_article uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья  worship_articles%rowtype;
    v_version worship_versions%rowtype;
    v_номер   integer;
begin
    if not worship_can_approve() then
        raise exception 'Утверждать стандарты может старший пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status = 'archived' then
        raise exception 'Статья в архиве: сначала верните её из архива';
    end if;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';

    if not found then
        -- «правку отозвали, пока вы читали» и «вы нажали дважды» — разные вещи,
        -- и старший должен их различать: в первом случае в храме прежний текст
        if exists (select 1 from worship_versions
                    where article_id = p_article and status = 'draft') then
            return jsonb_build_object('ok', false, 'отозвана', true,
                                      'сообщение', 'Правку отозвали: утверждать нечего');
        end if;
        select * into v_version from worship_versions
         where article_id = p_article and status = 'published';
        if found then
            return jsonb_build_object('ok', true, 'повтор', true,
                                      'version_id', v_version.id, 'номер', v_version.version_no);
        end if;
        raise exception 'На утверждении ничего нет';
    end if;

    select coalesce(max(version_no), 0) + 1 into v_номер
      from worship_versions where article_id = p_article;

    update worship_versions set status = 'superseded'
     where article_id = p_article and status = 'published';

    update worship_versions
       set status = 'published', version_no = v_номер,
           approved_at = now(), approved_by = auth.uid(), updated_at = now(),
           return_reason = null, returned_at = null, returned_by = null
     where id = v_version.id;

    update worship_articles
       set status = 'published', current_version_id = v_version.id, title = v_version.title,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    delete from worship_notifications
     where kind = 'submitted' and version_id = v_version.id and sent_at is null;

    perform worship_event('approved', p_article, v_version.id, null, null,
                          'approved:' || v_version.id,
                          jsonb_build_object('заголовок', v_version.title,
                                             'номер', v_номер,
                                             'примечание', v_version.change_note));

    return jsonb_build_object('ok', true, 'version_id', v_version.id, 'номер', v_номер);
end $$;

-- ── возврат прежней версии ───────────────────────────────────────────────────
create or replace function worship_restore_version(p_version uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_исходник worship_versions%rowtype;
    v_статья   worship_articles%rowtype;
    v_черновик worship_versions%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Вернуть прежнюю версию может пуджари' using errcode = '42501';
    end if;

    select * into v_исходник from worship_versions where id = p_version;
    if not found then raise exception 'Версия не найдена'; end if;
    if v_исходник.status in ('draft', 'submitted') then raise exception 'Это и есть черновик'; end if;

    select * into v_статья from worship_articles where id = v_исходник.article_id for update;
    -- иначе черновик повисал бы на архивной статье: сохранить его нельзя,
    -- удалить нельзя, и единственный слот незавершённого текста занят навсегда
    if v_статья.status = 'archived' then
        raise exception 'Статья в архиве: сначала верните её из архива';
    end if;

    select * into v_черновик from worship_versions
     where article_id = v_исходник.article_id and status in ('draft', 'submitted');
    if found and v_черновик.status = 'submitted' then
        raise exception 'Правка уже отправлена на утверждение: отзовите её';
    end if;

    if found then
        update worship_versions
           set title = v_исходник.title, doc = v_исходник.doc, plain_text = v_исходник.plain_text,
               change_note = format('возврат к версии %s', v_исходник.version_no), updated_at = now()
         where id = v_черновик.id
        returning * into v_черновик;
    else
        insert into worship_versions (article_id, status, title, doc, plain_text, change_note, created_by)
        values (v_исходник.article_id, 'draft', v_исходник.title, v_исходник.doc, v_исходник.plain_text,
                format('возврат к версии %s', v_исходник.version_no), auth.uid())
        returning * into v_черновик;
    end if;

    return jsonb_build_object('ok', true, 'version_id', v_черновик.id);
end $$;

-- ── архивация: чем заменено — действующий стандарт, а не что попало ──────────
create or replace function worship_archive(p_article uuid, p_reason text, p_replaced_by uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_статья worship_articles%rowtype;
begin
    if not worship_can_approve() then
        raise exception 'Архивировать может старший пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status = 'archived' then
        return jsonb_build_object('ok', true, 'повтор', true);
    end if;
    if v_статья.status <> 'published' then
        raise exception 'В архив уходит действующий стандарт, а этот ещё не утверждался';
    end if;
    if p_replaced_by is not null then
        if p_replaced_by = p_article then
            raise exception 'Статья не может заменять саму себя';
        end if;
        if not exists (select 1 from worship_articles
                        where id = p_replaced_by and status = 'published' and kind = v_статья.kind) then
            raise exception 'Заменить можно только действующим стандартом';
        end if;
    end if;

    update worship_articles
       set status = 'archived', archived_at = now(), archived_by = auth.uid(),
           archive_reason = nullif(btrim(p_reason), ''), replaced_by_id = p_replaced_by,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    return jsonb_build_object('ok', true);
end $$;

-- ── порядок: считаем только то, что видно в списке ───────────────────────────
create or replace function worship_reorder(p_article uuid, p_direction integer)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья worship_articles%rowtype;
    v_мой    integer;
    v_сосед  uuid;
begin
    if not worship_can_write() then
        raise exception 'Менять порядок статей может пуджари' using errcode = '42501';
    end if;
    if p_direction not in (-1, 1) then
        raise exception 'Двигать можно на одну позицию вверх или вниз';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status = 'archived' then
        raise exception 'Отменённые стандарты в списке не переставляют';
    end if;

    -- архивные в списке не показываются, и если считать их вместе со всеми,
    -- соседом оказывается невидимая строка, а кнопка «вверх» молча не работает.
    -- Блокируем весь раздел, чтобы две одновременные перестановки не потерялись.
    perform 1 from worship_articles
     where kind = v_статья.kind
       and section_id is not distinct from v_статья.section_id
       and status <> 'archived'
     order by id
     for update;

    with упорядоченные as (
        select id, (row_number() over (order by sort_order, title, id) - 1)::int as n
          from worship_articles
         where kind = v_статья.kind
           and section_id is not distinct from v_статья.section_id
           and status <> 'archived'
    )
    update worship_articles a
       set sort_order = у.n
      from упорядоченные у
     where a.id = у.id and a.sort_order is distinct from у.n;

    select sort_order into v_мой from worship_articles where id = p_article;

    select id into v_сосед
      from worship_articles
     where kind = v_статья.kind
       and section_id is not distinct from v_статья.section_id
       and status <> 'archived'
       and sort_order = v_мой + p_direction
     limit 1;

    if v_сосед is null then return jsonb_build_object('ok', true, 'край', true); end if;

    update worship_articles set sort_order = v_мой, updated_at = now() where id = v_сосед;
    update worship_articles set sort_order = v_мой + p_direction, updated_at = now() where id = p_article;

    return jsonb_build_object('ok', true, 'позиция', v_мой + p_direction);
end $$;

-- ── замечание: только к тому, что человек видит ──────────────────────────────
create or replace function worship_remark_add(p_article uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_remark uuid;
    v_статья worship_articles%rowtype;
    v_автор  uuid;
    v_кому   uuid;
begin
    if not worship_can_view() then
        raise exception 'Нет доступа к модулю' using errcode = '42501';
    end if;
    if coalesce(btrim(p_body), '') = '' then
        raise exception 'Пустое замечание ни о чём не говорит';
    end if;

    select * into v_статья from worship_articles where id = p_article;
    if not found then raise exception 'Статья не найдена'; end if;
    -- функция читает в обход правил доступа, поэтому видимость проверяем сами:
    -- иначе по известному номеру можно подвесить замечание к чужому черновику
    -- и узнать его заголовок из события
    if v_статья.status not in ('published', 'archived') and not worship_can_write() then
        raise exception 'Статья не найдена';
    end if;

    insert into worship_remarks (article_id, body, created_by)
    values (p_article, btrim(p_body), auth.uid())
    returning id into v_remark;

    select created_by into v_автор from worship_versions
     where article_id = p_article order by coalesce(approved_at, updated_at) desc limit 1;

    for v_кому in
        select distinct x from (
            select v_автор as x
            union select worship_holders('worship_approve')
        ) s where x is not null and x <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
    loop
        perform worship_event('remark', p_article, null, v_remark, v_кому,
                              'remark:' || v_remark || ':' || v_кому,
                              jsonb_build_object('заголовок', v_статья.title,
                                                 'текст', btrim(p_body)));
    end loop;

    return jsonb_build_object('ok', true, 'remark_id', v_remark);
end $$;

do $$
declare f text;
begin
    foreach f in array array[
        'worship_submit(uuid)', 'worship_withdraw(uuid)', 'worship_approve(uuid)',
        'worship_return(uuid,text)', 'worship_restore_version(uuid)',
        'worship_archive(uuid,text,uuid)', 'worship_reorder(uuid,integer)',
        'worship_remark_add(uuid,text)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
