-- 757: каким департаментам видна статья — правится прямо из карточки статьи
-- в Справочниках (просьба ВГ 29.10). Раньше набор статей правился только
-- из карточки департамента.
--
-- Расход: меняется только у департаментов со СВОИМ набором (fin_department_categories
-- не пуст). Департаменты на общем наборе видят все статьи с visible_to_departments —
-- их не трогаем. Убрать последнюю статью из своего набора нельзя: пустой набор
-- означает «общий», и департамент вдруг увидит всё.
-- Приход: набор статей выручки (fin_department_income_categories), общего нет.

create or replace function public.fin_save_category_departments(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cat uuid;
  v_dir fin_direction;
  v_ids uuid[];
  v_emptied text;
begin
  if not fin_is_admin() then
    raise exception 'forbidden' using detail = 'Только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['category_id','department_ids']);
  v_cat := fin_private_get_uuid(payload, 'category_id');
  select direction into v_dir from fin_categories where id = v_cat;
  if v_dir is null then
    raise exception 'invalid_payload' using detail = 'Статья не найдена';
  end if;
  v_ids := coalesce(array(select jsonb_array_elements_text(payload->'department_ids')::uuid), '{}');

  if v_dir = 'out' then
    select string_agg(d.name, ', ') into v_emptied
      from fin_departments d
     where d.id <> all (v_ids)
       and exists (select 1 from fin_department_categories dc where dc.department_id = d.id and dc.category_id = v_cat)
       and (select count(*) from fin_department_categories dc where dc.department_id = d.id) = 1;
    if v_emptied is not null then
      raise exception 'invalid_payload' using detail =
        'Это последняя статья в своём наборе департамента: ' || v_emptied || '. Пустой набор = общий, департамент увидит все статьи. Поправьте набор в карточке департамента.';
    end if;

    delete from fin_department_categories
     where category_id = v_cat and department_id <> all (v_ids);
    insert into fin_department_categories (department_id, category_id)
    select d.id, v_cat from fin_departments d
     where d.id = any (v_ids)
       and exists (select 1 from fin_department_categories dc where dc.department_id = d.id)
    on conflict do nothing;
  else
    delete from fin_department_income_categories
     where category_id = v_cat and department_id <> all (v_ids);
    insert into fin_department_income_categories (department_id, category_id)
    select d.id, v_cat from fin_departments d where d.id = any (v_ids)
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_cat));
exception when others then
  declare v_detail text;
  begin
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
  end;
end;
$function$;

revoke all on function public.fin_save_category_departments(jsonb) from public, anon;
grant execute on function public.fin_save_category_departments(jsonb) to authenticated;
