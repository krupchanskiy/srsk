-- Подсказка у траты, сделанной сразу из перевода (ДДС и «Счёт» департамента)
insert into translations (key, ru, en, hi, context) values
('dacc_paired_hint', 'Потрачено сразу из этого перевода', 'Spent right away from this transfer', 'इस स्थानांतरण से तुरंत खर्च किया गया', 'ДДС и счёт департамента: пара перевод + трата')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
