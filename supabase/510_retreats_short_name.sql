-- Свои буквы ретрита (ШБ, БВП, РБЧ) для шахматки: видны перед именем гостя, когда ретриты
-- идут одновременно. Пусто — буквы берутся из названия автоматически (первые буквы двух слов).
alter table public.retreats add column short_name text check (short_name is null or char_length(short_name) between 1 and 5);

insert into translations (key, ru, en, hi, context) values
('retreats_short_name', 'Буквы ретрита', 'Retreat letters', 'रिट्रीट के अक्षर', 'Ретриты'),
('retreats_short_name_hint', '2–3 буквы, например ШБ. Видны в шахматке перед именем гостя, когда ретриты идут одновременно. Пусто — возьмутся первые буквы названия', '2–3 letters, e.g. BS. Shown in the timeline before the guest''s name when retreats overlap. Empty — first letters of the name are used', '2–3 अक्षर, जैसे BS। जब रिट्रीट एक साथ चलते हैं, तो टाइमलाइन में अतिथि के नाम से पहले दिखते हैं। खाली हो तो नाम के पहले अक्षर लिए जाते हैं', 'Ретриты')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
