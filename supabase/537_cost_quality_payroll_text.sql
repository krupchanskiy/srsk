-- Себестоимость: плашка «Данные могут быть неточными» — «предварительно», как на «Накладных» (ВГ 25.09)
update translations set ru = 'зарплата предварительная, ещё не начислена',
 en = 'salary is preliminary, not yet accrued', hi = 'वेतन प्रारंभिक है, अभी अर्जित नहीं'
where key = 'cost_q_payroll';
