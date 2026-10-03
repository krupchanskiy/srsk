-- 627: отлучки и пропуски питания из шахматки (ВГ, 03.10.2026).
-- Человек живёт одной записью, номер остаётся за ним; на дни отлучки снимаются приёмы
-- прасада — те же resident_meal_skips (617), что учитывает eating_detail, поэтому кухня,
-- Себестоимость и бот видят меньше порций сами. Право — edit_timeline (ресепшен), не финансы.
-- Пропуски заменяются только в переданном диапазоне [from, to]; ранний заезд / поздний
-- выезд здесь не трогаем — края правятся датами проживания.
create or replace function public.resident_set_meal_skips(p_resident_id uuid, p_from date, p_to date, p_skips jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_uid uuid := auth.uid();
    v_res residents%rowtype;
    v_n int;
begin
    if v_uid is null or not has_permission(v_uid, 'edit_timeline') then
        raise exception 'Нет права менять шахматку';
    end if;
    select * into v_res from residents where id = p_resident_id for update;
    if not found then raise exception 'Проживание не найдено'; end if;
    if p_from is null or p_to is null or p_to < p_from then raise exception 'Нужен диапазон дней'; end if;
    if jsonb_typeof(p_skips) is distinct from 'array' then raise exception 'Нужен массив дней'; end if;

    delete from resident_meal_skips where resident_id = v_res.id and d between p_from and p_to;
    insert into resident_meal_skips (resident_id, d, breakfast, lunch, created_by)
    select v_res.id, s.d, s.b, s.l, v_uid from (
        select (x->>'d')::date d, coalesce((x->>'b')::boolean, false) b, coalesce((x->>'l')::boolean, false) l
          from jsonb_array_elements(p_skips) x
    ) s
     where s.d between p_from and p_to
       and s.d >= coalesce(v_res.meal_start_date, v_res.check_in)
       and (coalesce(v_res.meal_end_date, v_res.check_out) is null or s.d <= coalesce(v_res.meal_end_date, v_res.check_out))
       and (s.b or s.l)
    on conflict (resident_id, d) do nothing;
    get diagnostics v_n = row_count;
    return v_n;
end;
$function$;
revoke all on function public.resident_set_meal_skips(uuid, date, date, jsonb) from public, anon;
grant execute on function public.resident_set_meal_skips(uuid, date, date, jsonb) to authenticated;

insert into translations (key, ru, en, hi) values
  ('timeline_meal_days', 'Питание по дням', 'Meals by day', 'दिन के अनुसार भोजन'),
  ('timeline_away', 'Уезжает на время', 'Away for a while', 'कुछ समय के लिए बाहर'),
  ('timeline_away_from', 'Уезжает', 'Leaves', 'जाता है'),
  ('timeline_away_to', 'Вернётся', 'Returns', 'लौटता है'),
  ('timeline_away_that_day', 'в этот день', 'that day', 'उस दिन'),
  ('timeline_away_apply', 'Применить к списку', 'Apply to list', 'सूची पर लागू करें'),
  ('timeline_meal_days_hint', 'Снятая галочка — приём не готовится на этого человека. Комната остаётся за ним.', 'Unchecked — no meal is cooked for this person. The room stays theirs.', 'हटाया गया निशान — इस व्यक्ति के लिए भोजन नहीं बनेगा। कमरा उनका ही रहेगा।'),
  ('timeline_meal_days_saved', 'Питание сохранено — кухня видит изменения', 'Meals saved — the kitchen sees the changes', 'भोजन सहेजा गया — रसोई बदलाव देखती है'),
  ('timeline_meal_skipped_n', 'пропусков: {n}', 'skipped: {n}', 'छूटे: {n}'),
  ('timeline_away_hatch', 'Не ест — уехал на время', 'Not eating — away for a while', 'भोजन नहीं — कुछ समय के लिए बाहर'),
  ('timeline_away_bad_dates', 'Даты отлучки должны быть внутри проживания, «вернётся» не раньше «уезжает»', 'Away dates must be within the stay, return not before leaving', 'अनुपस्थिति की तिथियाँ ठहराव के भीतर हों, लौटना जाने से पहले नहीं')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
