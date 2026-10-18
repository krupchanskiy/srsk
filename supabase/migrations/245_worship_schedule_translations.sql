-- Сколько человек может утверждать: экран людей предупреждает, когда такой один.
create or replace function worship_approvers_count() returns integer
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select count(*)::integer from (select worship_holders('worship_approve')) t
$$;

revoke all on function worship_approvers_count() from public, anon;
grant execute on function worship_approvers_count() to authenticated;

insert into translations (key, ru, en, hi) values
    ('nav_worship_schedule', 'Расписание', 'Schedule', 'समय-सारणी'),
    ('nav_worship_people',   'Люди отдела', 'Department people', 'विभाग के लोग'),
    ('worship_schedule_title', 'Расписание', 'Schedule', 'समय-सारणी'),
    ('worship_my_duties', 'Ваши ближайшие службы', 'Your next services', 'आपकी अगली सेवाएँ'),
    ('worship_today', 'Сегодня', 'Today', 'आज'),
    ('worship_view_week', 'Неделя', 'Week', 'सप्ताह'),
    ('worship_view_day', 'День', 'Day', 'दिन'),
    ('worship_overrides_title', 'Отклонения дня', 'Day exceptions', 'दिन के अपवाद'),
    ('worship_overrides_hint',
     'Праздник или экадаши — это не второе расписание, а точечная правка: разовая служба либо отметка «сегодня не проводится».',
     'A festival or Ekadasi is not a second schedule but a spot change: a one-off service or a «not held today» mark.',
     'उत्सव या एकादशी दूसरी समय-सारणी नहीं, बल्कि एक बिंदु-परिवर्तन है।'),
    ('worship_services_title', 'Службы', 'Services', 'सेवाएँ'),
    ('worship_services_hint',
     'Службы идут каждый день одним порядком — меняются люди. Пришла зима, сдвинули время: правится здесь.',
     'Services run in the same order every day; only the people change. Winter came and the time shifted: edit it here.',
     'सेवाएँ प्रतिदिन एक ही क्रम में चलती हैं; केवल लोग बदलते हैं।'),
    ('worship_people_title', 'Люди отдела', 'Department people', 'विभाग के लोग'),
    ('worship_people_hint',
     'Берутся из общего справочника ашрама — вторых карточек не заводим. У временного стоит срок участия.',
     'Taken from the ashram directory: no second records. A temporary helper has an end date.',
     'आश्रम की सूची से लिए जाते हैं; अस्थायी सेवक की अवधि दर्ज होती है।'),
    ('worship_tags', 'Теги', 'Tags', 'टैग')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
