-- Галочка «уже потрачено» в уточнении выдачи.
insert into translations (key, ru, en, hi) values
  ('fin_refine_spent',
   'Деньги уже потрачены — сразу учесть как расход получателя',
   'Money already spent — record it as the recipient''s expense right away',
   'पैसा खर्च हो चुका — तुरंत प्राप्तकर्ता के खर्च के रूप में दर्ज करें')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
