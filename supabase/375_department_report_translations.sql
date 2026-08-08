-- Переводы для вкладки «По департаментам» в аналитике
insert into translations (key, ru, en, hi) values
  ('fin_analytics_departments', 'По департаментам', 'By department', 'विभाग अनुसार'),
  ('fin_department', 'Департамент', 'Department', 'विभाग'),
  ('fin_period_quarter', 'Квартал', 'Quarter', 'तिमाही'),
  ('fin_period_year', 'Год', 'Year', 'वर्ष'),
  ('fin_dept_received', 'Получено', 'Received', 'प्राप्त'),
  ('fin_dept_spent', 'Потрачено', 'Spent', 'व्यय'),
  ('fin_dept_balance', 'На руках', 'On hand', 'शेष'),
  ('fin_dept_passed', 'Передано дальше', 'Passed on', 'आगे दिया'),
  ('fin_dept_idle', 'Без движений за период', 'No activity in period', 'अवधि में कोई गतिविधि नहीं'),
  ('fin_dept_no_movements', 'За выбранный период движений по департаментам не было',
   'No department activity in the selected period', 'चयनित अवधि में विभागों की कोई गतिविधि नहीं')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
