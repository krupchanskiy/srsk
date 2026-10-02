-- Шахматка: правка брони и проживания в форме «Бронирование» (ТЗ 01.10, п. 7)
insert into translations (key, ru, en, hi) values
  ('timeline_edit_booking', 'Изменить бронь', 'Edit booking', 'बुकिंग बदलें'),
  ('timeline_edit_stay', 'Изменить проживание', 'Edit stay', 'ठहराव बदलें'),
  ('timeline_edit_group_hint', 'В брони {n} мест: категория, ретрит, департамент и прасад изменятся у всех мест, даты и человек — только у этого места.', 'The booking has {n} places: category, retreat, department and prasad change for all places, dates and person — only for this place.', 'बुकिंग में {n} स्थान: श्रेणी, रिट्रीट, विभाग और प्रसाद सभी स्थानों के लिए बदलेंगे, तिथियाँ और व्यक्ति — केवल इस स्थान के लिए।'),
  ('timeline_edit_room_full', 'В номере {cap} мест, а в эти даты уже живут или забронированы {n}. Сохранить всё равно?', 'The room has {cap} places, and {n} are already staying or booked on these dates. Save anyway?', 'कमरे में {cap} स्थान हैं, इन तिथियों पर पहले से {n} रह रहे हैं या बुक हैं। फिर भी सहेजें?'),
  ('timeline_edit_saved', 'Изменения сохранены', 'Changes saved', 'बदलाव सहेजे गए')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
