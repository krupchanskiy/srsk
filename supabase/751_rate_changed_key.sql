-- 751: подсказка у действующего общего курса — когда сменился и какой был (ВГ 24.10)
-- «было» из 750 не нужно: показываем прошлое другое значение, а не повтор того же числа
insert into translations (key, ru, en, hi, page) values
  ('fin_rate_changed', 'изменился {date}, было {rate}', 'changed {date}, was {rate}', '{date} को बदला, पहले {rate}', 'Справочники')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
delete from translations where key = 'fin_rate_prev';
