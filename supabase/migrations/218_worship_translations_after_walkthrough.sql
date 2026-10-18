-- Ключи, появившиеся после прогона глазами отдела:
-- «Только отменённые» врало (галочка добавляет их к выдаче, а не заменяет ею),
-- «Отменить правку» путалось с «Отменить стандарт», а «Ваши черновики»
-- показывали и чужие.
insert into translations (key, ru, en, hi) values
    ('worship_with_archived', 'Показывать и отменённые', 'Include cancelled', 'रद्द किए गए भी दिखाएँ'),
    ('worship_leave_edit',    'Выйти без сохранения', 'Leave without saving', 'बिना सहेजे बाहर जाएँ'),
    ('worship_drafts_title',  'Черновики отдела', 'Department drafts', 'विभाग के मसौदे')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
