-- ============================================
-- ТЕСТОВЫЕ ДАННЫЕ ДЛЯ СКЛАДА
-- ============================================

-- Сначала добавим закупщиков
insert into buyers (name, phone, notes) values
('Рамеш', '+91 98765 43210', 'Основной закупщик, рынок Лой Базар'),
('Виджай', '+91 87654 32109', 'Оптовые закупки'),
('Сурен', '+91 76543 21098', 'Специи и масла')
on conflict do nothing;

-- Получаем ID основной локации
do $$
declare
    loc_id uuid;
begin
    select id into loc_id from locations where slug = 'main' limit 1;

    if loc_id is null then
        raise exception 'Location "main" not found';
    end if;

    -- Очищаем старые тестовые данные
    delete from stock where location_id = loc_id;

    -- Добавляем остатки на склад
    -- Овощи (некоторые в норме, некоторые критично)
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 25, 10, 'Рынок Лой Базар, Рамеш', 30
    from products where name_ru = 'Картофель';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 8, 5, 'Рынок Лой Базар', 25
    from products where name_ru = 'Лук репчатый';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 3, 5, 'Рынок Лой Базар', 35
    from products where name_ru = 'Морковь';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 2, 8, null, 40
    from products where name_ru = 'Томаты';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 4, 3, null, 30
    from products where name_ru = 'Огурцы';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 12, 5, null, 20
    from products where name_ru = 'Капуста';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 6, 3, null, 45
    from products where name_ru = 'Цветная капуста';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 1.5, 2, null, 40
    from products where name_ru = 'Имбирь';

    -- Крупы
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 45, 20, 'Оптовый склад, Джайпур Роуд', 65
    from products where name_ru = 'Рис басмати';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 15, 20, 'Оптовый склад', 35
    from products where name_ru = 'Пшеничная мука';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 8, 5, null, 55
    from products where name_ru = 'Манка (суджи)';

    -- Бобовые
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 18, 10, 'Шарма Трейдерс', 120
    from products where name_ru = 'Мунг дал';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 8, 10, 'Шарма Трейдерс', 95
    from products where name_ru = 'Чана дал';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 12, 8, 'Шарма Трейдерс', 110
    from products where name_ru = 'Тур дал';

    -- Молочное
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 20, 15, 'Молочная ферма, ежедневная доставка', 60
    from products where name_ru = 'Молоко';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 5, 3, 'Молочная ферма', 320
    from products where name_ru = 'Панир';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 8, 5, 'Патанджали', 550
    from products where name_ru = 'Гхи';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 10, 5, 'Молочная ферма', 50
    from products where name_ru = 'Йогурт (дахи)';

    -- Специи
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 2, 1, 'Магазин специй', 180
    from products where name_ru = 'Куркума';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 1.5, 1, 'Магазин специй', 220
    from products where name_ru = 'Кумин (зира)';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 0.8, 1, 'Магазин специй', 200
    from products where name_ru = 'Кориандр молотый';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 0.5, 0.5, 'Магазин специй', 350
    from products where name_ru = 'Гарам масала';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 0.3, 0.5, 'Магазин специй', 280
    from products where name_ru = 'Красный чили';

    -- Масла
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 15, 10, 'Фортуна Ойл', 140
    from products where name_ru = 'Подсолнечное масло';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 5, 3, 'Фортуна Ойл', 180
    from products where name_ru = 'Горчичное масло';

    -- Прочее
    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 25, 15, null, 45
    from products where name_ru = 'Сахар';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 10, 5, null, 22
    from products where name_ru = 'Соль';

    insert into stock (location_id, product_id, current_quantity, min_quantity, supplier, last_price)
    select loc_id, id, 3, 2, null, 250
    from products where name_ru = 'Мёд';

end $$;

-- Проверяем результат
select
    p.name_ru as product,
    pc.name_ru as category,
    s.current_quantity,
    s.min_quantity,
    case
        when s.current_quantity < s.min_quantity then 'КРИТИЧНО'
        when s.current_quantity < s.min_quantity * 1.5 then 'Заканчивается'
        else 'OK'
    end as status,
    s.last_price
from stock s
join products p on p.id = s.product_id
join product_categories pc on pc.id = p.category_id
order by
    case
        when s.current_quantity < s.min_quantity then 1
        when s.current_quantity < s.min_quantity * 1.5 then 2
        else 3
    end,
    pc.sort_order,
    p.name_ru;
