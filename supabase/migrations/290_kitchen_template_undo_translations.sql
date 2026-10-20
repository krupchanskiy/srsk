-- 290: надписи окна «Применить шаблон» и плашки «Отменить применение» (миграция 289).
insert into translations (key, ru, en, hi) values
    ('template_overwrite_title', 'Это меню будет заменено шаблоном:', 'This menu will be replaced by the template:', 'यह मेनू टेम्पलेट से बदल दिया जाएगा:'),
    ('template_overwrite_confirm', 'Да, заменить это меню', 'Yes, replace this menu', 'हाँ, यह मेनू बदलें'),
    ('template_applied_undo', 'Заменено приёмов пищи', 'Meals replaced', 'बदले गए भोजन'),
    ('template_undo_hint', 'отменить можно в течение суток', 'can be undone within 24 hours', '24 घंटे के भीतर वापस लिया जा सकता है'),
    ('template_undo_banner', 'Применён шаблон', 'Template applied', 'टेम्पलेट लागू किया गया'),
    ('template_undo_btn', 'Отменить применение', 'Undo template', 'टेम्पलेट वापस लें'),
    ('template_undo_confirm', 'Вернуть меню, каким оно было до шаблона? Всё, что внесли в эти дни после применения, тоже пропадёт.', 'Restore the menu as it was before the template? Anything added to these days after applying will be lost too.', 'मेनू को टेम्पलेट से पहले जैसा लौटाएँ? लागू करने के बाद इन दिनों में जो जोड़ा गया, वह भी हट जाएगा।'),
    ('template_undone', 'Меню возвращено, как было до шаблона', 'Menu restored as it was before the template', 'मेनू टेम्पलेट से पहले जैसा लौटा दिया गया')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
