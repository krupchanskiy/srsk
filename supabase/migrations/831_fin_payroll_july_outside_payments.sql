-- 831: ответы ВГ 26.11 по выплатам без месяца и «Оплате труда» мимо ведомости.
-- • Васудева Датта 03.11 20 000 «за весь срок» — за последний приезд 10.10–07.11 → октябрь
-- • Коти Чандра 10.11 5 000 → ноябрь
-- • Амрита Маи 08.09 «на карманные» → август; вторая выплата 08.09 «за прошлый месяц» → июль
-- • Амала Камала 06.08 15 000 «по просьбе ВГ» → июль; Гитамрита 15.08 5 732 → июль
-- Три последние были мимо ведомости: заводим позицию-июль в Поклонении (без оклада,
-- 01.07–31.07) и привязываем выплату. Где у человека ведётся баланс (Амрита, Амала) —
-- ручное начисление за июль на ту же сумму, чтобы баланс не сдвинулся.
-- Подтверждение в Телеграме за старые выплаты не шлём — триггер выключен на время вставки.
DO $d$
DECLARE
  v_vg uuid := '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746';
  v_poklon uuid := '409cdd00-bd47-49a3-9081-5a2835b9caf5';
  r record;
  v_pos uuid;
  v_pay uuid;
BEGIN
  PERFORM fin_private_set_payment_periods(f.id, s.p::jsonb, 'vg')
     FROM (VALUES ('8b05a1cf', '[{"period":"2026-10-01","amount":20000}]'),
                  ('273cb667', '[{"period":"2026-11-01","amount":5000}]'),
                  ('8af020ff', '[{"period":"2026-08-01","amount":15000}]')) s(pfx, p)
     JOIN fin_payroll_payments f ON left(f.id::text, 8) = s.pfx;

  ALTER TABLE fin_payroll_payments DISABLE TRIGGER fin_payroll_payment_after_insert;
  FOR r IN SELECT * FROM (VALUES
      ('6ad193b9-0a7d-4db0-ab95-dcdc8b56c987'::uuid, 'Вязальщица',      '31fc09c4-9d7f-4206-a84a-2c6ca8a9a302'::uuid, 15000::numeric, true),   -- Амрита Маи
      ('8b94f5bd-01b3-4cbb-bc23-685a8795bbed'::uuid, 'Швея',            'bca858fc-cd01-1657-846c-d627e1268723'::uuid, 15000::numeric, true),   -- Амала Камала дд
      ('1e7e4082-cecc-403d-92f5-4012d441a56f'::uuid, 'Разовые выплаты', '2fa0344f-0436-4725-96f4-29a4ae0e406c'::uuid, 5732::numeric,  false)   -- Гитамрита
    ) x(vaishnava_id, title, posting_id, amount, with_accrual)
  LOOP
    IF EXISTS (SELECT 1 FROM fin_payroll_payments WHERE posting_id = r.posting_id) THEN
      RAISE EXCEPTION 'posting % уже в ведомости', r.posting_id;
    END IF;
    INSERT INTO fin_payroll_positions (vaishnava_id, department_id, position_title, salary_amount, currency_code, effective_from, effective_to, created_by)
    VALUES (r.vaishnava_id, v_poklon, r.title, NULL, 'INR', '2026-07-01', '2026-07-31', v_vg)
    RETURNING id INTO v_pos;
    IF r.with_accrual THEN
      INSERT INTO fin_payroll_accruals (position_id, period, amount, currency_code, is_manual)
      VALUES (v_pos, '2026-07-01', r.amount, 'INR', true);
    END IF;
    INSERT INTO fin_payroll_payments (posting_id, position_id, withheld_amount)
    VALUES (r.posting_id, v_pos, 0) RETURNING id INTO v_pay;
    PERFORM fin_private_set_payment_periods(v_pay, jsonb_build_array(jsonb_build_object('period', '2026-07-01', 'amount', r.amount)), 'vg');
  END LOOP;
  ALTER TABLE fin_payroll_payments ENABLE TRIGGER fin_payroll_payment_after_insert;
END $d$;
