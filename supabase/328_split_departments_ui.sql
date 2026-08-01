-- Интерфейс разбивки: департамент-получатель, «уже потрачено», закрытые ретриты.

-- Закрытый ретрит выбирать бесполезно: сервер откажет («Операция по закрытому
-- объекту требует причины»), а человек не поймёт, что не так. Помечаем прямо
-- в списке.
create or replace view fin_v_accounting_objects as
 SELECT o.id,
    o.type,
    o.retreat_id,
    o.display_name,
    o.report_dirty_at,
    o.created_at,
    EXISTS (SELECT 1 FROM fin_object_closures c
             WHERE c.object_id = o.id AND c.is_initial) AS is_closed
   FROM fin_accounting_objects o
  WHERE fin_can_read_all() OR fin_is_account_user();

insert into translations (key, ru, en, hi) values
  ('fin_split_dept',        'Департамент',            'Department',            'विभाग'),
  ('fin_split_dept_own',    '— свой —',               '— own —',               '— अपना —'),
  ('fin_split_as_expense',  'уже потрачено',          'already spent',         'खर्च हो चुका'),
  ('fin_split_dept_hint',   'Кому отнести трату: деньги спишутся с автора заявки, а расход встанет на выбранный департамент',
                            'Whose expense this is: money leaves the author''s account, the cost goes to the chosen department',
                            'यह खर्च किसका है: पैसा लेखक के खाते से जाएगा, खर्च चुने गए विभाग पर आएगा'),
  ('fin_split_no_expense_warn',
     'Без галочки сумма повиснет на остатке департамента, хотя наличных он не получал',
     'Without the tick the amount stays on the department''s balance though it received no cash',
     'बिना निशान के राशि विभाग के शेष में रहेगी, जबकि नकद उसे नहीं मिला'),
  ('fin_object_closed',     'закрыт',                 'closed',                'बंद'),
  ('fin_refine',            'Уточнить',               'Refine',                'सुधारें'),
  ('fin_refine_title',      'Уточнить выдачу',        'Refine the issue',      'जारी करना सुधारें'),
  ('fin_refine_target',     'Кому выдаём',            'Issued to',             'किसे जारी'),
  ('fin_refine_source',     'С какого счёта',         'From which account',    'किस खाते से')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
