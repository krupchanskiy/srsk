-- 832: Form III — где живёт у нас, если в шахматке «Самостоятельное проживание»
-- ВГ 26.11: Зябловы в шахматке живут сами, но Form III подаём мы (Вайрагья-ашрам);
-- такое бывает с командой и волонтёрами. Шахматку не трогаем — место хранится в анкете.
alter table public.form3_entries
    add column if not exists building_id uuid references public.buildings(id),
    add column if not exists room_id     uuid references public.rooms(id);

comment on column public.form3_entries.building_id is 'Где живёт у нас для Form III, если в шахматке без жилья (has_housing=false)';
comment on column public.form3_entries.room_id is 'Номер у нас для Form III (необязательно), если в шахматке без жилья';
