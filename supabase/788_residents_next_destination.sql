-- 788: Form III — «куда едет» при выселении иностранца (ВГ 17.11)
-- Выселяет ресепшен (не суперпользователь), поэтому поле в residents, а не в form3_entries.
-- Время отъезда — существующее residents.departure_time.
alter table public.residents add column if not exists next_destination text;
comment on column public.residents.next_destination is 'Куда едет после ШРСК (Form III, Next Destination) — вписывает ресепшен при выселении иностранца';
