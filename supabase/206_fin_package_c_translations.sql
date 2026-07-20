-- =============================================================
-- Финмодуль UX Пакет C (день заезда — участники): переводы. Кэш: v14 → v15.
-- =============================================================

INSERT INTO translations (key, ru, en, hi) VALUES
('fin_search_name', 'Поиск по имени…', 'Search by name…', 'नाम से खोजें…'),
('fin_filter_all', 'Все', 'All', 'सभी'),
('fin_advances', 'Авансы', 'Advances', 'अग्रिम'),
('fin_nothing_found', 'Ничего не найдено', 'Nothing found', 'कुछ नहीं मिला'),
('fin_copy_summary', 'Скопировать сводку', 'Copy summary', 'सारांश कॉपी करें'),
('fin_settled', 'Расчёт закрыт', 'Settled', 'निपटान पूर्ण'),
('fin_copied', 'Скопировано', 'Copied', 'कॉपी किया गया'),
('fin_copy_failed', 'Не удалось скопировать', 'Copy failed', 'कॉपी विफल')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
