-- 820: признак «Внутренний проект ШРСК» у ретрита (ВГ 20.11.2026)
-- Ретрит, который ШРСК делает для себя и финансирует сам (например, «Ретрит Художников»).
-- В «Расписании» такие ретриты выделены своим цветом. Внутренний и сторонний одновременно — нельзя.
alter table public.retreats add column is_internal boolean not null default false;
alter table public.retreats add constraint retreats_internal_not_external check (not (is_internal and is_external));

-- Оба «Ретрита Художников» (2026-08-02 и 2026-12-07)
update public.retreats set is_internal = true
 where id in ('a25b2062-e76f-4a2a-a9ff-870eb87d5845', '75826808-76b4-4b9b-bace-1d70140fe30c');

insert into translations (key, ru, en, hi, context) values
('retreats_is_internal', 'Внутренний проект ШРСК', 'Internal SRSK project', 'SRSK की आंतरिक परियोजना', 'Ретриты'),
('retreats_is_internal_hint', 'ШРСК делает его для себя и финансирует сам (например, «Ретрит Художников»). В «Расписании» выделен своим цветом',
 'SRSK runs and funds it itself (e.g. the Artists'' Retreat). Shown in its own colour in the Schedule',
 'SRSK इसे स्वयं चलाता और वित्तपोषित करता है (जैसे कलाकार रिट्रीट)। कार्यक्रम में अलग रंग में दिखता है', 'Ретриты'),
('rc_internal', 'внутренний', 'internal', 'आंतरिक', 'Календарь ретритов')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
