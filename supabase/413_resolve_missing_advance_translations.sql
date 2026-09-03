-- Переводы: кнопки разбора сигнала «человека нет в учёте» на дашборде финмодуля
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_resolve_donation', 'Оставить как пожертвование', 'Keep as donation', 'दान के रूप में रखें'),
  ('fin_resolve_advance', 'Завести как аванс', 'Record as advance', 'अग्रिम के रूप में दर्ज करें'),
  ('fin_resolve_donation_confirm',
   '{0} — {1}. Отметить, что сумма оставлена как пожертвование? Деньги уже входят в остатки счетов на дату запуска, поэтому новая проводка не создаётся — фиксируется решение.',
   '{0} — {1}. Mark this amount as kept for a donation? The money is already inside the account opening balances, so no new posting is made — only the decision is recorded.',
   '{0} — {1}. क्या यह राशि दान के रूप में चिह्नित करें? पैसा पहले से ही खातों के प्रारंभिक शेष में है, इसलिए नई प्रविष्टि नहीं बनेगी — केवल निर्णय दर्ज होगा।'),
  ('fin_resolve_advance_confirm',
   '{0} — {1}. Завести эту сумму как аванс участника? Платёж подтвердили уже после загрузки начальных остатков, поэтому строку добираем вручную.',
   '{0} — {1}. Record this amount as the participant''s advance? The payment was confirmed after the opening balances were loaded, so the row is added manually.',
   '{0} — {1}. क्या यह राशि प्रतिभागी के अग्रिम के रूप में दर्ज करें? भुगतान प्रारंभिक शेष लोड होने के बाद पुष्ट हुआ था, इसलिए पंक्ति मैन्युअल रूप से जोड़ी जाती है।'),
  ('fin_resolve_done', 'Готово', 'Done', 'हो गया'),
  ('fin_resolve_failed', 'Не получилось', 'Did not work', 'नहीं हुआ')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
