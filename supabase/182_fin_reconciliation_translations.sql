-- Финансовый модуль, Этап 2: переводы экрана «Сверка»

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_fin_reconciliation', 'Сверка', 'Reconciliation', 'मिलान', 'Навигация Финансы'),
  ('fin_page_title_reconciliation', 'Сверка — Финансы — ШРСК', 'Reconciliation — Finance — SRSK', 'मिलान — वित्त — SRSK', 'Заголовок страницы'),
  ('fin_recon_select_account', 'Выберите счёт', 'Select account', 'खाता चुनें', 'Сверка'),
  ('fin_system_balance', 'Расчётный остаток', 'System balance', 'गणितीय शेष', 'Сверка'),
  ('fin_counted_balance', 'Фактический остаток', 'Counted balance', 'वास्तविक शेष', 'Сверка'),
  ('fin_difference', 'Разница', 'Difference', 'अंतर', 'Сверка'),
  ('fin_recon_location', 'Точка хранения', 'Storage location', 'भंडारण स्थान', 'Сверка'),
  ('fin_recon_add_location', 'Добавить точку', 'Add location', 'स्थान जोड़ें', 'Сверка'),
  ('fin_other_amount', 'Прочее (монеты, мелочь)', 'Other (coins)', 'अन्य (सिक्के)', 'Сверка'),
  ('fin_other_comment', 'Комментарий к «прочее»', 'Comment for other', 'अन्य हेतु टिप्पणी', 'Сверка'),
  ('fin_recon_save', 'Сохранить сверку', 'Save reconciliation', 'मिलान सहेजें', 'Сверка'),
  ('fin_recon_history', 'История сверок', 'Reconciliation history', 'मिलान इतिहास', 'Сверка'),
  ('fin_recon_adjustment_reason', 'Причина расхождения', 'Discrepancy reason', 'अंतर का कारण', 'Сверка'),
  ('fin_recon_mismatch_note', 'Расхождение не устранено. Будет создана корректировка — укажите причину.', 'Discrepancy remains. An adjustment will be created — provide a reason.', 'अंतर बना है। समायोजन बनेगा — कारण बताएँ।', 'Сверка'),
  ('fin_statement_balance', 'Остаток по выписке', 'Statement balance', 'विवरण शेष', 'Сверка'),
  ('fin_last_checkpoint', 'Последний чекпоинт', 'Last checkpoint', 'अंतिम चेकपॉइंट', 'Сверка'),
  ('fin_no_checkpoint', 'Сверок ещё не было', 'No reconciliations yet', 'अभी कोई मिलान नहीं', 'Сверка'),
  ('fin_unreconciled_after', 'операций после чекпоинта', 'operations after checkpoint', 'चेकपॉइंट के बाद गतिविधियाँ', 'Сверка'),
  ('fin_transfer_responsibility', 'Передать ответственность', 'Transfer responsibility', 'ज़िम्मेदारी सौंपें', 'Счета'),
  ('fin_new_responsible', 'Новый ответственный', 'New responsible', 'नया ज़िम्मेदार', 'Счета'),
  ('fin_responsibility_hint', 'Передача возможна только сразу после сверки (чекпоинт = текущая проводка)', 'Transfer is possible only right after reconciliation (checkpoint = current entry)', 'हस्तांतरण केवल ताज़ा मिलान के बाद संभव है', 'Счета'),
  ('fin_reconciled_by', 'Сверено по', 'Reconciled up to', 'तक मिलान', 'Счета')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi,
  context = EXCLUDED.context, updated_at = NOW();
