-- Канал оплаты USDT (ВГ, 28.09.2026): в форме «Приход» канал теперь ставится сам
-- по счёту, и у счёта «USDT ($)» должен быть свой канал, а не «Карта».
ALTER TYPE fin_payment_channel ADD VALUE IF NOT EXISTS 'usdt';

INSERT INTO translations (key, ru, en, hi)
VALUES ('fin_channel_usdt', 'USDT', 'USDT', 'USDT')
ON CONFLICT (key) DO NOTHING;
