-- Переводы для выбора департаментов и подписи периода в отчёте
insert into translations (key, ru, en, hi) values
  ('fin_dept_included', 'Учтено департаментов', 'Departments included', 'शामिल विभाग'),
  ('fin_of', 'из', 'of', 'में से'),
  ('fin_pick_all', 'Все', 'All', 'सभी'),
  ('fin_pick_none', 'Никого', 'None', 'कोई नहीं'),
  ('fin_dept_none_picked', 'Не выбран ни один департамент',
   'No departments selected', 'कोई विभाग चयनित नहीं')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
