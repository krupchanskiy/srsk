-- 613: проверка целостности «даты регистрации разошлись со сделкой».
--
-- После миграции 612 (в журнале базы — 608_crm_register_compare_old_deal_dates) триггер crm_register_on_booked переносит даты сделки
-- в регистрацию. Эта проверка — страховка: если расхождение всё же появится
-- (новая ошибка, ручная правка регистрации, обход триггера), оно всплывёт в ежедневной
-- проверке целостности (fin_integrity_sweep, сообщение в Телеграм) и в списке подробностей.
--
-- Берутся только оплаченные сделки (booked…completed), регистрации, созданные из CRM,
-- и ретриты, которые ещё не закончились. Даты сделки — по тому же правилу, что в триггере:
-- своя дата (stay_check_in/out) при 'custom' или «билеты не нужны», иначе дата рейса.

create or replace function public.crm_registration_dates_drift()
 returns table(deal_id uuid, vaishnava_id uuid, retreat_id uuid,
               reg_arr timestamptz, deal_arr timestamptz,
               reg_dep timestamptz, deal_dep timestamptz)
 language sql
 stable
 set search_path to 'public'
as $function$
  select d.id, d.vaishnava_id, d.retreat_id,
         rr.arrival_datetime, x.v_arr, rr.departure_datetime, x.v_dep
    from crm_deals d
    join retreats r on r.id = d.retreat_id
    join retreat_registrations rr
      on rr.vaishnava_id = d.vaishnava_id and rr.retreat_id = d.retreat_id
     and rr.is_auto_created and not rr.is_deleted
   cross join lateral (
     select case when (d.arrival_dates_status = 'custom' or d.checklist_tickets = 'not_needed')
                      and d.stay_check_in is not null
                 then d.stay_check_in else d.arrival_datetime end as v_arr,
            case when (d.departure_dates_status = 'custom' or d.checklist_tickets = 'not_needed')
                      and d.stay_check_out is not null
                 then d.stay_check_out else d.departure_datetime end as v_dep) x
   where d.status in ('booked', 'checklist', 'ready', 'completed')
     and coalesce(r.end_date, r.start_date) >= current_date
     and ((x.v_arr is not null and rr.arrival_datetime is distinct from x.v_arr)
       or (x.v_dep is not null and rr.departure_datetime is distinct from x.v_dep));
$function$;

revoke execute on function public.crm_registration_dates_drift() from public, anon;

-- Добавить проверку в fin_run_integrity_checks (в конец списка checks)
do $$
declare
  v_def text := pg_get_functiondef('public.fin_run_integrity_checks'::regproc);
  v_anchor constant text := $a$WHERE abs(s.pay - o.ob) > 0.01')
  );$a$;
begin
  if position('registration_dates_drift' in v_def) > 0 then return; end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'fin_run_integrity_checks: не найдено место для вставки проверки';
  end if;
  execute replace(v_def, v_anchor, $r$WHERE abs(s.pay - o.ob) > 0.01'),
    jsonb_build_object('name','registration_dates_drift',
      'detail','Даты заезда/выезда в регистрации разошлись со сделкой CRM — кухня и «Сам организует» считают по регистрации',
      'sql','SELECT count(*) FROM crm_registration_dates_drift()')
  );$r$);
end $$;

-- Добавить список подробностей в fin_get_integrity_details (перед веткой else)
do $$
declare
  v_def text := pg_get_functiondef('public.fin_get_integrity_details'::regproc);
  v_anchor constant text := $a$  else
    v_rows := '[]'::jsonb;$a$;
begin
  if position('registration_dates_drift' in v_def) > 0 then return; end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'fin_get_integrity_details: не найдено место для вставки ветки';
  end if;
  execute replace(v_def, v_anchor, $r$  elsif p_check = 'registration_dates_drift' then
    -- Условие — в crm_registration_dates_drift(), общее с проверкой
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', fin_private_person_name(x.vaishnava_id),
             'subtitle', coalesce(r.name_ru, r.name_en),
             'detail', concat_ws('; ',
                case when x.deal_arr is not null and x.reg_arr is distinct from x.deal_arr
                     then format('заезд: в сделке %s, в регистрации %s',
                                 to_char(x.deal_arr at time zone 'UTC', 'DD.MM.YYYY HH24:MI'),
                                 coalesce(to_char(x.reg_arr at time zone 'UTC', 'DD.MM.YYYY HH24:MI'), 'пусто')) end,
                case when x.deal_dep is not null and x.reg_dep is distinct from x.deal_dep
                     then format('выезд: в сделке %s, в регистрации %s',
                                 to_char(x.deal_dep at time zone 'UTC', 'DD.MM.YYYY HH24:MI'),
                                 coalesce(to_char(x.reg_dep at time zone 'UTC', 'DD.MM.YYYY HH24:MI'), 'пусто')) end),
             'link', format('../crm/deal.html?id=%s', x.deal_id)
           ) order by r.start_date, x.deal_id), '[]'::jsonb)
      into v_rows
      from crm_registration_dates_drift() x
      left join retreats r on r.id = x.retreat_id;

  else
    v_rows := '[]'::jsonb;$r$);
end $$;
