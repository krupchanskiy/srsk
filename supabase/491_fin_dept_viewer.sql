-- =============================================================
-- Роль «Финансы: руководитель департамента (просмотр)» (fin_dept_viewer),
-- этап 4 учёта затрат кухни, ТЗ п. 3.7 «Доступ главы департамента».
--
-- Что даёт (только чтение, только свой департамент):
--   * счета и проводки своего департамента — уже отдаёт fin_can_see_account
--     (ответственный за департамент), роль лишь открывает страницы;
--   * отчёт по департаментам — только департаменты, где человек ответственный;
--   * отчёт по ретриту — только блок «Прасад» и только главе департамента
--     «Кухня» (без оргвзноса, проживания, долгов участников, кафе);
--   * детализация отчёта — только по блоку «Прасад».
-- Записывать роль не может: функции создания операций проверяют
-- fin_admin / fin_account_user, их эта миграция не трогает.
-- Без обхода для суперпользователей: fin_private_has_permission строгая.
-- =============================================================

-- ---------- право и вспомогательные функции ----------
insert into permissions (module_id, code, name_ru, name_en, name_hi, category, sort_order)
select p.module_id, 'fin_dept_viewer',
       'Финансы: руководитель департамента (просмотр)',
       'Finance: department head (view only)',
       'वित्त: विभाग प्रमुख (केवल देखना)',
       'finance', 0
  from permissions p where p.code = 'fin_account_user'
on conflict (code) do nothing;

create or replace function public.fin_is_dept_viewer(p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public
as $$ select p_user is not null and fin_private_has_permission(p_user, 'fin_dept_viewer') $$;

create or replace function public.fin_is_kitchen_head(p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public
as $$
  select p_user is not null and exists (
    select 1 from fin_departments d
      join vaishnavas v on v.id = d.responsible_person_id
     where d.name = 'Кухня' and v.user_id = p_user)
$$;

revoke all on function public.fin_is_dept_viewer(uuid) from public, anon;
revoke all on function public.fin_is_kitchen_head(uuid) from public, anon;
grant execute on function public.fin_is_dept_viewer(uuid) to authenticated;
grant execute on function public.fin_is_kitchen_head(uuid) to authenticated;

-- ---------- справочники: нужны страницам для подписей ----------
create or replace view public.fin_v_accounting_objects as
 SELECT id, type, retreat_id, display_name, report_dirty_at, created_at,
    (EXISTS ( SELECT 1 FROM fin_object_closures c WHERE ((c.object_id = o.id) AND c.is_initial))) AS is_closed
   FROM fin_accounting_objects o
  WHERE (fin_can_read_all() OR fin_is_account_user() OR fin_is_dept_viewer());

create or replace view public.fin_v_categories as
 SELECT id, code, name, direction, visible_to_departments, is_active
   FROM fin_categories
  WHERE (fin_can_read_all() OR (visible_to_departments AND (fin_is_account_user() OR fin_is_dept_viewer())));

create or replace view public.fin_v_cost_centers as
 SELECT id, code, name, is_active
   FROM fin_cost_centers
  WHERE (fin_can_read_all() OR fin_is_account_user() OR fin_is_dept_viewer());

create or replace view public.fin_v_currencies as
 SELECT code, symbol, name, is_active
   FROM fin_currencies
  WHERE (fin_can_read_all() OR fin_is_account_user() OR fin_is_dept_viewer());

-- ---------- отчёт по департаментам: только свои ----------
create or replace function public.fin_get_department_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $function$
declare
  v_departments jsonb;
  v_scope uuid[];
begin
  if fin_can_read_all() then
    v_scope := null;                       -- администратор и наблюдатель видят все
  elsif fin_is_dept_viewer() then
    select coalesce(array_agg(d.id), '{}') into v_scope
      from fin_departments d
      join vaishnavas v on v.id = d.responsible_person_id
     where v.user_id = auth.uid();
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
       and o.type <> 'opening'          -- начальный остаток не движение периода
       and o.occurred_on between p_from and p_to
  ),
  итоги as (
    select department_id,
           coalesce(sum(amount_base) filter (where type = 'transfer' and direction = 'in'), 0) as received,
           coalesce(sum(amount_base) filter (where type = 'transfer' and direction = 'out'), 0) as passed_on,
           -- со знаком, поэтому сторно само вычитается из расхода
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

-- ---------- отчёт по ретриту: главе кухни только блок «Прасад» ----------
create or replace function public.fin_get_retreat_report(p_retreat uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $function$
DECLARE
  v_object fin_accounting_objects%ROWTYPE;
  v_report jsonb;
  v_versions jsonb;
  v_restricted boolean := false;
BEGIN
  IF NOT fin_can_read_all() THEN
    IF fin_is_dept_viewer() AND fin_is_kitchen_head() THEN
      v_restricted := true;
    ELSE
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
    END IF;
  END IF;

  SELECT * INTO v_object FROM fin_accounting_objects WHERE retreat_id = p_retreat;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('exists', false));
  END IF;

  v_report := fin_private_build_snapshot(v_object.id);

  IF v_restricted THEN
    v_report := jsonb_build_object(
      'schema_version', v_report->'schema_version',
      'object', v_report->'object',
      'generated_at', v_report->'generated_at',
      'prasad', v_report->'prasad');
    v_versions := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'closure_id', c.id, 'version', c.version, 'is_initial', c.is_initial,
      'status', c.status, 'closed_at', c.closed_at,
      'closed_by_name', fin_private_person_name((SELECT v.id FROM vaishnavas v WHERE v.user_id = c.closed_by LIMIT 1)),
      'finalized_at', c.finalized_at, 'reason', c.reason,
      'attachment_path', (SELECT a.storage_path FROM fin_attachments a WHERE a.id = c.attachment_id),
      'attachment_name', (SELECT a.file_name FROM fin_attachments a WHERE a.id = c.attachment_id)
    ) ORDER BY c.version DESC), '[]'::jsonb) INTO v_versions
    FROM fin_object_closures c WHERE c.object_id = v_object.id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'exists', true,
    'restricted', v_restricted,
    'object_id', v_object.id,
    'is_closed', EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_object.id AND c.is_initial),
    'report_dirty_at', v_object.report_dirty_at,
    'report', v_report,
    'versions', v_versions
  ));
END;
$function$;

-- ---------- детализация отчёта: главе кухни только «Прасад» ----------
create or replace function public.fin_get_report_drilldown(p_object uuid, p_unit text, p_direction text, p_group text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $function$
DECLARE
  v_rows jsonb;
  v_total numeric;
BEGIN
  IF NOT fin_can_read_all() THEN
    IF NOT COALESCE(fin_is_dept_viewer() AND fin_is_kitchen_head() AND p_unit = 'prasad', false) THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
    END IF;
  END IF;
  IF p_unit NOT IN ('retreat', 'prasad', 'cafe') OR p_direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'unit: retreat|prasad|cafe, direction: in|out';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'operation_id', y.operation_id,
           'occurred_on', y.occurred_on,
           'type', y.type,
           'description', y.comment,
           'reason', y.reason,
           'account', y.account_name,
           'currency', y.currency_code,
           'amount', y.amt_signed,
           'amount_base', y.base_signed,
           'participant', y.participant_name,
           'entered_by', y.entered_by
         ) ORDER BY y.occurred_on DESC, y.created_at DESC), '[]'::jsonb),
         COALESCE(SUM(y.base_signed), 0)
    INTO v_rows, v_total
  FROM (
    SELECT x.*,
           CASE WHEN x.participant_id IS NOT NULL THEN fin_private_person_name(x.participant_id) END AS participant_name,
           COALESCE(
             fin_private_person_name((SELECT v.id FROM vaishnavas v WHERE v.user_id = x.created_by LIMIT 1)),
             (SELECT pr.name FROM profiles pr WHERE pr.id = x.created_by)) AS entered_by
    FROM (
      SELECT p.operation_id, o.occurred_on, o.type, o.comment, o.reason, o.created_at, o.created_by,
             a.name AS account_name, p.currency_code, p.participant_id,
             CASE WHEN p.direction::text = p_direction THEN p.amount ELSE -p.amount END AS amt_signed,
             CASE WHEN p.direction::text = p_direction THEN p.amount_base ELSE -p.amount_base END AS base_signed,
             CASE
               WHEN c.direction::text = 'in' AND c.name = 'Касса кафе' THEN 'cafe'
               WHEN c.direction::text = 'in' AND (c.name = 'Прасад - пожертвование' OR p.participant_balance_kind = 'meals') THEN 'prasad'
               WHEN c.direction::text = 'out' AND c.name IN ('Прасад', 'Закупка готового Прасада') THEN 'prasad'
               WHEN c.direction::text = 'out' AND a.name ILIKE '%кафе%' THEN 'cafe'
               ELSE 'retreat'
             END AS unit,
             CASE
               WHEN c.direction::text = 'in' AND c.name = 'Оплата от участника'
                    AND p.participant_balance_kind IN ('org_fee', 'accommodation', 'meals', 'extra', 'general')
                 THEN p.participant_balance_kind::text
               ELSE p.category_id::text
             END AS grp_id
      FROM fin_postings p
      JOIN fin_operations o ON o.id = p.operation_id
      JOIN fin_categories c ON c.id = p.category_id
      JOIN fin_accounts a ON a.id = p.account_id
      WHERE p.object_id = p_object AND c.direction::text = p_direction
    ) x
    WHERE x.unit = p_unit AND x.grp_id = p_group
  ) y;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'rows', v_rows, 'total_base', v_total));
END;
$function$;
