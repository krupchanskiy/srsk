-- 830: месяцы выплат по ответам ВГ 26.11 (Айгуль, Амрита 01.10/28.10, Ямуна-раса, Уша Кафе, Кришна Кумар, Ачинтья-чайтанья)
DO $d$ DECLARE r record; BEGIN
FOR r IN SELECT f.id, s.p FROM (VALUES
 ('19ecb9f6','[{"period":"2026-08-01","amount":30000}]'),
 ('8cbaba61','[{"period":"2026-09-01","amount":15000}]'),
 ('edea15a0','[{"period":"2026-10-01","amount":15000}]'),
 ('b3703a97','[{"period":"2026-10-01","amount":15000}]'),
 ('6b45e82f','[{"period":"2026-10-01","amount":11700}]'),
 ('1908b0bf','[{"period":"2026-10-01","amount":35000},{"period":"2026-11-01","amount":8000}]'),
 ('a690c8d5','[{"period":"2026-09-01","amount":50000},{"period":"2026-10-01","amount":50000},{"period":"2026-11-01","amount":50000}]')
) s(pfx,p) JOIN fin_payroll_payments f ON left(f.id::text,8)=s.pfx LOOP
  PERFORM fin_private_set_payment_periods(r.id, r.p::jsonb, 'vg');
END LOOP;
END $d$;
