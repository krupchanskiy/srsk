-- Кнопка «Выбрать» — свой диапазон дат в отчёте по департаментам
insert into translations (key, ru, en, hi) values
  ('fin_period_custom', 'Выбрать', 'Custom', 'चुनें')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
