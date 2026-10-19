-- 280: переводы надписей, о которые споткнулся волонтёр на английском:
-- «Вам выдали» на главной и «Меня не будет» в списке людей.
-- Надписи, собранные в коде страниц, переводятся там же (поЯзыку в utils.js).
insert into translations (key, ru, en, hi) values
    ('worship_given_to_me', 'Вам выдали', 'Assigned to you', 'आपको दिया गया'),
    ('worship_given_to_me_hint', 'С этого стоит начать — по порядку, как собрал старший.',
        'Start here, in the order the senior pujari put together.',
        'यहीं से शुरू करें — उसी क्रम में, जैसा वरिष्ठ पुजारी ने रखा है।'),
    ('worship_i_will_be_away', 'Меня не будет', 'I will be away', 'मैं नहीं रहूँगा')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
