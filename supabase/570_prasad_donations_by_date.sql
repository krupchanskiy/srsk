-- =============================================================
-- Пожертвования на прасад: чьи они (решение ВГ 27.09.2026).
--   * отмечено на ретрит в Финансах — доход этого ретрита (как было);
--   * не отмечено, но дата попадает в официальные даты НАШЕГО ОБЩЕГО ретрита
--     (не сторонний is_external, открытый is_public, не «внутренний» в fin_prasad_settings)
--     — доход этого ретрита автоматически;
--   * остальное (вне ретритов, во время внутреннего или стороннего) — «Гости без события».
-- Сторонние ретриты: их приход за прасад — тоже «Гости без события» (решает страница Себестоимости).
-- Два общих ретрита одновременно не бывает (ВГ); если вдруг совпадут — не угадываем, ⚠ и в «Гости без события».
-- Только чтение: проводки не меняются, отметку ретрита в Финансах можно поставить руками.
-- =============================================================

-- наш общий ретрит на дату: ровно один, иначе null
create or replace function public.fin_private_common_retreat_on(p_date date)
returns uuid language sql stable security definer set search_path = public
as $$
  select case when count(*) = 1 then min(r.id::text)::uuid end
    from retreats r
    left join fin_prasad_settings s on s.retreat_id = r.id
   where p_date between r.start_date and r.end_date
     and not coalesce(r.is_external, false) and coalesce(r.is_public, false)
     and not coalesce(s.is_internal, false)
$$;
revoke all on function public.fin_private_common_retreat_on(date) from public, anon, authenticated;

-- все пожертвования на прасад за период: отмеченный ретрит, ретрит по дате, неоднозначные
create or replace function public.fin_prasad_donations(p_from date, p_to date)
returns table(posting_id uuid, occurred_on date, amount_base numeric, comment text,
              tagged_retreat_id uuid, auto_retreat_id uuid, ambiguous boolean)
language plpgsql stable security definer set search_path = public
as $function$
begin
  if not (fin_kitchen_can_view() or fin_can_read_all()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  return query
    select p.id, o.occurred_on, p.amount_base, o.comment, ao.retreat_id,
           case when ao.retreat_id is null then fin_private_common_retreat_on(o.occurred_on) end,
           ao.retreat_id is null and fin_private_common_retreat_on(o.occurred_on) is null
             and (select count(*) from retreats r left join fin_prasad_settings s on s.retreat_id = r.id
                   where o.occurred_on between r.start_date and r.end_date
                     and not coalesce(r.is_external, false) and coalesce(r.is_public, false)
                     and not coalesce(s.is_internal, false)) > 1
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_categories c on c.id = p.category_id
      left join fin_accounting_objects ao on ao.id = p.object_id
     where c.name = 'Прасад - пожертвование' and p.direction::text = 'in' and not o.is_reversed
       and o.occurred_on between p_from and p_to
     order by o.occurred_on;
end;
$function$;
revoke all on function public.fin_prasad_donations(date, date) from public, anon;
grant execute on function public.fin_prasad_donations(date, date) to authenticated;

-- fin_prasad_income: к пожертвованиям ретрита добавить неотмеченные в его даты (если он общий)
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.fin_prasad_income(uuid)'::regprocedure) into v_def;
  if position('donations_auto' in v_def) > 0 then return; end if;
  v_new := replace(v_def,
$old$     where p.object_id = v_obj and p.direction::text = 'in' and not o.is_reversed
       and cat.name = 'Прасад - пожертвование'
  ), kp as ($old$,
$new$     where p.direction::text = 'in' and not o.is_reversed
       and cat.name = 'Прасад - пожертвование'
       and (p.object_id = v_obj or (p.object_id is null and fin_private_common_retreat_on(o.occurred_on) = p_retreat))
  ), don_auto as (
    select coalesce(sum(p.amount_base), 0) as s, count(*) as n
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_categories cat on cat.id = p.category_id
     where p.direction::text = 'in' and not o.is_reversed and cat.name = 'Прасад - пожертвование'
       and p.object_id is null and fin_private_common_retreat_on(o.occurred_on) = p_retreat
  ), kp as ($new$);
  v_new := replace(v_new, $old$    'donations', (select s from don),$old$,
    $new$    'donations', (select s from don),
    'donations_auto', (select s from don_auto),
    'donations_auto_n', (select n from don_auto),$new$);
  if v_new = v_def or position('donations_auto_n' in v_new) = 0 then
    raise exception 'fin_prasad_income: не найдено место для правки';
  end if;
  execute v_new;
end $$;
