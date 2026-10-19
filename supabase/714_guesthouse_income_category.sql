-- 714: выручка Гест-хауса — пока только «Оплата проживания (вне ретритов)» (ВГ 19.10)
insert into fin_department_income_categories (department_id, category_id)
select d.id, c.id from fin_departments d join fin_categories c on c.code = 'accommodation_payment'
 where d.code = 'guesthouse'
on conflict do nothing;
