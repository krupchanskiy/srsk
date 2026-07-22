-- Этап 1: текст на странице курсов CRM отражает новый источник данных
UPDATE translations SET
  ru = 'Источник курсов — финансовый модуль. Правка здесь сохраняется в его справочник и действует с текущей даты. Все платежи пересчитываются в рупии (₹) по курсу на момент платежа.',
  en = 'Exchange rates are owned by the finance module. Edits here are saved to its rate registry effective today. All payments are converted to INR (₹) at the rate on the payment date.',
  hi = 'विनिमय दरों का स्रोत वित्त मॉड्यूल है। यहाँ किया गया संपादन उसकी दर-सूची में आज से प्रभावी होकर सहेजा जाता है। सभी भुगतान भुगतान-तिथि की दर से ₹ में परिवर्तित होते हैं।'
WHERE key = 'crm_currencies_info';
