-- 759: подписи выгрузки Себестоимости в Excel
insert into translations (key, ru, en, hi, context) values
('cost_x_category', 'Категория', 'Category', 'श्रेणी', 'Кухня: Себестоимость / Excel'),
('cost_x_why', 'Почему здесь', 'Why here', 'यहाँ क्यों', 'Кухня: Себестоимость / Excel'),
('cost_x_direction', 'Куда', 'Direction', 'दिशा', 'Кухня: Себестоимость / Excel'),
('cost_x_operation', 'Операция', 'Operation', 'लेन-देन', 'Кухня: Себестоимость / Excel'),
('cost_x_details', 'Подробности', 'Details', 'विवरण', 'Кухня: Себестоимость / Excel'),
('cost_x_foreign', 'В валюте', 'In currency', 'मुद्रा में', 'Кухня: Себестоимость / Excel'),
('cost_x_overhead_sheet', 'Зарплаты и хозрасходы', 'Salaries and overheads', 'वेतन और घरेलू खर्च', 'Кухня: Себестоимость / Excel'),
('cost_x_money_sheet', 'Деньги за прасад', 'Money for prasad', 'प्रसाद की राशि', 'Кухня: Себестоимость / Excel'),
('cost_x_file', 'Себестоимость', 'Prasad cost', 'प्रसाद लागत', 'Кухня: Себестоимость / Excel')
on conflict (key) do nothing;
