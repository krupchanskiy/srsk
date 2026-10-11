-- 680: аванс у уехавшего — решение менеджера строками и проводка финансистом (ВГ, 11.10).
-- Менеджер CRM выясняет у участника, что делать с переплатой, и записывает строки «сумма → куда»:
--   donate  — пожертвовать;
--   deposit — оставить на балансе гостя без ретрита (ещё не знает, когда приедет);
--   retreat — перенести на выбранный ретрит;
--   refund  — вернуть деньгами.
-- Деньги двигает только финансист: в «Участниках и оплатах» у каждой строки кнопка «Провести».
-- Пожертвование — компенсирующее начисление (как «Оставить пожертвованием»), возврат — fin_refund_advance,
-- перенос — fin_advance_move (ниже): зеркало fin_deposit_apply.

create table if not exists public.crm_advance_decisions (
    id uuid primary key default gen_random_uuid(),
    deal_id uuid not null references public.crm_deals(id) on delete cascade,
    participant_id uuid not null references public.vaishnavas(id),
    retreat_id uuid not null references public.retreats(id),
    currency text not null,
    amount numeric not null check (amount > 0),
    -- [{op_id, action, amount, retreat_id?, done_at?, done_by?}]
    lines jsonb not null,
    note text,
    created_by uuid references public.vaishnavas(id),
    created_at timestamptz not null default now()
);

create index if not exists crm_advance_decisions_deal_idx on public.crm_advance_decisions(deal_id, created_at desc);
create index if not exists crm_advance_decisions_participant_idx on public.crm_advance_decisions(participant_id, retreat_id);

alter table public.crm_advance_decisions enable row level security;

drop policy if exists "Staff read advance decisions" on public.crm_advance_decisions;
create policy "Staff read advance decisions" on public.crm_advance_decisions
    for select to authenticated using (is_staff((select auth.uid())));
drop policy if exists "Staff add advance decisions" on public.crm_advance_decisions;
create policy "Staff add advance decisions" on public.crm_advance_decisions
    for insert to authenticated with check (is_staff((select auth.uid())));
-- update/delete — только через fin_advance_decision_line_done (security definer)

-- Проверка строк при записи: действия, суммы, ретрит у переноса, сумма строк = аванс
create or replace function public.crm_advance_decisions_check()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
    l jsonb;
    v_sum numeric := 0;
begin
    if jsonb_typeof(new.lines) <> 'array' or jsonb_array_length(new.lines) = 0 then
        raise exception 'Укажите, что делать с авансом';
    end if;
    for l in select * from jsonb_array_elements(new.lines) loop
        if coalesce(l->>'action', '') not in ('donate', 'deposit', 'retreat', 'refund') then
            raise exception 'Неизвестное решение по авансу: %', l->>'action';
        end if;
        if coalesce((l->>'amount')::numeric, 0) <= 0 then
            raise exception 'Сумма в каждой строке должна быть больше нуля';
        end if;
        if l->>'action' = 'retreat' and nullif(l->>'retreat_id', '') is null then
            raise exception 'Выберите ретрит, на который перенести аванс';
        end if;
        if nullif(l->>'op_id', '') is null then
            raise exception 'Нет op_id у строки решения';
        end if;
        v_sum := v_sum + (l->>'amount')::numeric;
    end loop;
    if abs(v_sum - new.amount) > 0.5 then
        raise exception 'Строки в сумме дают %, а аванс %', round(v_sum, 2), round(new.amount, 2);
    end if;
    return new;
end;
$function$;

drop trigger if exists crm_advance_decisions_check on public.crm_advance_decisions;
create trigger crm_advance_decisions_check before insert on public.crm_advance_decisions
    for each row execute function public.crm_advance_decisions_check();

-- Перенос переплаты с ретрита: на баланс гостя без ретрита (p_to = null) или на другой ретрит.
-- Минус на исходном ретрите, плюс на получателе — стартовыми строками, в валюте расчёта исходного
create or replace function public.fin_advance_move(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid; v_request_id uuid; v_participant uuid; v_from uuid; v_to uuid; v_amount numeric;
  v_container uuid := fin_private_deposit_retreat();
  v_b jsonb; v_cur text; v_есть numeric; v_from_name text; v_to_name text; v_detail text;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Доступно только администратору финансов';
  end if;
  perform fin_private_assert_keys(payload, array['request_id', 'participant_id', 'from_retreat_id', 'to_retreat_id', 'amount']);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_from        := fin_private_get_uuid(payload, 'from_retreat_id', true);
  v_to          := coalesce(fin_private_get_uuid(payload, 'to_retreat_id', false), v_container);
  v_amount      := fin_private_get_money(payload, 'amount', true);

  -- повтор той же команды — тот же ответ
  if exists (select 1 from fin_participant_opening_balances where id = fin_private_child_uuid(v_request_id, 'out')) then
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('amount', v_amount), 'warnings', '[]'::jsonb);
  end if;

  select coalesce(name_ru, name_en) into v_from_name from retreats where id = v_from and not is_system;
  if v_from_name is null then
    raise exception 'invalid_payload' using detail = 'Исходный ретрит не найден';
  end if;
  if v_to = v_from then
    raise exception 'invalid_payload' using detail = 'Аванс уже на этом ретрите';
  end if;
  if v_to <> v_container then
    select coalesce(name_ru, name_en) into v_to_name from retreats where id = v_to and not is_system;
    if v_to_name is null then
      raise exception 'invalid_payload' using detail = 'Ретрит не найден';
    end if;
  end if;

  v_b := fin_private_participant_balance_v2(v_participant, v_from);
  v_cur := coalesce(v_b->>'currency', 'INR');
  v_есть := -coalesce((v_b->>'net')::numeric, 0);
  if v_есть <= 0.005 then
    raise exception 'no_advance' using detail = 'На этом ретрите у человека нет аванса';
  end if;
  if v_amount <= 0 or v_amount > v_есть + 0.005 then
    raise exception 'invalid_payload'
      using detail = format('Аванс %s — перенести можно не больше', fin_fmt_money(v_есть, v_cur));
  end if;

  insert into fin_participant_opening_balances (id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
                                                source_document, request_hash, comment, created_by)
  values (fin_private_child_uuid(v_request_id, 'out'), v_participant, v_from, v_amount, v_cur, 'debt', 'general',
          'Аванс перенесён',
          fin_private_hash(jsonb_build_object('command', 'advance_move_out', 'request_id', lower(v_request_id::text))),
          case when v_to = v_container then 'Аванс оставлен на балансе гостя (без ретрита)'
               else format('Аванс перенесён на «%s»', v_to_name) end, v_actor),
         (fin_private_child_uuid(v_request_id, 'in'), v_participant, v_to, v_amount, v_cur, 'credit', 'general',
          'Аванс перенесён',
          fin_private_hash(jsonb_build_object('command', 'advance_move_in', 'request_id', lower(v_request_id::text))),
          format('Аванс с «%s»: %s', v_from_name, fin_fmt_money(v_amount, v_cur)), v_actor);

  perform crm_apply_deal_totals(cd.id) from crm_deals cd
    where cd.vaishnava_id = v_participant and cd.retreat_id in (v_from, v_to);

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('amount', v_amount, 'currency', v_cur), 'warnings', '[]'::jsonb);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

revoke all on function public.fin_advance_move(jsonb) from public, anon;
grant execute on function public.fin_advance_move(jsonb) to authenticated;

-- Строка решения проведена — отметка, кто и когда
create or replace function public.fin_advance_decision_line_done(p_decision uuid, p_op uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_actor uuid;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden', 'message', 'Доступно только администратору финансов'));
  end if;
  update crm_advance_decisions
     set lines = (select jsonb_agg(case when l->>'op_id' = p_op::text and l->>'done_at' is null
                                        then l || jsonb_build_object('done_at', now(), 'done_by', v_actor)
                                        else l end order by ord)
                    from jsonb_array_elements(lines) with ordinality as x(l, ord))
   where id = p_decision;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.fin_advance_decision_line_done(uuid, uuid) from public, anon;
grant execute on function public.fin_advance_decision_line_done(uuid, uuid) to authenticated;
