-- «Внёс: имя, дата» в истории цены на kitchen/prices.html
insert into translations (key, ru, en, hi, context) values
('prices_entered_by', 'Внёс', 'Entered by', 'दर्ज किया', 'Кухня → Цены')
on conflict (key) do nothing;
