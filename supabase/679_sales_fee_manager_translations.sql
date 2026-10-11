-- 676: переводы для разбивки «Процента отделу продаж» по менеджерам (миграция 675)
insert into translations (key, ru, en, hi) values
  ('fin_sales_fee_col_manager', 'Менеджер', 'Manager', 'प्रबंधक'),
  ('fin_sales_fee_by_manager', 'По менеджерам', 'By manager', 'प्रबंधक अनुसार'),
  ('fin_sales_fee_no_manager', 'Без менеджера', 'No manager', 'प्रबंधक नहीं')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
