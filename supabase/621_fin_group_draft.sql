-- 621: «Сохранить» в окне группы — черновик листа без начисления (ВГ, 02.10).
-- Правки по ходу переговоров с организатором сохраняются, но на карточку организатора,
-- в шахматку и кухне ничего не уходит — это делает только «Начислить» (fin_group_save).
-- Черновик не трогает payer_id и totals (они — по последнему начислению);
-- draft_at > updated_at — в листе есть не начисленные правки.

alter table fin_group_sheets add column if not exists draft_at timestamptz;

create or replace function public.fin_group_save_draft(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_actor uuid; v_detail text; v_ret uuid;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Начисления группе делает администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['retreat_id', 'lines', 'prices']);
    select id into v_ret from retreats where id = fin_private_get_uuid(payload, 'retreat_id', true) and not is_system;
    if v_ret is null then raise exception 'invalid_payload' using detail = 'Событие не найдено'; end if;
    if jsonb_typeof(payload->'lines') <> 'array' then
        raise exception 'invalid_payload' using detail = 'lines: нужен массив строк';
    end if;

    insert into fin_group_sheets (retreat_id, lines, prices, draft_at, updated_at, updated_by)
    values (v_ret, payload->'lines',
            case when jsonb_typeof(payload->'prices') = 'object' then payload->'prices' end,
            now(), '-infinity', v_actor)
    on conflict (retreat_id) do update
       set lines = excluded.lines,
           prices = coalesce(excluded.prices, fin_group_sheets.prices),
           draft_at = now(), updated_by = excluded.updated_by;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object('draft_at', now()), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

revoke all on function public.fin_group_save_draft(jsonb) from public, anon;
grant execute on function public.fin_group_save_draft(jsonb) to authenticated;

-- fin_group_get: признак «есть не начисленный черновик» — точечная замена в теле функции
do $$
declare v_def text := pg_get_functiondef('public.fin_group_get(uuid)'::regprocedure);
begin
    if v_def like '%''draft'', v_sheet.draft_at%' then return; end if;
    if v_def not like '%''updated_at'', v_sheet.updated_at)%' then
        raise exception 'fin_group_get: не найдено место для draft';
    end if;
    execute replace(v_def, '''updated_at'', v_sheet.updated_at)',
        '''updated_at'', v_sheet.updated_at, ''draft'', coalesce(v_sheet.draft_at > v_sheet.updated_at, false))');
end $$;
