-- Переводы блоков «Расходы без назначения» и «Группы статей» на экране кухни (см. 489)
insert into translations (key, ru, en, hi, context) values
('cost_unassigned_title', 'Расходы без назначения', 'Expenses without destination', 'बिना गंतव्य वाले खर्च', 'Кухня → Себестоимость'),
('cost_unassigned_hint', 'Расходы кухни по статьям «на ретрит» (билеты, виза, гонорары, программа), которые не привязаны к ретриту. Выберите: общие расходы кухни или период работы человека, тогда расход разделится между событиями периода. Чтобы привязать к одному ретриту, используйте «Уточнить выдачу» в финансах.', 'Kitchen expenses in retreat-type categories (tickets, visa, fees, program) that are not linked to a retreat. Choose general kitchen expenses or the person''s working period, then the cost is split among events in that period. To link to a single retreat use "Refine" in finance.', 'रिट्रीट-प्रकार की श्रेणियों (टिकट, वीज़ा, मानदेय, कार्यक्रम) के रसोई खर्च जो किसी रिट्रीट से जुड़े नहीं हैं। सामान्य रसोई खर्च या व्यक्ति की कार्य-अवधि चुनें, तब खर्च उस अवधि के आयोजनों में बँट जाएगा।', 'Кухня → Себестоимость'),
('cost_dest_general', 'Общие расходы', 'General expenses', 'सामान्य खर्च', 'Кухня → Себестоимость'),
('cost_dest_period', 'Период работы', 'Working period', 'कार्य-अवधि', 'Кухня → Себестоимость'),
('cost_groups_title', 'Группы статей расходов кухни', 'Kitchen expense category groups', 'रसोई खर्च श्रेणी समूह', 'Кухня → Себестоимость'),
('cost_groups_hint', 'Как статья попадает в себестоимость. Статья без подтверждённой группы считается «общей» и помечена: подтвердите группу.', 'How a category enters the cost. A category without a confirmed group is treated as "general" and highlighted: confirm the group.', 'श्रेणी लागत में कैसे शामिल होती है। पुष्ट समूह के बिना श्रेणी को «सामान्य» माना जाता है और चिह्नित की जाती है: समूह की पुष्टि करें।', 'Кухня → Себестоимость'),
('cost_group_direct', 'Прямые (сверка с ДДС)', 'Direct (reconciled with cash flow)', 'प्रत्यक्ष (नकदी प्रवाह से मिलान)', 'Кухня → Себестоимость'),
('cost_group_retreat', 'На ретрит', 'Retreat-specific', 'रिट्रीट के लिए', 'Кухня → Себестоимость'),
('cost_group_general', 'Общие', 'General', 'सामान्य', 'Кухня → Себестоимость'),
('cost_group_excluded', 'Не учитывать', 'Excluded', 'गणना में नहीं', 'Кухня → Себестоимость'),
('cost_group_unconfirmed', 'не подтверждено', 'unconfirmed', 'अपुष्ट', 'Кухня → Себестоимость'),
('cost_group_unconfirmed_opt', '— не подтверждена —', '— unconfirmed —', '— अपुष्ट —', 'Кухня → Себестоимость')
on conflict (key) do nothing;
