-- Подписи страницы «Счёт» департамента (kitchen/account.html, js/pages/dept-account.js)
insert into translations (key, ru, en, hi, context) values
('dacc_p_month', 'Этот месяц', 'This month', 'यह महीना', 'Счёт департамента'),
('dacc_p_prev', 'Прошлый месяц', 'Last month', 'पिछला महीना', 'Счёт департамента'),
('dacc_p_year', 'Этот год', 'This year', 'यह वर्ष', 'Счёт департамента'),
('dacc_p_all', 'Всё время', 'All time', 'पूरा समय', 'Счёт департамента'),
('dacc_p_custom', 'Свои даты', 'Custom dates', 'अपनी तिथियाँ', 'Счёт департамента'),
('dacc_dir_all', 'Приходы, расходы и переводы', 'Income, expenses and transfers', 'आय, व्यय और स्थानांतरण', 'Счёт департамента'),
('dacc_dir_in', 'Только приходы', 'Income only', 'केवल आय', 'Счёт департамента'),
('dacc_dir_out', 'Только расходы', 'Expenses only', 'केवल व्यय', 'Счёт департамента'),
('dacc_dir_transfer', 'Только переводы', 'Transfers only', 'केवल स्थानांतरण', 'Счёт департамента'),
('dacc_search', 'Поиск: комментарий, кто, сумма', 'Search: comment, who, amount', 'खोज: टिप्पणी, कौन, राशि', 'Счёт департамента'),
('dacc_by_filter', 'по фильтру', 'filtered', 'फ़िल्टर के अनुसार', 'Счёт департамента'),
('dacc_storno_hint', 'Отменённые операции и их отмены — вместе дают ноль, в «Пришло» и «Ушло» не входят', 'Cancelled operations and their reversals net to zero and are not included in income or expenses', 'रद्द लेन-देन और उनके उलट मिलकर शून्य होते हैं, आय और व्यय में शामिल नहीं', 'Счёт департамента'),
('dacc_contra', 'Другой счёт', 'Other account', 'दूसरा खाता', 'Счёт департамента'),
('dacc_to', 'куда', 'to', 'कहाँ', 'Счёт департамента'),
('dacc_from', 'откуда', 'from', 'कहाँ से', 'Счёт департамента'),
('dacc_who', 'От кого / кому', 'From / to whom', 'किससे / किसको', 'Счёт департамента'),
('dacc_entered_at', 'Внесено', 'Entered', 'दर्ज किया', 'Счёт департамента'),
('dacc_in_inr', 'В рупиях', 'In rupees', 'रुपये में', 'Счёт департамента'),
('dacc_after_hint', 'Сколько осталось на счёте после этой операции', 'Balance left on the account after this operation', 'इस लेन-देन के बाद खाते में शेष', 'Счёт департамента'),
('dacc_no_accounts', 'У департамента пока нет счёта', 'The department has no account yet', 'विभाग का अभी कोई खाता नहीं है', 'Счёт департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
