INSERT INTO translations (key, ru, en, hi) VALUES
  ('nav_crm_retreat_prices', 'Цены ретрита', 'Retreat prices', 'रिट्रीट मूल्य'),
  ('crm_retreat_prices_page_title', 'Цены ретрита — CRM — ШРСК', 'Retreat prices — CRM — SRSK', 'रिट्रीट मूल्य — CRM — SRSK'),
  ('crm_retreat_prices_hint', 'Стоимость ретрита в разных валютах. Цены задаются независимо, а не пересчитываются по курсу. Отсюда начисления берут суммы участникам.', 'Retreat pricing per currency. Prices are set independently, not converted by rate.', 'प्रत्येक मुद्रा में रिट्रीट मूल्य।'),
  ('crm_note', 'Пометка', 'Note', 'टिप्पणी'),
  ('crm_add_price', 'Добавить услугу в прайс', 'Add service to price list', 'मूल्य सूची में सेवा जोड़ें'),
  ('crm_no_prices', 'Для этого ретрита цены ещё не заданы', 'No prices set for this retreat yet', 'इस रिट्रीट के लिए मूल्य अभी तय नहीं'),
  ('crm_all_services_priced', 'Все услуги уже в прайсе этого ретрита', 'All services are already priced for this retreat', 'सभी सेवाएँ पहले से मूल्य सूची में हैं')
ON CONFLICT (key) DO UPDATE SET ru=EXCLUDED.ru, en=EXCLUDED.en, hi=EXCLUDED.hi;
