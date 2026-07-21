-- UX 7.2: перевод подсказки клика по статье в аналитике. Кэш: v16 → v17.
INSERT INTO translations (key, ru, en, hi) VALUES
('fin_open_in_dds', 'Открыть операции по этой статье в ДДС', 'Open this category''s operations in the journal', 'इस श्रेणी के लेनदेन पत्रिका में खोलें')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
