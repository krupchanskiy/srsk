-- 704: «Кто видит департамент» — список людей у департамента (ВГ 18.10).
-- Глава (fin_departments.responsible_person_id) входит сам, список — дополнительные люди.
-- Каждый из списка видит всё, что глава. Членство (и главенство) в департаменте
-- «для людей» само даёт fin_dept_viewer — и в get_user_permissions, и в fin_is_dept_viewer.
-- fin_account_user (доступ к ДДС) по-прежнему только главам — ДДС в этом шаге не трогаем.
-- Правит список только fin_admin — через fin_save_department (ключ viewer_ids).

create table if not exists fin_department_viewers (
  department_id uuid not null references fin_departments(id) on delete cascade,
  vaishnava_id  uuid not null references vaishnavas(id) on delete cascade,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  primary key (department_id, vaishnava_id)
);
alter table fin_department_viewers enable row level security;
drop policy if exists fin_department_viewers_select on fin_department_viewers;
create policy fin_department_viewers_select on fin_department_viewers
  for select to authenticated using (fin_can_read_all());
revoke insert, update, delete on fin_department_viewers from anon, authenticated;

-- департаменты пользователя: где он глава или в списке
create or replace function fin_user_department_ids(p_user uuid default auth.uid())
returns setof uuid
language sql stable security definer set search_path to 'public'
as $$
  select d.id from fin_departments d
    join vaishnavas v on v.id = d.responsible_person_id
   where p_user is not null and v.user_id = p_user
  union
  select dv.department_id from fin_department_viewers dv
    join vaishnavas v on v.id = dv.vaishnava_id
   where p_user is not null and v.user_id = p_user
$$;
revoke execute on function fin_user_department_ids(uuid) from public, anon;

-- fin_dept_viewer: явное право ИЛИ участие в департаменте «для людей» (явный запрет сильнее)
create or replace function fin_is_dept_viewer(p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_user is not null and (
    fin_private_has_permission(p_user, 'fin_dept_viewer')
    or (exists (select 1 from fin_user_department_ids(p_user) x
                  join fin_departments d on d.id = x where d.for_people)
        and not exists (select 1 from user_permissions up
                          join permissions p on p.id = up.permission_id
                         where up.user_id = p_user and p.code = 'fin_dept_viewer'
                           and up.is_granted = false))
  )
$$;

create or replace function fin_is_kitchen_head(p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_user is not null and exists (
    select 1 from fin_user_department_ids(p_user) x
      join fin_departments d on d.id = x
     where d.code = 'kitchen')
$$;

create or replace function public.get_user_permissions(p_user_id uuid)
 returns table(permission_code text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
    IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN RETURN; END IF;
    RETURN QUERY
        SELECT DISTINCT p.code::text FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = p_user_id AND ur.is_active = true
        UNION
        SELECT p.code::text FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = p_user_id AND up.is_granted = true
        UNION
        SELECT 'fin_account_user'::text
        WHERE EXISTS (
          SELECT 1 FROM vaishnavas v
          WHERE v.user_id = p_user_id
            AND (EXISTS (SELECT 1 FROM fin_departments d WHERE d.responsible_person_id = v.id)
              OR EXISTS (SELECT 1 FROM fin_accounts a WHERE a.responsible_person_id = v.id AND a.is_active))
        )
        UNION
        -- глава и люди из списка «Кто видит департамент» (мигр. 704)
        SELECT 'fin_dept_viewer'::text
        WHERE EXISTS (SELECT 1 FROM fin_user_department_ids(p_user_id) x
                        JOIN fin_departments d ON d.id = x WHERE d.for_people)
        EXCEPT
        SELECT p.code::text FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = p_user_id AND up.is_granted = false;
END;
$function$;

create or replace function public.fin_can_see_account(p_account_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM fin_accounts a
    WHERE a.id = p_account_id
      AND (
        (NOT a.is_restricted AND fin_can_read_all(auth.uid()))
        OR EXISTS (SELECT 1 FROM fin_account_access aa
                   WHERE aa.account_id = a.id AND aa.user_id = auth.uid())
        -- ответственный за сам счёт
        OR EXISTS (SELECT 1 FROM vaishnavas v
                    WHERE v.user_id = auth.uid() AND v.id = a.responsible_person_id)
        -- глава или человек из списка департамента, которому счёт принадлежит
        OR a.department_id IN (SELECT fin_user_department_ids(auth.uid()))
      )
  );
$function$;

-- принимает code, название или id департамента
create or replace function public.fin_department_accounts(p_department text)
 returns table(account_id uuid, name text, currency_code text, is_active boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_dept fin_departments%rowtype;
begin
  select * into v_dept from fin_departments d
   where d.code = p_department or d.name = p_department or d.id::text = p_department
   limit 1;
  if not found then return; end if;

  if not fin_can_read_all() and v_dept.id not in (select fin_user_department_ids()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  return query
    select a.id, a.name, a.currency_code, a.is_active
      from fin_accounts a
     where a.department_id = v_dept.id
     order by a.is_active desc, a.name;
end;
$function$;

-- плитки раздела «Департаменты»: финансистам все, остальным — свои (только «для людей»)
create or replace function fin_my_departments()
returns table(id uuid, name text, code text, color text, head_name text, accounts int)
language sql stable security definer set search_path to 'public'
as $$
  select d.id, d.name, d.code, d.color,
         coalesce(nullif(v.spiritual_name, ''), btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))),
         (select count(*)::int from fin_accounts a where a.department_id = d.id)
    from fin_departments d
    left join vaishnavas v on v.id = d.responsible_person_id
   where d.for_people
     and auth.uid() is not null
     and (fin_can_read_all() or d.id in (select fin_user_department_ids()))
   order by d.name
$$;
revoke execute on function fin_my_departments() from public, anon;
grant execute on function fin_my_departments() to authenticated;

create or replace function public.fin_get_department_report(p_from date, p_to date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_departments jsonb;
  v_scope uuid[];
begin
  if fin_can_read_all() then
    v_scope := null;
  elsif fin_is_dept_viewer() then
    -- глава и люди из списка «Кто видит департамент» (мигр. 704)
    select coalesce(array_agg(x), '{}') into v_scope from fin_user_department_ids() x;
  else
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  with движения as (
    select a.department_id,
           o.type,
           p.direction,
           p.category_id,
           c.name as category_name,
           p.amount_base
      from fin_postings p
      join fin_accounts a on a.id = p.account_id
      join fin_operations o on o.id = p.operation_id
      left join fin_categories c on c.id = p.category_id
     where a.department_id is not null
       and o.type <> 'opening'
       and o.occurred_on between p_from and p_to
  ),
  итоги as (
    select department_id,
           coalesce(sum(amount_base) filter (where type = 'transfer' and direction = 'in'), 0) as received,
           coalesce(sum(amount_base) filter (where type = 'transfer' and direction = 'out'), 0) as passed_on,
           coalesce(sum(case when direction = 'out' then amount_base else -amount_base end)
                    filter (where category_id is not null), 0) as spent
      from движения group by department_id
  ),
  по_статьям as (
    select department_id, category_name,
           sum(case when direction = 'out' then amount_base else -amount_base end) as total
      from движения
     where category_id is not null
     group by department_id, category_name
    having sum(case when direction = 'out' then amount_base else -amount_base end) <> 0
  ),
  остатки as (
    select a.department_id,
           sum(case when p.direction = 'in' then p.amount_base else -p.amount_base end) as balance_end
      from fin_postings p
      join fin_accounts a on a.id = p.account_id
      join fin_operations o on o.id = p.operation_id
     where a.department_id is not null and o.occurred_on <= p_to
     group by a.department_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'department_id', d.id,
           'name', d.name,
           'received', coalesce(i.received, 0),
           'spent', coalesce(i.spent, 0),
           'passed_on', coalesce(i.passed_on, 0),
           'balance_end', coalesce(b.balance_end, 0),
           'by_category', coalesce(
             (select jsonb_agg(jsonb_build_object('name', k.category_name, 'total', k.total)
                               order by k.total desc)
                from по_статьям k where k.department_id = d.id), '[]'::jsonb)
         ) order by coalesce(i.spent, 0) desc, d.name), '[]'::jsonb)
    into v_departments
    from fin_departments d
    left join итоги i on i.department_id = d.id
    left join остатки b on b.department_id = d.id
   where v_scope is null or d.id = any (v_scope);

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'from', p_from, 'to', p_to,
    'departments', v_departments
  ));
end;
$function$;

-- fin_save_department: + viewer_ids — список «Кто ещё видит департамент» (заменяется целиком)
CREATE OR REPLACE FUNCTION public.fin_save_department(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_name text;
  v_resp uuid;
  v_resp_given boolean;
  v_chat bigint;
  v_chat_given boolean;
  v_cats_given boolean;
  v_viewers_given boolean;
  v_bad int;
  v_old_name text;
  v_detail text;
  v_color text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload,
    ARRAY['id', 'name', 'responsible_person_id', 'chat_id', 'category_ids', 'color', 'for_people', 'viewer_ids']);

  v_name := NULLIF(btrim(COALESCE(payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Название департамента обязательно';
  END IF;

  v_color := NULLIF(btrim(COALESCE(payload->>'color', '')), '');
  IF v_color IS NOT NULL AND v_color !~ '^#[0-9a-fA-F]{6}$' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Цвет — в виде #RRGGBB';
  END IF;

  v_id   := fin_private_get_uuid(payload, 'id');
  v_resp_given := payload ? 'responsible_person_id';
  v_resp := fin_private_get_uuid(payload, 'responsible_person_id');
  v_chat_given := payload ? 'chat_id';
  v_chat := NULLIF(payload->>'chat_id', '')::bigint;
  v_cats_given := payload ? 'category_ids';
  v_viewers_given := payload ? 'viewer_ids';

  IF v_resp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_resp) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ответственный не найден в справочнике людей';
  END IF;

  IF EXISTS (SELECT 1 FROM fin_departments
              WHERE lower(name) = lower(v_name) AND (v_id IS NULL OR id <> v_id)) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Департамент «%s» уже есть', v_name);
  END IF;

  IF v_chat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tg_known_chats WHERE chat_id = v_chat) THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Такого чата бот ещё не видел — добавьте бота в чат, он появится в списке';
  END IF;

  -- В наборе департамента могут быть только действующие расходные статьи:
  -- иначе бот предложил бы приходную статью или архивную.
  IF v_cats_given AND jsonb_typeof(payload->'category_ids') = 'array' THEN
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements_text(payload->'category_ids') x
     WHERE NOT EXISTS (SELECT 1 FROM fin_categories c
                        WHERE c.id = NULLIF(x, '')::uuid
                          AND c.is_active AND c.direction = 'out');
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'В наборе есть статья, которая не является действующей статьёй расхода';
    END IF;
  END IF;

  IF v_viewers_given AND jsonb_typeof(payload->'viewer_ids') = 'array' THEN
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements_text(payload->'viewer_ids') x
     WHERE NULLIF(x, '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM vaishnavas v WHERE v.id = NULLIF(x, '')::uuid);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'В списке «Кто видит» есть человек не из справочника';
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO fin_departments (name, responsible_person_id, color, for_people)
    VALUES (v_name, v_resp, v_color, COALESCE((payload->>'for_people')::boolean, true))
    RETURNING id INTO v_id;
  ELSE
    SELECT name INTO v_old_name FROM fin_departments WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Департамент не найден';
    END IF;

    UPDATE fin_departments
       SET name = v_name,
           responsible_person_id = CASE WHEN v_resp_given THEN v_resp ELSE responsible_person_id END,
           color = CASE WHEN payload ? 'color' THEN v_color ELSE color END,
           for_people = CASE WHEN payload ? 'for_people' THEN (payload->>'for_people')::boolean ELSE for_people END
     WHERE id = v_id;

    IF v_old_name IS DISTINCT FROM v_name THEN
      UPDATE fin_accounts
         SET name = v_name || ' (' || CASE currency_code
                       WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                       WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€'
                       ELSE currency_code END || ')'
       WHERE department_id = v_id AND kind = 'custodial'
         AND name = v_old_name || ' (' || CASE currency_code
                       WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                       WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€'
                       ELSE currency_code END || ')';
      UPDATE tg_chat_links SET department_name = v_name WHERE department_id = v_id;
    END IF;
  END IF;

  IF v_chat_given THEN
    IF v_chat IS NOT NULL THEN
      UPDATE tg_chat_links SET is_active = false
       WHERE is_active AND (chat_id = v_chat OR department_id = v_id);
      INSERT INTO tg_chat_links (chat_id, department_id, department_name, is_active)
      VALUES (v_chat, v_id, v_name, true)
      ON CONFLICT (chat_id) DO UPDATE
        SET department_id = EXCLUDED.department_id,
            department_name = EXCLUDED.department_name,
            is_active = true;
    ELSE
      UPDATE tg_chat_links SET is_active = false WHERE department_id = v_id AND is_active;
    END IF;
  END IF;

  IF v_cats_given THEN
    DELETE FROM fin_department_categories WHERE department_id = v_id;
    INSERT INTO fin_department_categories (department_id, category_id)
    SELECT v_id, NULLIF(x, '')::uuid
      FROM jsonb_array_elements_text(COALESCE(payload->'category_ids', '[]'::jsonb)) x
     WHERE NULLIF(x, '') IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_viewers_given THEN
    DELETE FROM fin_department_viewers dv
     WHERE dv.department_id = v_id
       AND dv.vaishnava_id::text NOT IN (
         SELECT x FROM jsonb_array_elements_text(COALESCE(payload->'viewer_ids', '[]'::jsonb)) x);
    INSERT INTO fin_department_viewers (department_id, vaishnava_id)
    SELECT v_id, NULLIF(x, '')::uuid
      FROM jsonb_array_elements_text(COALESCE(payload->'viewer_ids', '[]'::jsonb)) x
     WHERE NULLIF(x, '') IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;
