-- Правило ВГ (вопрос 4 от 23.07.2026): «отмечать приход денег только на тот
-- счёт, на котором они лежат; новая точка входа — новый счёт». USDT уже
-- используется как канал приёма (подтверждённый платёж $560), а отдельного
-- счёта у него не было — деньги ложились на PayPal. Заводим кошелёк отдельно.
INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name, is_active, created_by)
SELECT 'USDT ($)', 'real', 'statement', 'USD', 'Криптокошелёк', true,
       (SELECT created_by FROM fin_accounts WHERE name = 'PayPal ($)')
WHERE NOT EXISTS (SELECT 1 FROM fin_accounts WHERE name = 'USDT ($)');

-- Уборка после ночного тестирования: счета-пустышки висели активными и
-- попадали в KPI дашборда (₹251 200 «остатков», которых нет). Не удаляем —
-- журнал операций неизменяем — а закрываем: из подсказок и сводок исчезают.
UPDATE fin_accounts SET is_active = false
WHERE (name LIKE 'ZZ %' OR name LIKE 'ТЕСТ %') AND is_active;
