-- =============================================================
-- Финмодуль UX Пакет B (журнал ДДС): переводы. Кэш: v13 → v14.
-- =============================================================

INSERT INTO translations (key, ru, en, hi) VALUES
('fin_filter_all_categories', 'Все статьи', 'All categories', 'सभी श्रेणियाँ'),
('fin_period', 'Период', 'Period', 'अवधि'),
('fin_period_today', 'Сегодня', 'Today', 'आज'),
('fin_period_week', 'Неделя', 'Week', 'सप्ताह'),
('fin_period_month', 'Месяц', 'Month', 'महीना'),
('fin_period_all', 'Всё', 'All', 'सभी'),
('fin_search_placeholder2', 'Комментарий, плательщик или сумма…', 'Comment, payer or amount…', 'टिप्पणी, भुगतानकर्ता या राशि…'),
('fin_by_selection', 'Итог по выборке', 'Selection total', 'चयन योग'),
('fin_created_by', 'Создал', 'Created by', 'द्वारा बनाया'),
('fin_repeat', 'Повторить', 'Repeat', 'दोहराएं')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
