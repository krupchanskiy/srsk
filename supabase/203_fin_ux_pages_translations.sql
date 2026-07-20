-- =============================================================
-- Финмодуль: переводы UX-доводки остальных страниц (счета, аналитика,
-- входящие, сверка, справочники). Кэш переводов: v11 → v12.
-- =============================================================

INSERT INTO translations (key, ru, en, hi) VALUES
('fin_total_balance', 'Итого остаток', 'Total balance', 'कुल शेष'),
('fin_accounts_count', 'Счетов', 'Accounts', 'खाते'),
('fin_expand_details', 'Показать проводки', 'Show postings', 'लेनदेन दिखाएं'),
('fin_recon_select_hint', 'Выберите счёт сверху, чтобы начать сверку', 'Select an account above to start reconciliation', 'मिलान शुरू करने के लिए ऊपर खाता चुनें'),
('fin_performed_by', 'Кто', 'By', 'किसने'),
('fin_dict_empty', 'Пока пусто', 'Nothing here yet', 'अभी कुछ नहीं')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;

-- «Cost center» → «Центр затрат» для консистентности (как в ДДС)
UPDATE translations SET ru = 'Центр затрат по умолчанию', en = 'Default cost center', hi = 'डिफ़ॉल्ट लागत केंद्र'
WHERE key = 'fin_default_cost_center';
