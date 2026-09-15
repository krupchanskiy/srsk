-- Чекбокс «Участвует в кассе кафе» в форме ретрита (ashram/retreats.html)
insert into translations (key, ru, en, hi, context) values
('retreats_cafe_eligible', 'Участвует в кассе кафе', 'Included in café accounting', 'कैफ़े लेखांकन में शामिल', 'Чекбокс формы ретрита'),
('retreats_cafe_eligible_hint', 'Выключите для ретритов, не связанных с кафе (например, внутренние проекты) — их не будет предлагать подсказка ретрита при вводе прихода/расхода кафе', 'Turn off for retreats unrelated to the café (e.g. internal projects) — they will be skipped by the retreat suggestion when entering café income/expenses', 'कैफ़े से असंबंधित रिट्रीट के लिए बंद करें (जैसे आंतरिक परियोजनाएं) — कैफ़े की आय/व्यय दर्ज करते समय सुझाव में ये शामिल नहीं होंगे', 'Пояснение под чекбоксом cafe_eligible')
on conflict (key) do nothing;
