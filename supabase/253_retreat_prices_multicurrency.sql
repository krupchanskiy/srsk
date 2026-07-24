-- Предложение ВГ (24.07.2026): стоимость ретрита живёт в CRM, в разных
-- валютах, меняют трое (АК, ВГ, Олег Карпов), и дальше все начисления
-- берут цены отсюда.
--
-- Важно: цены в валютах — НЕ конверсия. ВГ задал их независимо
-- (22 500 ₹ = 21 500 ₽ = 250 $ = 225 € не сходится ни по какому курсу),
-- поэтому храним отдельными полями, а не пересчитываем.

ALTER TABLE crm_retreat_prices ADD COLUMN IF NOT EXISTS price_rub numeric;
ALTER TABLE crm_retreat_prices ADD COLUMN IF NOT EXISTS price_usd numeric;
ALTER TABLE crm_retreat_prices ADD COLUMN IF NOT EXISTS price_eur numeric;
ALTER TABLE crm_retreat_prices ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE crm_retreat_prices ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE crm_retreat_prices ADD COLUMN IF NOT EXISTS updated_by uuid;
COMMENT ON COLUMN crm_retreat_prices.price IS 'Цена в рупиях (базовая валюта ашрама)';
COMMENT ON COLUMN crm_retreat_prices.note IS 'Пометка: например, что цены в валютах предварительные';

INSERT INTO permissions (code, name_ru, name_en, category, sort_order)
SELECT 'edit_retreat_prices', 'Редактирование цен ретрита', 'Edit retreat prices', 'crm', 95
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE code='edit_retreat_prices');

INSERT INTO user_permissions (user_id, permission_id, is_granted)
SELECT v.user_id, p.id, true
FROM vaishnavas v CROSS JOIN permissions p
WHERE p.code = 'edit_retreat_prices'
  AND v.id IN ('7542f517-e790-4bbb-8c8a-0de0576e8d4d', 'e5b63859-94d7-4c80-aba8-d98ec9a6eb27')
  AND v.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id=v.user_id AND up.permission_id=p.id);
INSERT INTO user_permissions (user_id, permission_id, is_granted)
SELECT '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746', p.id, true
FROM permissions p WHERE p.code='edit_retreat_prices'
  AND NOT EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id='8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746' AND up.permission_id=p.id);

INSERT INTO crm_services (code, name_ru, name_en, category, unit, default_price, is_active, sort_order)
SELECT * FROM (VALUES
  ('room_srsk_double', 'ШРСК, 2-местный номер', 'SRSK, double room', 'accommodation', 'piece', 0::numeric, true, 10),
  ('room_srsk_quad',   'ШРСК, 4-местный номер', 'SRSK, quad room', 'accommodation', 'piece', 0::numeric, true, 11),
  ('room_aniyor_double','Анийёр Ашрая, 2-местный (рикши бесплатно)', 'Aniyor Ashraya, double', 'accommodation', 'piece', 0::numeric, true, 12),
  ('room_bhadur_double','Бхадур, 2-местный номер', 'Bhadur, double room', 'accommodation', 'piece', 0::numeric, true, 13),
  ('meals_breakfast_lunch', 'Питание: завтрак и обед', 'Meals: breakfast and lunch', 'meals', 'piece', 0::numeric, true, 20)
) AS s(code, name_ru, name_en, category, unit, default_price, is_active, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM crm_services cs WHERE cs.code = s.code);

INSERT INTO crm_retreat_prices (retreat_id, service_id, price, price_rub, price_usd, price_eur, note)
SELECT r.id, cs.id, x.inr, x.rub, x.usd, x.eur, x.note
FROM (VALUES
  ('room_srsk_double',      22500::numeric, 21500::numeric, 250::numeric, 225::numeric, 'Проживание 15 дней, койко-место'),
  ('room_srsk_quad',        16500::numeric, 16000::numeric, 185::numeric, 165::numeric, 'Проживание 15 дней, койко-место'),
  ('room_aniyor_double',    15000::numeric, 14300::numeric, 170::numeric, 150::numeric, 'Проживание 15 дней, койко-место. Рикши бесплатно'),
  ('room_bhadur_double',    11250::numeric, 10760::numeric, 125::numeric, 113::numeric, 'Проживание 15 дней (1500/номер). Цены в валютах предварительные — с ВГ не согласованы'),
  ('meals_breakfast_lunch', 10500::numeric, 10000::numeric, 120::numeric, 100::numeric, 'Питание 15 дней: завтрак и обед'),
  ('org_fee',               25000::numeric, 24000::numeric, 280::numeric, 230::numeric, 'Организационный взнос за ретрит')
) AS x(code, inr, rub, usd, eur, note)
JOIN crm_services cs ON cs.code = x.code
CROSS JOIN retreats r
WHERE r.name_ru = 'Сева-ретрит'
  AND NOT EXISTS (SELECT 1 FROM crm_retreat_prices p WHERE p.retreat_id = r.id AND p.service_id = cs.id);
