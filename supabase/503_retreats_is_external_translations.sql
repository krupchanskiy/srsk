-- Переводы для галочки «Стороннее мероприятие» на ashram/retreats.html (этап 2, пересмотр)
insert into translations (key, ru, en, hi, context) values
('retreats_is_external', 'Стороннее мероприятие', 'External event', 'बाहरी कार्यक्रम', 'Ретриты'),
('retreats_is_external_hint', 'Организовано не нами (аренда площадки, свадьба, чужой ретрит) — та же инфраструктура, но отдельно от наших ретритов в списках и выпадающих меню', 'Organized by someone else (venue rental, wedding, another group''s retreat) — same infrastructure, just kept apart from our own retreats in lists and dropdowns', 'हमारे द्वारा आयोजित नहीं (स्थल किराए पर, शादी, किसी और का रिट्रीट) — वही ढांचा, बस सूचियों और ड्रॉपडाउन में हमारे रिट्रीट से अलग', 'Ретриты')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
