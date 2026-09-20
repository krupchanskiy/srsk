-- Строки панели детализации на «Аналитике» (см. 441)
insert into translations (key, ru, en, hi, context) values
('fin_drill_hint', 'Нажмите на статью, чтобы увидеть операции', 'Click a line to see its operations', 'संचालन देखने के लिए किसी मद पर क्लिक करें', 'Аналитика: панель детализации справа'),
('fin_drill_empty', 'Операций нет', 'No operations', 'कोई संचालन नहीं', 'Аналитика: панель детализации справа'),
('fin_drill_entered_by', 'внёс', 'entered by', 'दर्ज किया', 'Аналитика: панель детализации справа, «внёс Иван»')
on conflict (key) do nothing;
