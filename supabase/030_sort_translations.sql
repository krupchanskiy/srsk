-- ============================================
-- ПЕРЕВОДЫ ДЛЯ СОРТИРОВКИ
-- ============================================

insert into translations (key, ru, en, hi, context) values
('sort_name_asc', 'А → Я', 'A → Z', 'अ → ज्ञ', 'Сортировка'),
('sort_name_desc', 'Я → А', 'Z → A', 'ज्ञ → अ', 'Сортировка'),
('sort_category', 'По категории', 'By Category', 'श्रेणी के अनुसार', 'Сортировка')

on conflict (key) do update set
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
