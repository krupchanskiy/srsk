-- Уточнение ВГ 01.10.2026 (чат «Даты ретритов художников»): «ретрит идёт, пока живут его люди» —
-- только для внутренних ретритов (fin_prasad_settings.is_internal, как Ретрит Художников).
-- Обычные — даты ретрита плюс до 3 дней позднего выезда (правило «вариант 2», OUTSIDE_RETREAT_DAYS
-- в timeline.js); кто живёт дольше — подсказка «Разделить» в «Гости без события».
-- Было (603): Сева-ретрит тянулся до 30.09, Лила-киртан 2027 — до 27.03.2027.

-- Признак «внутренний» нужен шахматке, а fin_prasad_settings пользователям не видна —
-- отдаём только этот флаг
create or replace function retreat_is_internal(p_retreat uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce((select is_internal from fin_prasad_settings where retreat_id = p_retreat), false)
$$;
revoke all on function retreat_is_internal(uuid) from public, anon;
grant execute on function retreat_is_internal(uuid) to authenticated;

create or replace view retreat_fact_end with (security_invoker = true) as
select r.id as retreat_id,
       case when retreat_is_internal(r.id)
            then greatest(r.end_date, max(res.check_out))
            else least(greatest(r.end_date, max(res.check_out)), r.end_date + 3)
       end as fact_end,
       retreat_is_internal(r.id) as is_internal
  from retreats r
  left join residents res
    on res.retreat_id = r.id
   and res.status in ('confirmed', 'checked_out')
   and res.check_in <= r.end_date
 group by r.id, r.end_date;

comment on view retreat_fact_end is
  'Фактическое окончание ретрита: внутренний — выезд последнего, кто заехал и остался; обычный — не дольше end_date + 3 дня';
