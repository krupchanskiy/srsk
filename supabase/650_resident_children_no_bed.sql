-- 650: ребёнок без своей кровати — «+1» к месту родителя (ВГ, 08.10.2026, «Шахматка 9»).
-- Малыш живёт с мамой: отметка на её полосе в шахматке, кровать не занимает, номер не
-- переполнен, в начислении номер не дорожает — такие дети лежат отдельно от residents,
-- поэтому вместимость, соседи по номеру (fin_group_get, окна начисления) и брони их не видят.
-- Кухня: ребёнок ест в дни родителя и с его галочками; младше 7 лет — не порция,
-- без даты рождения — как взрослый (расчёт — 651). Карточка ребёнка — желательно; без карточки — имя и
-- дата рождения прямо здесь.

create table if not exists public.resident_children (
    id uuid primary key default gen_random_uuid(),
    resident_id uuid not null references public.residents(id) on delete cascade,
    vaishnava_id uuid references public.vaishnavas(id) on delete set null,
    guest_name text,
    birth_date date,
    created_at timestamptz not null default now(),
    created_by uuid default auth.uid(),
    constraint resident_children_who check (vaishnava_id is not null or nullif(btrim(guest_name), '') is not null)
);
create unique index if not exists resident_children_resident_vaishnava
    on public.resident_children(resident_id, vaishnava_id) where vaishnava_id is not null;
create index if not exists resident_children_vaishnava on public.resident_children(vaishnava_id);

alter table public.resident_children enable row level security;
create policy "Staff manage resident children" on public.resident_children
    for all to authenticated
    using (is_staff((select auth.uid())))
    with check (is_staff((select auth.uid())));

comment on table public.resident_children is
    'Дети без своей кровати при месте родителя («+1» в шахматке). Кровать не занимают, в начислении номера не участвуют; кухня — по eating_detail (до 7 лет не порция).';

insert into translations (key, ru, en, hi, context) values
('timeline_kids_no_bed', 'Дети без кровати', 'Children without a bed', 'बिना बिस्तर के बच्चे', 'Шахматка'),
('timeline_add_kid_no_bed', '+ ребёнок (без кровати)', '+ child (no bed)', '+ बच्चा (बिना बिस्तर)', 'Шахматка'),
('timeline_kid_hint', 'Живёт с родителем, кровать не занимает; кухня: до 7 лет не порция', 'Lives with the parent, takes no bed; kitchen: under 7 is not a portion', 'माता-पिता के साथ रहता है, बिस्तर नहीं; रसोई: 7 वर्ष से कम — भाग नहीं', 'Шахматка'),
('timeline_kid_family', 'Из семьи', 'Family', 'परिवार से', 'Шахматка'),
('timeline_kid_search', 'Найти карточку ребёнка…', 'Find the child''s card…', 'बच्चे का कार्ड खोजें…', 'Шахматка'),
('timeline_kid_no_card', 'Без карточки', 'Without a card', 'कार्ड के बिना', 'Шахматка'),
('timeline_kid_name', 'Имя ребёнка', 'Child''s name', 'बच्चे का नाम', 'Шахматка'),
('timeline_kid_birth', 'Дата рождения', 'Date of birth', 'जन्म तिथि', 'Шахматка'),
('timeline_kid_remove', 'Убрать ребёнка', 'Remove child', 'बच्चा हटाएँ', 'Шахматка'),
('prasad_child_no_birth', 'Детское питание без даты рождения', 'Child meals without a date of birth', 'जन्म तिथि के बिना बाल भोजन', 'Прасад'),
('prasad_child_no_birth_hint', 'кухня считает их как взрослых; до 7 лет ребёнок не порция', 'the kitchen counts them as adults; under 7 a child is not a portion', 'रसोई उन्हें वयस्क मानती है; 7 वर्ष से कम बच्चा भाग नहीं', 'Прасад')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
