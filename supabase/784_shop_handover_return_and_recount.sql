-- 784: казначей может вернуть пакет продавцу, продавец исправляет пересчёт закрытой смены (ВГ 15.11.2026)
--
-- Раньше ошибку в пересчёте продавца было не исправить: смена закрыта, пакет висит
-- «ждёт казначея», следующий не собрать. Теперь:
--  • казначей нажимает «Вернуть продавцу» с причиной — пакет помечается returned,
--    смены снова «не сданы», в учёт ничего не попадает;
--  • продавец исправляет пересчёт закрытой несданной смены (каждая правка — в журнал
--    смены) и сдаёт заново.

alter table public.shop_handovers
    add column if not exists returned_at timestamptz,
    add column if not exists returned_by uuid references auth.users(id),
    add column if not exists return_reason text;
alter table public.shop_handovers drop constraint if exists shop_handovers_status_check;
alter table public.shop_handovers add constraint shop_handovers_status_check
    check (status = any (array['pending', 'accepted', 'returned']));

create table if not exists public.shop_count_log (
    id            uuid primary key default gen_random_uuid(),
    shift_id      uuid not null references public.shop_shifts(id),
    currency_code text not null,
    old_actual    numeric,
    new_actual    numeric not null,
    reason        text,
    changed_by    uuid default auth.uid(),
    changed_at    timestamptz not null default now()
);
comment on table public.shop_count_log is 'Исправления пересчёта закрытой смены до сдачи (784)';
alter table public.shop_count_log enable row level security;
drop policy if exists "shop view" on public.shop_count_log;
create policy "shop view" on public.shop_count_log for select to authenticated
    using ((select shop_can_view()) or (select fin_is_admin()));
revoke all on table public.shop_count_log from anon;
revoke insert, update, delete, truncate, references, trigger on table public.shop_count_log from authenticated;

-- казначей возвращает пакет: ничего не проводится, смены снова ждут сдачи
create or replace function public.shop_return_handover(p_handover uuid, p_reason text)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
    if not fin_is_admin() then
        raise exception 'Вернуть пакет может только казначей' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
        raise exception 'Напишите продавцу, что не так';
    end if;
    perform pg_advisory_xact_lock(hashtext('shop_accept_handover'));
    perform pg_advisory_xact_lock(hashtext('shop_prepare_handover'));
    if not exists (select 1 from shop_handovers where id = p_handover and status = 'pending' for update) then
        raise exception 'Пакет не найден или уже принят';
    end if;
    update shop_handovers
       set status = 'returned', returned_at = now(), returned_by = auth.uid(), return_reason = trim(p_reason)
     where id = p_handover;
    update shop_shifts set handover_id = null where handover_id = p_handover;
end $$;
grant execute on function public.shop_return_handover(uuid, text) to authenticated;

-- продавец исправляет пересчёт закрытой, ещё не сданной смены
create or replace function public.shop_recount_shift(payload jsonb)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_shift uuid := (payload->>'shift_id')::uuid;
    v_строка jsonb;
    v_cur text;
    v_факт numeric;
    v_причина text;
    v_ждём numeric;
    v_было numeric;
begin
    if not abk_current_user_has_permission('shop_sell') then
        raise exception 'Нет права менять пересчёт' using errcode = '42501';
    end if;
    perform 1 from shop_shifts where id = v_shift for update;
    if not exists (select 1 from shop_shifts where id = v_shift and status = 'closed' and handover_id is null) then
        raise exception 'Пересчёт можно исправить только у закрытой и ещё не сданной смены';
    end if;

    for v_строка in select * from jsonb_array_elements(coalesce(payload->'counts', '[]'::jsonb)) loop
        v_cur := v_строка->>'currency_code';
        v_факт := (v_строка->>'actual')::numeric;
        v_причина := nullif(trim(coalesce(v_строка->>'reason', '')), '');
        if v_факт is null or v_факт < 0 then
            raise exception 'Не указано, сколько насчитали в валюте %', v_cur;
        end if;
        select coalesce(sum(expected), 0) into v_ждём from shop_shift_expected(v_shift) where currency_code = v_cur;
        if v_факт <> v_ждём and v_причина is null then
            raise exception 'Расхождение по % не объяснено: ждём %, насчитали %', v_cur, v_ждём, v_факт;
        end if;
        select actual into v_было from shop_cash_counts where shift_id = v_shift and currency_code = v_cur;
        if v_было is not distinct from v_факт
           and (select reason from shop_cash_counts where shift_id = v_shift and currency_code = v_cur) is not distinct from v_причина then
            continue;
        end if;
        insert into shop_count_log (shift_id, currency_code, old_actual, new_actual, reason)
        values (v_shift, v_cur, v_было, v_факт, v_причина);
        insert into shop_cash_counts (shift_id, currency_code, expected, actual, reason)
        values (v_shift, v_cur, v_ждём, v_факт, v_причина)
        on conflict (shift_id, currency_code)
        do update set actual = excluded.actual, expected = excluded.expected, reason = excluded.reason;
    end loop;
end $$;
grant execute on function public.shop_recount_shift(jsonb) to authenticated;
