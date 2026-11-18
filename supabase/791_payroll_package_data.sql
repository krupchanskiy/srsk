-- =============================================================
-- 791. Данные пакета оклада (790), решения ВГ 18.11.2026
--
-- Кришна Кумар дас: жильё 15 000 с 01.10; семья (бронь «Семья Кришна Кумара
-- (садовник)») — платит он, прасад 9 000 ₹ на человека в месяц.
-- Его место в шахматке было на дубле карточки, заведённом 18.11 в 02:06, —
-- переносим место и департамент на карточку ведомости (дубль не удаляем).
--
-- Амрита Маи и Айгуль — в пакет БЕЗ сторно: только привязка уже проведённых
-- расходов на жильё к ведомости (касса не меняется).
-- =============================================================

-- Кришна Кумар: место и департамент — на карточку ведомости
UPDATE vaishnava_departments SET vaishnava_id = '98231c24-a2a3-453f-8954-9d82b7851043'
 WHERE id = '3b46a849-a2ef-4845-8da2-32808d2d597e' AND vaishnava_id = 'b136eb70-19b5-4254-acdc-760c130482e1';
UPDATE residents SET vaishnava_id = '98231c24-a2a3-453f-8954-9d82b7851043'
 WHERE id = '81deda4b-772d-4f39-8784-8ac534d11c75' AND vaishnava_id = 'b136eb70-19b5-4254-acdc-760c130482e1';

-- Семья: платит Кришна Кумар, прасад 9 000 в месяц на каждого
UPDATE bookings SET payer_id = '98231c24-a2a3-453f-8954-9d82b7851043'
 WHERE id = '8a19d227-f6de-461b-ab71-d3a72423e44e';
INSERT INTO fin_stay_agreements (resident_id, field, value, comment, created_by)
VALUES ('02d0009f-28e7-455d-9eda-7612dac85ad0', 'meals_month', 9000, 'Прасад 9 000 ₹ в месяц, платит Кришна Кумар дас (ВГ 18.11)', '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746'),
       ('f1819d32-3fd7-441c-a24f-890e39b2831a', 'meals_month', 9000, 'Прасад 9 000 ₹ в месяц, платит Кришна Кумар дас (ВГ 18.11)', '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746')
ON CONFLICT (resident_id, field) DO NOTHING;

-- Жильё в пакете
UPDATE fin_payroll_positions SET housing_amount = 15000 WHERE id = 'ba6b6b7a-28dd-4156-b400-69e25ec042bb';  -- Кришна Кумар с 01.10
UPDATE fin_payroll_positions SET housing_amount = 25000 WHERE id = '70151743-06e3-44b4-9459-326f47a92432';  -- Амрита Маи с 01.09
UPDATE fin_payroll_positions SET housing_amount = 10000 WHERE id = '78386e69-f78d-4411-9e2b-8486628fd1d6';  -- Айгуль, август
UPDATE fin_payroll_positions SET housing_amount = 10000 WHERE id = '0abac83c-1b66-41ff-9c5d-61004d7aa6f4';  -- Айгуль с 01.10

-- Привязка уже проведённых расходов на жильё (без новых проводок)
INSERT INTO fin_payroll_housing_payments (posting_id, position_id, paid_to, payee)
VALUES
  -- Амрита Маи: 08.09 «Арена жилья» 25 000; 01.10 из выдачи 40 000 — 25 000 аренда
  ('aa81618f-5505-413a-8356-5a3f41410723', '70151743-06e3-44b4-9459-326f47a92432', NULL, NULL),
  ('956d7312-bd3f-46ab-a4c2-bf5df301ce64', '70151743-06e3-44b4-9459-326f47a92432', 'employee', NULL),
  -- Айгуль: 13.09 «АК оплатил 10к за квартиру» (за август), 12.10 и 05.11 «Мастерская»
  ('78ac6361-31c4-44ad-bdda-2d30c75a2f22', '78386e69-f78d-4411-9e2b-8486628fd1d6', 'landlord', 'оплатил Ачинтья Кришна'),
  ('bd512c1b-76ca-4cb9-a172-c86374c56695', '0abac83c-1b66-41ff-9c5d-61004d7aa6f4', NULL, NULL),
  ('3476e128-9e73-438d-b839-cfbaa9643878', '0abac83c-1b66-41ff-9c5d-61004d7aa6f4', NULL, NULL)
ON CONFLICT (posting_id) DO NOTHING;

-- Начислить жильё (по текущий месяц) и прасад семьи (за завершённые месяцы)
SELECT fin_run_payroll_accrual();
