-- 618: пропуски питания из окон начисления — участник ретрита и гость без события
-- (ВГ, 02.10.2026: прасад за приём, завтрак и обед отдельно, как у групп).
-- Лента дней в окне: снятый приём, который кухня считала, — пропуск (resident_meal_skips,
-- уже учитывается в eating_detail, 617). Поставленный завтрак в день заезда / обед в день
-- выезда, которых кухня не считала, — ранний заезд / поздний выезд (только включаем).
-- Пропуски заменяются только в переданном диапазоне дней [from, to] — дни вне ленты не трогаем.
create or replace function public.fin_set_meal_skips(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_actor uuid; v_detail text; v_res residents%rowtype; v_from date; v_to date; v_n int;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Пропуски питания отмечает администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'from', 'to', 'skips', 'early_checkin', 'late_checkout']);
    select * into v_res from residents where id = fin_private_get_uuid(payload, 'resident_id', true) for update;
    if not found then raise exception 'invalid_payload' using detail = 'Проживание не найдено'; end if;
    if jsonb_typeof(payload->'skips') is distinct from 'array' then
        raise exception 'invalid_payload' using detail = 'skips: нужен массив дней';
    end if;
    v_from := nullif(payload->>'from', '')::date;
    v_to := nullif(payload->>'to', '')::date;
    if v_from is null or v_to is null or v_to < v_from then
        raise exception 'invalid_payload' using detail = 'Нужен диапазон дней from–to';
    end if;

    update residents set
        early_checkin = case when coalesce((payload->>'early_checkin')::boolean, false) then true else early_checkin end,
        late_checkout = case when coalesce((payload->>'late_checkout')::boolean, false) then true else late_checkout end
     where id = v_res.id
       and ((coalesce((payload->>'early_checkin')::boolean, false) and not coalesce(early_checkin, false))
         or (coalesce((payload->>'late_checkout')::boolean, false) and not coalesce(late_checkout, false)));

    delete from resident_meal_skips where resident_id = v_res.id and d between v_from and v_to;
    insert into resident_meal_skips (resident_id, d, breakfast, lunch, created_by)
    select v_res.id, s.d, s.b, s.l, v_actor from (
        select (x->>'d')::date d, coalesce((x->>'b')::boolean, false) b, coalesce((x->>'l')::boolean, false) l
          from jsonb_array_elements(payload->'skips') x
    ) s
     where s.d between v_from and v_to
       and s.d >= coalesce(v_res.meal_start_date, v_res.check_in)
       and (coalesce(v_res.meal_end_date, v_res.check_out) is null or s.d <= coalesce(v_res.meal_end_date, v_res.check_out))
       and (s.b or s.l)
    on conflict (resident_id, d) do nothing;
    get diagnostics v_n = row_count;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object('skips', v_n), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;
revoke all on function public.fin_set_meal_skips(jsonb) from public, anon;
grant execute on function public.fin_set_meal_skips(jsonb) to authenticated;
