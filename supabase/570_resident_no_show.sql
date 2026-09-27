-- «Не приехал / отказ» из окна брони в шахматке (решение ВГ 25–27.09.2026).
-- Бронь без отметки заезда после своих дат попадала у кухни в «Уже уехали» и считалась съевшей.
-- Одно действие снимает всё, на что опирается подсчёт вкушающих, и ничего не удаляет:
--   • бронь → cancelled (последнее место групповой брони — снимает и её);
--   • регистрация на ретрит → cancelled, если у человека нет другой живой брони на этот ретрит;
--   • сделки CRM по ретриту → «Отменена» с причиной (по умолчанию «Не приехал»);
--   • в заметки брони и регистрации — строка «Не приехал DD.MM.YYYY: …» для истории.
-- Финансы не трогаем: оплата по сделке возвращается/переносится в финмодуле.

insert into crm_cancellation_reasons (code, name_ru, name_en, name_hi, sort_order)
select 'no_show', 'Не приехал', 'Did not arrive', 'नहीं पहुँचे', 0
where not exists (select 1 from crm_cancellation_reasons where code = 'no_show');

create or replace function public.resident_no_show(p_resident_id uuid, p_reason_id uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r residents%rowtype;
  v_reason uuid := p_reason_id;
  v_line text;
  v_reg_cancelled boolean := false;
  v_deals int := 0;
begin
  if not has_permission(auth.uid(), 'edit_timeline') then
    raise exception 'forbidden' using detail = 'Нет права менять шахматку';
  end if;

  select * into r from residents where id = p_resident_id for update;
  if not found then
    raise exception 'not_found' using detail = 'Бронь не найдена';
  end if;
  if r.arrived_at is not null or r.status not in ('confirmed', 'booked') then
    raise exception 'invalid_state' using detail = 'Заезд уже отмечен или бронь снята';
  end if;

  if v_reason is null then
    select id into v_reason from crm_cancellation_reasons where code = 'no_show';
  end if;
  v_line := 'Не приехал ' || to_char(current_date, 'DD.MM.YYYY')
         || coalesce(': ' || (select name_ru from crm_cancellation_reasons where id = v_reason and code <> 'no_show'), '')
         || coalesce(': ' || nullif(trim(p_note), ''), '');

  update residents
     set status = 'cancelled',
         notes = concat_ws(E'\n', nullif(notes, ''), v_line)
   where id = r.id;

  if r.booking_id is not null
     and not exists (select 1 from residents x where x.booking_id = r.booking_id and x.status <> 'cancelled') then
    update bookings set status = 'cancelled' where id = r.booking_id;
  end if;

  if r.vaishnava_id is not null and r.retreat_id is not null then
    if not exists (select 1 from residents x
                    where x.vaishnava_id = r.vaishnava_id and x.retreat_id = r.retreat_id
                      and x.id <> r.id and x.status <> 'cancelled') then
      update retreat_registrations
         set status = 'cancelled',
             org_notes = concat_ws(E'\n', nullif(org_notes, ''), v_line)
       where vaishnava_id = r.vaishnava_id and retreat_id = r.retreat_id
         and not is_deleted and status <> 'cancelled';
      v_reg_cancelled := found;

      update crm_deals
         set status = 'cancelled',
             cancellation_reason_id = v_reason,
             cancellation_note = coalesce(nullif(trim(p_note), ''), cancellation_note)
       where vaishnava_id = r.vaishnava_id and retreat_id = r.retreat_id
         and status not in ('cancelled', 'completed');
      get diagnostics v_deals = row_count;
    end if;
  end if;

  return jsonb_build_object('registration_cancelled', v_reg_cancelled, 'deals_cancelled', v_deals);
end;
$$;

revoke all on function public.resident_no_show(uuid, uuid, text) from public, anon;
grant execute on function public.resident_no_show(uuid, uuid, text) to authenticated;

-- Выезд раньше заезда: бронь пропадала из шахматки и из подсчёта вкушающих (Аравинда Сундари, 22.08 → 06.08).
-- NOT VALID — старая отменённая бронь с такой ошибкой остаётся как есть, новые и правленые проверяются.
alter table residents drop constraint if exists residents_check_out_after_check_in;
alter table residents add constraint residents_check_out_after_check_in
  check (check_out is null or check_out >= check_in) not valid;

insert into translations (key, ru, en, hi, context) values
('timeline_not_arrived_title', 'Не заселены', 'Not checked in', 'चेक-इन नहीं हुआ', 'Шахматка'),
('timeline_not_arrived_since', 'заезд с', 'check-in from', 'चेक-इन से', 'Шахматка'),
('timeline_no_name', 'Без имени', 'No name', 'बिना नाम', 'Шахматка'),
('timeline_no_show', 'Не приехал / отказ', 'No-show / declined', 'नहीं आए / मना किया', 'Шахматка'),
('timeline_no_show_will', 'Что произойдёт', 'What will happen', 'क्या होगा', 'Шахматка'),
('timeline_no_show_booking', 'Бронь снимается (остаётся в истории)', 'Booking is cancelled (kept in history)', 'बुकिंग रद्द (इतिहास में रहेगी)', 'Шахматка'),
('timeline_no_show_reg', 'Регистрация на ретрит отменяется', 'Retreat registration is cancelled', 'रिट्रीट पंजीकरण रद्द', 'Шахматка'),
('timeline_no_show_reg_kept', 'Регистрация остаётся — есть другая бронь на этот ретрит', 'Registration kept — there is another booking for this retreat', 'पंजीकरण रहेगा — इस रिट्रीट की दूसरी बुकिंग है', 'Шахматка'),
('timeline_no_show_deal', 'Сделка в CRM → «Отменена»', 'CRM deal → Cancelled', 'CRM डील → रद्द', 'Шахматка'),
('timeline_no_show_paid', 'По сделке оплачено — возврат или перенос оформляется в финансах', 'The deal has payments — refund or transfer is done in Finance', 'डील में भुगतान है — वापसी या स्थानांतरण वित्त में', 'Шахматка'),
('timeline_no_show_eating', 'Больше не считается вкушающим', 'No longer counted for meals', 'अब भोजन गिनती में नहीं', 'Шахматка'),
('timeline_no_show_reason', 'Причина', 'Reason', 'कारण', 'Шахматка'),
('timeline_no_show_note', 'Комментарий', 'Comment', 'टिप्पणी', 'Шахматка'),
('timeline_no_show_done', 'Отмечено: не приехал', 'Marked as no-show', 'नहीं आए — दर्ज', 'Шахматка'),
('timeline_late_arrival_shift', 'По плану заезд %s. Сдвинуть начало проживания на сегодня?', 'Planned check-in was %s. Move the stay start to today?', 'योजना अनुसार चेक-इन %s था। शुरुआत आज पर करें?', 'Шахматка'),
('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда', 'Check-out cannot be before check-in', 'चेक-आउट चेक-इन से पहले नहीं हो सकता', 'Шахматка'),
('timeline_not_checked_out_title', 'Не выселены', 'Not checked out', 'चेक-आउट नहीं हुआ', 'Шахматка'),
('timeline_not_checked_out_since', 'выезд был', 'check-out was', 'चेक-आउट था', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
