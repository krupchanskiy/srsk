-- Пожертвования, собранные в магазине, — отдельная категория дохода.
-- С существующей «Пожертвование на деревья» (tree_donation) их не смешиваем:
-- ту ведёт казначей вручную по своим сборам, и смешение испортит обе картины.
-- Цель сбора (деревья, прасад, храм) остаётся внутри магазина, в чеке.
insert into fin_categories (code, name, direction, visible_to_departments, is_active)
values ('shop_donation', 'Пожертвования в магазин', 'in', true, true)
on conflict (code) do update set name = excluded.name, is_active = true;
