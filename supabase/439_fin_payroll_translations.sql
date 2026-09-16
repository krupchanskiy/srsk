-- Переводы интерфейса зарплатной ведомости и раздела «Сотрудники»
-- в справочнике департаментов (438_fin_payroll.sql)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_fin_payroll', 'Зарплата', 'Payroll', 'वेतन', 'Навигация Финансы'),
  ('fin_page_title_payroll', 'Зарплатная ведомость — Финансы — ШРСК', 'Payroll — Finance — SRSK', 'वेतन — वित्त — SRSK', 'Заголовок страницы'),

  ('fin_payroll_title', 'Зарплатная ведомость', 'Payroll', 'वेतन विवरण', 'Финансы'),
  ('fin_payroll_employee', 'Сотрудник', 'Employee', 'कर्मचारी', 'Финансы'),
  ('fin_payroll_position', 'Должность', 'Position', 'पद', 'Финансы'),
  ('fin_payroll_salary', 'Оклад', 'Salary', 'वेतन', 'Финансы'),
  ('fin_payroll_no_salary', 'Без оклада', 'No fixed salary', 'निश्चित वेतन नहीं', 'Финансы'),
  ('fin_payroll_accrued', 'Начислено', 'Accrued', 'आबंटित', 'Финансы'),
  ('fin_payroll_paid', 'Выплачено', 'Paid', 'भुगतान किया गया', 'Финансы'),
  ('fin_payroll_balance', 'Баланс', 'Balance', 'शेष', 'Финансы'),
  ('fin_payroll_debt', 'Долг', 'Owed', 'देय', 'Финансы'),
  ('fin_payroll_advance', 'Аванс', 'Advance', 'अग्रिम', 'Финансы'),
  ('fin_payroll_settled', 'Выплачено полностью', 'Fully paid', 'पूर्ण भुगतान', 'Финансы'),
  ('fin_payroll_pay', 'Выплатить', 'Pay', 'भुगतान करें', 'Финансы'),
  ('fin_payroll_adhoc_pay', 'Разовая выплата', 'One-off payment', 'एकमुश्त भुगतान', 'Финансы'),
  ('fin_payroll_no_employees', 'Пока нет ни одного сотрудника с позицией в департаменте', 'No employees with a department position yet', 'अभी तक कोई कर्मचारी नहीं', 'Финансы'),
  ('fin_payroll_former', 'бывший', 'former', 'पूर्व', 'Финансы'),
  ('fin_payroll_amount', 'Сумма', 'Amount', 'राशि', 'Финансы'),
  ('fin_payroll_date', 'Дата', 'Date', 'तारीख', 'Финансы'),
  ('fin_payroll_comment', 'Комментарий', 'Comment', 'टिप्पणी', 'Финансы'),

  ('fin_payroll_employees_section', 'Сотрудники', 'Employees', 'कर्मचारी', 'Финансы'),
  ('fin_payroll_month', 'мес.', 'mo.', 'माह', 'Финансы'),
  ('fin_payroll_find_person', 'Найти человека…', 'Find a person…', 'व्यक्ति खोजें…', 'Финансы'),
  ('fin_payroll_position_placeholder', 'Должность', 'Position', 'पद', 'Финансы'),
  ('fin_payroll_salary_placeholder', 'Оклад (необязательно)', 'Salary (optional)', 'वेतन (वैकल्पिक)', 'Финансы'),
  ('fin_payroll_terminate', 'Завершить', 'End', 'समाप्त करें', 'Финансы'),
  ('fin_payroll_terminate_confirm', 'Завершить эту позицию сегодняшним числом?', 'End this position as of today?', 'क्या आज की तारीख से यह पद समाप्त करें?', 'Финансы'),
  ('fin_payroll_edit_employee', 'Изменить сотрудника', 'Edit employee', 'कर्मचारी संपादित करें', 'Финансы'),
  ('fin_payroll_cancel_edit', 'Отмена', 'Cancel', 'रद्द करें', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
