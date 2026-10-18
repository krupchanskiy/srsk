-- 710: «Прасад — пожертвование» — статья выручки Кухни (ВГ 19.10): пожертвования за прасад,
-- сданные в Кассу или Гест-хаус, видны на странице Кухни в «Заработал».
insert into fin_department_income_categories (department_id, category_id)
select d.id, c.id from fin_departments d join fin_categories c on c.code = 'Prasad_donation'
 where d.code = 'kitchen'
on conflict do nothing;
