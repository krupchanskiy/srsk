-- Удаляем пустые нерабочие заготовки цен: их заменила kitchen_prices (480).
-- price_history: 0 строк, ни представлений, ни функций, ни внешних ключей на неё.
-- products.price_min / price_max: ни у одного продукта не заполнены,
-- в рабочем коде не использовались (только фейковые данные в Прототипы/).
-- Копия до удаления: схема backup_20260921 (price_history, products).
drop table public.price_history;
alter table public.products drop column price_min, drop column price_max;
