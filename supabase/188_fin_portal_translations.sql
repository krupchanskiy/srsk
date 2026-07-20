-- Финансовый модуль, Этап 3в: переводы блока «Финансы» в портале гостя
-- (остальные ключи fin_* уже есть — портал грузит всю таблицу translations)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('portal_finance', 'Финансы', 'Finances', 'वित्त', 'Портал гостя'),
  ('portal_fin_paid_up', 'Всё оплачено', 'Paid in full', 'पूर्ण भुगतान', 'Портал гостя')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi,
  context = EXCLUDED.context, updated_at = NOW();
