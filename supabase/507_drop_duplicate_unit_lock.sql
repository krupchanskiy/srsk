-- Защита от смены единицы продукта с ценами сделана дважды в параллельных чатах:
-- products_unit_lock_trg (504_products_unit_lock_with_prices, остаётся — сообщение с названием
-- продукта и по-английски) и trg_products_lock_unit_when_priced (мой, тот же смысл).
-- Дубль удалён; мой файл 504_products_lock_unit_when_priced.sql убран из репозитория.
drop trigger if exists trg_products_lock_unit_when_priced on public.products;
drop function if exists public.products_lock_unit_when_priced();
