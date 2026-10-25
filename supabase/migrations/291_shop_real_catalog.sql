-- 291: настоящий ассортимент магазина вместо тестового (решение Адриана 25.10.2026).
-- Источник — «Перечень товаров ШРСК.pages»: 48 товаров, название, цена закупки,
-- цена продажи, у пяти пометка «Реализация».
--
-- • Тестовое удаляется целиком: товары, группы, поставки, партии, чеки, смены,
--   сдача, инвентаризация, списание, тестовый владелец. Проводок в финансах у
--   тестовых смен и сдачи не было. Тестовый поставщик в fin_contractors
--   остаётся — это раздел ВГ. Цели пожертвований (shop_goals) не трогаем.
-- • Нумерация поставок, чеков и инвентаризаций — с единицы.
-- • Цена закупки в магазине живёт у партии (вводится при приёме), у товара
--   её нет — в этой миграции она только в комментарии к каждой строке.
-- • source: 'own' — Госвами сеты (выпуск Мастерской), остальное — чужой товар
--   (на реализацию или закупка решается при приёме партии).

truncate shop_sale_items, shop_returns, shop_sales, shop_cash_counts, shop_float_log,
         shop_handover_lines, shop_shifts, shop_handovers, shop_writeoffs,
         shop_inventory_items, shop_inventories, shop_owner_returns, shop_settlements,
         shop_batches, shop_receipt_items, shop_receipts, shop_items, shop_owners,
         shop_categories;

alter sequence shop_receipt_number_seq restart with 1;
alter sequence shop_sale_number_seq restart with 1;
alter sequence shop_inventory_number_seq restart with 1;

with группы(ключ, name_ru, name_en, name_hi, sort_order) as (values
    ('japa', 'Чётки и кантхималы', 'Japa beads & kanthi', 'जप माला और कंठी', 10),
    ('altar', 'Для алтаря', 'For the altar', 'वेदी के लिए', 20),
    ('murti', 'Мурти', 'Murti', 'मूर्ति', 30),
    ('bhoga', 'Бхога', 'Bhoga', 'भोग', 40),
    ('clothes', 'Одежда и текстиль', 'Clothing & textiles', 'वस्त्र', 50),
    ('jewel', 'Украшения', 'Jewellery', 'आभूषण', 60),
    ('souv', 'Сувениры', 'Souvenirs', 'स्मृति-चिह्न', 70),
    ('books', 'Книги', 'Books', 'पुस्तकें', 80)
),
вставлены as (
    insert into shop_categories (name_ru, name_en, name_hi, sort_order)
    select name_ru, name_en, name_hi, sort_order from группы
    returning id, name_ru
),
товары(ключ, name_ru, name_en, translit, price, source) as (values
    ('japa', 'Чётки Госвами', 'Goswami japa beads', 'chetki gosvami', 6000, 'consignment'),  -- закупка 1500
    ('japa', 'Чётки маленькие', 'Japa beads, small', 'chetki malenkie', 1000, 'consignment'),  -- закупка 200
    ('japa', 'Чётки средние', 'Japa beads, medium', 'chetki srednie', 2500, 'consignment'),  -- закупка 300
    ('souv', 'Значок ШРСК белый', 'SRSK badge, white', 'znachok shrsk belyy', 200, 'consignment'),  -- закупка не указана
    ('souv', 'Значок ШРСК чёрный', 'SRSK badge, black', 'znachok shrsk chernyy', 200, 'consignment'),  -- закупка не указана
    ('souv', 'Значок Мадхьяма', 'Madhyama badge', 'znachok madhyama', 300, 'consignment'),  -- закупка 110
    ('souv', 'Стикеры большие', 'Stickers, large', 'stikery bolshie', 400, 'consignment'),  -- закупка 67
    ('souv', 'Стикеры средние', 'Stickers, medium', 'stikery srednie', 300, 'consignment'),  -- закупка не указана
    ('souv', 'Стикеры маленькие', 'Stickers, small', 'stikery malenkie', 200, 'consignment'),  -- закупка не указана
    ('clothes', 'Маска для сна', 'Sleep mask', 'maska dlya sna', 1400, 'consignment'),  -- закупка 650
    ('souv', 'Фото в рамочке', 'Framed photo', 'foto v ramochke', 1500, 'consignment'),  -- закупка не указана
    ('clothes', 'Футболка с печатью', 'Printed T-shirt', 'futbolka s pechatyu', 3000, 'consignment'),  -- закупка 490
    ('clothes', 'Футболка с тилакой', 'Tilak T-shirt', 'futbolka s tilakoy', 2500, 'consignment'),  -- закупка не указана
    ('clothes', 'Футболка monkey', 'Monkey T-shirt', 'futbolka monkey', 2500, 'consignment'),  -- закупка 570
    ('clothes', 'Шоппер', 'Tote bag', 'shopper', 1500, 'consignment'),  -- закупка 93
    ('souv', 'Сердечко из навоза', 'Cow-dung heart', 'serdechko iz navoza', 200, 'consignment'),  -- закупка не указана
    ('altar', 'Светильник', 'Lamp', 'svetilnik', 1800, 'consignment'),  -- закупка не указана
    ('souv', 'Кружка ШРСК', 'SRSK mug', 'kruzhka shrsk', 1000, 'consignment'),  -- закупка не указана
    ('clothes', 'Гамча', 'Gamcha', 'gamcha', 400, 'consignment'),  -- закупка 100
    ('altar', 'Зайчик для алтаря', 'Altar bunny', 'zaychik dlya altarya', 300, 'consignment'),  -- закупка не указана
    ('altar', 'Телёнок для алтаря', 'Altar calf', 'telenok dlya altarya', 300, 'consignment'),  -- закупка не указана
    ('japa', 'Мешочек для джапы', 'Japa bag', 'meshochek dlya dzhapy', 600, 'consignment'),  -- закупка 100
    ('altar', 'Посуда для Божеств L', 'Deity dishes, L', 'posuda dlya bozhestv l', 1500, 'consignment'),  -- закупка 550
    ('altar', 'Посуда для Божеств M', 'Deity dishes, M', 'posuda dlya bozhestv m', 1200, 'consignment'),  -- закупка 445
    ('altar', 'Посуда для Божеств S', 'Deity dishes, S', 'posuda dlya bozhestv s', 900, 'consignment'),  -- закупка 300
    ('altar', 'Посуда для прасада M', 'Prasadam dishes, M', 'posuda dlya prasada m', 1100, 'consignment'),  -- закупка 420
    ('altar', 'Посуда для прасада S', 'Prasadam dishes, S', 'posuda dlya prasada s', 900, 'consignment'),  -- закупка 320
    ('souv', 'Мыло', 'Soap', 'mylo', 400, 'consignment'),  -- закупка не указана
    ('altar', 'Благовония', 'Incense', 'blagovoniya', 600, 'consignment'),  -- закупка 120
    ('japa', 'Счётчики', 'Japa counters', 'schetchiki', 600, 'consignment'),  -- закупка 300, «Реализация»
    ('altar', 'Фитильки', 'Lamp wicks', 'fitilki', 200, 'consignment'),  -- закупка 100, «Реализация»
    ('bhoga', 'Бхога микс', 'Bhoga mix', 'bhoga miks', 250, 'consignment'),  -- закупка не указана
    ('bhoga', 'Бхога изюм', 'Bhoga raisins', 'bhoga izyum', 150, 'consignment'),  -- закупка не указана
    ('bhoga', 'Бхога лотос', 'Bhoga lotus', 'bhoga lotos', 100, 'consignment'),  -- закупка не указана
    ('murti', 'Госвами сет L', 'Goswami set, L', 'gosvami set l', 300000, 'own'),  -- закупка не указана
    ('murti', 'Госвами сет M', 'Goswami set, M', 'gosvami set m', 230000, 'own'),  -- закупка не указана
    ('murti', 'Госвами сет S', 'Goswami set, S', 'gosvami set s', 15000, 'own'),  -- закупка не указана
    ('altar', 'Мудгара M', 'Mudgara, M', 'mudgara m', 5000, 'consignment'),  -- закупка 2500, «Реализация»
    ('altar', 'Мудгара S', 'Mudgara, S', 'mudgara s', 30000, 'consignment'),  -- закупка 1500, «Реализация»
    ('books', 'Книга ГВПД', 'Book GVPD', 'kniga gvpd', 500, 'consignment'),  -- закупка не указана
    ('japa', 'Кантхималы, средний цилиндр, 3 ряда', 'Kanthi mala, medium cylinder, 3 strands', 'kanthimaly sredniy tsilindr 3 ryada', 800, 'consignment'),  -- закупка 200
    ('japa', 'Кантхималы «семена лотоса», маленькие, 3 ряда', 'Kanthi mala "lotus seeds", small, 3 strands', 'kanthimaly semena lotosa malenkie 3 ryada', 900, 'consignment'),  -- закупка 250
    ('japa', 'Кантхималы закруглённые аутентичные, маленькие, 3 ряда', 'Kanthi mala, rounded authentic, small, 3 strands', 'kanthimaly zakruglennye autentichnye malenkie 3 ryada', 900, 'consignment'),  -- закупка 250
    ('japa', 'Кантхималы «Радха», супер маленькие, 3 ряда', 'Kanthi mala "Radha", extra small, 3 strands', 'kanthimaly radha super malenkie 3 ryada', 3000, 'consignment'),  -- закупка 1500
    ('jewel', 'Серьги Туласи', 'Tulasi earrings', 'sergi tulasi', 800, 'consignment'),  -- закупка 400
    ('jewel', 'Серьги Туласи, гвоздики большие', 'Tulasi stud earrings, large', 'sergi tulasi gvozdiki bolshie', 500, 'consignment'),  -- закупка 100
    ('jewel', 'Серьги Туласи, гвоздики маленькие', 'Tulasi stud earrings, small', 'sergi tulasi gvozdiki malenkie', 400, 'consignment'),  -- закупка 50
    ('clothes', 'Панама', 'Bucket hat', 'panama', 700, 'consignment')  -- закупка 350
)
insert into shop_items (category_id, name_ru, name_en, translit, unit, price, source)
select в.id, т.name_ru, т.name_en, т.translit, 'шт', т.price, т.source
  from товары т
  join группы г on г.ключ = т.ключ
  join вставлены в on в.name_ru = г.name_ru;
