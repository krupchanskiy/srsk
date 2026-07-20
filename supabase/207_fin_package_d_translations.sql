-- =============================================================
-- Финмодуль UX Пакет D (cutover — справочники): переводы. Кэш: v15 → v16.
-- =============================================================

INSERT INTO translations (key, ru, en, hi) VALUES
('fin_dict_search', 'Поиск по названию или коду…', 'Search by name or code…', 'नाम या कोड से खोजें…'),
('fin_rate_current', 'действует', 'current', 'वर्तमान')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;

-- «Cost centers» → «Центры затрат» (консистентно с ДДС/счетами)
UPDATE translations SET ru = 'Центры затрат', en = 'Cost centers', hi = 'लागत केंद्र' WHERE key = 'fin_dict_cost_centers';
