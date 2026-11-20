-- 822: строка «Club108» в Расписании — паломничества и путешествия клуба (ВГ 20.11.2026)
alter table public.retreat_plans drop constraint retreat_plans_kind_check;
alter table public.retreat_plans add constraint retreat_plans_kind_check check (kind in ('event', 'guru', 'club', 'note'));

-- Маяпур-ятра — поездка клуба, а не выезд Махараджа
update public.retreat_plans set kind = 'club', maharaja_id = null
 where id = 'f87b9440-5cf5-4963-85a0-9b42216155d3' and kind = 'guru';

insert into translations (key, ru, en, hi, context) values
('rc_kind_club', 'Club108 — паломничество / путешествие', 'Club108 — pilgrimage / trip', 'Club108 — तीर्थयात्रा / यात्रा', 'Календарь ретритов: вид'),
('rc_row_club', 'Club108', 'Club108', 'Club108', 'Календарь ретритов')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
