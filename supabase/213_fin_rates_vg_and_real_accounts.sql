-- Этап 3 (подготовка): актуальные курсы от Ванамали Гопала + боевые счета + маппинг каналов.
-- Источники: ответ ВГ от 22.07.2026 (маппинг «канал → счёт», курсы RUB 1.15 / USD 97 / EUR 108).

-- 1. Актуальные курсы (автор — ВГ; кэш CRM обновится триггером trg_fin_sync_crm_currency_cache)
INSERT INTO fin_exchange_rates (object_id, effective_date, from_currency, rate, created_by)
VALUES
  (NULL, CURRENT_DATE, 'RUB', 1.15, '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746'),
  (NULL, CURRENT_DATE, 'USD', 97,   '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746'),
  (NULL, CURRENT_DATE, 'EUR', 108,  '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746')
ON CONFLICT (object_id, effective_date, from_currency)
DO UPDATE SET rate = EXCLUDED.rate, created_by = EXCLUDED.created_by, created_at = now();

-- 2. Боевые счета (названия — дословно из ответа ВГ; ответственный — он же).
--    Банк и PayPal сверяются по выписке, кассы — пересчётом наличных по купюрам.
--    Примечание: group_name при INSERT обнулился (нормализация на стороне БД),
--    проставлен отдельным UPDATE ниже.
INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name, responsible_person_id, created_by)
SELECT x.name, 'real', x.mode::fin_reconciliation_mode, x.cur, x.grp,
       'a39bb094-9702-4899-a46e-5411f6b6c0f0', '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746'
FROM (VALUES
  ('ИП ШРСК (₽)', 'statement',  'RUB', 'Банк'),
  ('PayPal ($)',  'statement',  'USD', 'PayPal'),
  ('PayPal (€)',  'statement',  'EUR', 'PayPal'),
  ('Касса ($)',   'cash_count', 'USD', 'Касса'),
  ('Касса (€)',   'cash_count', 'EUR', 'Касса'),
  ('Касса (₹)',   'cash_count', 'INR', 'Касса'),
  ('Касса (₽)',   'cash_count', 'RUB', 'Касса')
) AS x(name, mode, cur, grp)
WHERE NOT EXISTS (SELECT 1 FROM fin_accounts a WHERE a.name = x.name);

UPDATE fin_accounts SET group_name = CASE
  WHEN name = 'ИП ШРСК (₽)' THEN 'Банк'
  WHEN name LIKE 'PayPal%' THEN 'PayPal'
  WHEN name LIKE 'Касса%' THEN 'Касса'
END
WHERE name IN ('ИП ШРСК (₽)','PayPal ($)','PayPal (€)','Касса ($)','Касса (€)','Касса (₹)','Касса (₽)')
  AND group_name IS NULL;

-- 3. Маппинг «валюта безналичного платежа → счёт» для автопроводки.
--    Наличные в маппинг не входят — счёт (касса) выбирается вручную при подтверждении.
--    INR-переводов в правилах ВГ нет — при появлении такого платежа автопроводка
--    честно упадёт в лог с 'no_account_mapping', а не угадает.
CREATE TABLE IF NOT EXISTS fin_crm_channel_map (
  currency_code text PRIMARY KEY REFERENCES fin_currencies(code),
  account_id uuid NOT NULL REFERENCES fin_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin_crm_channel_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fin admins read channel map" ON fin_crm_channel_map;
CREATE POLICY "fin admins read channel map" ON fin_crm_channel_map
  FOR SELECT TO authenticated USING (fin_can_read_all((SELECT auth.uid())));

INSERT INTO fin_crm_channel_map (currency_code, account_id)
SELECT v.cur, a.id
FROM (VALUES ('RUB', 'ИП ШРСК (₽)'), ('USD', 'PayPal ($)'), ('EUR', 'PayPal (€)')) AS v(cur, acc)
JOIN fin_accounts a ON a.name = v.acc
ON CONFLICT (currency_code) DO UPDATE SET account_id = EXCLUDED.account_id;

-- 4. Нитья-виласини — постоянный fin_admin (решение вопроса 3 «Ответов по интеграциям»:
--    две постоянные роли; без этого её подтверждения в CRM не смогут проводиться в финмодуль)
INSERT INTO user_permissions (user_id, permission_id, is_granted, reason, granted_by, granted_at)
SELECT 'ee76f10d-cff9-4efe-8a28-3cad716673e9', '61f827e8-0c1f-4cce-b592-2036dbb9f4e0', true,
       'Подтверждающая CRM-платежи — вопрос 3 интеграционных ответов, две постоянные роли',
       '2160b531-4e37-4d2a-ba46-cc1ee230cfeb', now()
WHERE NOT EXISTS (
  SELECT 1 FROM user_permissions
  WHERE user_id = 'ee76f10d-cff9-4efe-8a28-3cad716673e9'
    AND permission_id = '61f827e8-0c1f-4cce-b592-2036dbb9f4e0'
);
