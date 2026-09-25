-- Шахматка, «Даты»: новые даты не пересекаются с ретритом брони
insert into translations (key, ru, en, hi, context) values
('timeline_dates_retreat_clear',
 'Новые даты не пересекаются с ретритом «{retreat}» ({dates}). Снять ретрит с брони? Другой ретрит можно выбрать потом в окне брони.',
 'The new dates do not overlap with the retreat «{retreat}» ({dates}). Remove the retreat from the booking? Another retreat can be chosen later in the booking window.',
 'नई तिथियाँ रिट्रीट «{retreat}» ({dates}) से मेल नहीं खातीं। बुकिंग से रिट्रीट हटाएँ? दूसरा रिट्रीट बाद में बुकिंग विंडो में चुना जा सकता है।',
 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
