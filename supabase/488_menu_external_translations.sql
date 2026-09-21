-- Переводы строки «Готовое со стороны» в меню (см. 486)
insert into translations (key, ru, en, hi, context) values
('menu_external_title', 'Готовое со стороны', 'Ready-made from outside', 'बाहर से तैयार', 'Меню → готовое со стороны'),
('menu_external_add', 'Готовое со стороны', 'Ready-made from outside', 'बाहर से तैयार', 'Меню → готовое со стороны'),
('menu_external_name', 'Что куплено', 'What was bought', 'क्या खरीदा गया', 'Меню → готовое со стороны'),
('menu_external_amount', 'Сумма по факту оплаты, ₹', 'Amount actually paid, ₹', 'वास्तव में भुगतान की गई राशि, ₹', 'Меню → готовое со стороны'),
('menu_external_confirm', 'Удалить строку «Готовое со стороны»?', 'Delete the ready-made item?', 'क्या «बाहर से तैयार» पंक्ति हटाएँ?', 'Меню → готовое со стороны')
on conflict (key) do nothing;
