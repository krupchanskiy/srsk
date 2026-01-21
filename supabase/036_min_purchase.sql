-- ============================================
-- МИНИМАЛЬНАЯ ЗАКУПКА ДЛЯ ПРОДУКТОВ
-- ============================================

-- Добавляем поле min_purchase в products (в граммах/мл/штуках)
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_purchase INTEGER DEFAULT NULL;

-- Комментарий
COMMENT ON COLUMN products.min_purchase IS 'Минимальное количество для закупки (в базовых единицах: г/мл/шт)';

-- Переводы
INSERT INTO translations (key, ru, en, hi, page, context) VALUES
('min_purchase_tab', 'Мин. закупка', 'Min Purchase', 'न्यूनतम खरीद', 'stock', 'Таб'),
('min_purchase_title', 'Минимальная закупка', 'Minimum Purchase', 'न्यूनतम खरीद', 'stock', 'Заголовок'),
('min_purchase_desc', 'Минимальное количество продукта, которое можно закупить', 'Minimum quantity of product that can be purchased', 'उत्पाद की न्यूनतम मात्रा जो खरीदी जा सकती है', 'stock', 'Описание'),
('min_purchase_hint', 'Заявки будут округляться до этого значения', 'Requests will be rounded to this value', 'अनुरोध इस मूल्य तक पूर्णांकित किए जाएंगे', 'stock', 'Подсказка'),
('sort_priority', 'По важности', 'By priority', 'प्राथमिकता के अनुसार', 'common', 'Сортировка'),
('sort_name_asc', 'А → Я', 'A → Z', 'अ → ज्ञ', 'common', 'Сортировка'),
('sort_name_desc', 'Я → А', 'Z → A', 'ज्ञ → अ', 'common', 'Сортировка'),
('in_progress', 'В работе', 'In progress', 'प्रगति में', 'common', 'Статус заявки'),
('request_in_progress', 'Заявка в работе', 'Request in progress', 'अनुरोध प्रगति में है', 'stock', 'Статус заявки')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    page = excluded.page,
    context = excluded.context;
