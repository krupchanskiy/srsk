-- =============================================================
-- Финмодуль UX Пакет A (ежедневный ритуал сверки): переводы.
-- Кэш переводов: v12 → v13.
-- =============================================================

INSERT INTO translations (key, ru, en, hi) VALUES
('fin_recon_saved_ok', 'Сверено', 'Reconciled', 'मिलान हुआ'),
('fin_recon_saved_adj', 'Сверено, создана корректировка', 'Reconciled, adjustment created', 'मिलान हुआ, समायोजन बना'),
('fin_recon_streak', '{n} чекпоинтов подряд без расхождений', '{n} checkpoints in a row with no discrepancy', 'लगातार {n} चेकपॉइंट बिना अंतर के'),
('fin_open_ledger', 'Открыть ленту счёта', 'Open account ledger', 'खाता बही खोलें'),
('fin_recon_do', 'Сверить', 'Reconcile', 'मिलान करें'),
('fin_never_reconciled', 'Ни разу не сверено', 'Never reconciled', 'कभी मिलान नहीं'),
('fin_sync_age', 'Давность сверки', 'Reconciliation recency', 'मिलान की ताज़गी'),
('fin_today', 'сегодня', 'today', 'आज'),
('fin_days_ago', '{n} дн. назад', '{n} days ago', '{n} दिन पहले')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
