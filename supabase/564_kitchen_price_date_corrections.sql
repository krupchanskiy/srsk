-- Журнал исправлений цен: кроме суммы — и дата начала действия (было с / стало с).
-- 27.09.2026 по решению ВГ 223 цены, внесённые 26.09 с датой «действует с 26.09»,
-- перенесены на начало работы системы 05.08.2026 (данные — отдельным действием, с записью в журнал).
alter table public.kitchen_price_corrections
  add column if not exists old_valid_from date,
  add column if not exists new_valid_from date;
comment on column public.kitchen_price_corrections.old_valid_from is 'Исправление даты начала действия цены: было с';
comment on column public.kitchen_price_corrections.new_valid_from is 'Исправление даты начала действия цены: стало с';
