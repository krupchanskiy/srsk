-- 787: пункт меню «Form III» в Ресепшене (ВГ 16.11.2026)
insert into translations (key, ru, en, hi, context) values
('nav_form3', 'Form III', 'Form III', 'फ़ॉर्म III', 'Ресепшен: меню')
on conflict (key) do nothing;
