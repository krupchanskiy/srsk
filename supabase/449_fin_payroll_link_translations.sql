-- Переводы для поля «Сотрудник в ведомости» в разбивке заявок из чата
-- (448_tg_post_draft_payroll_link.sql)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_link_none', '— не в ведомости —', '— not in payroll —', '— वेतन में नहीं —', 'Финансы'),
  ('fin_payroll_link_title', 'Отметить как выплату сотруднику в зарплатной ведомости', 'Mark as a payroll payment to this employee', 'इसे कर्मचारी को वेतन भुगतान के रूप में चिह्नित करें', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
