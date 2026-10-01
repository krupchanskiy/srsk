-- Шахматка, форма брони и заселения (ТЗ 01.10.2026): архив ретритов, примечание брони,
-- заселение по брони с её ретритом

insert into translations (key, ru, en, hi) values
  ('timeline_retreat_archive',      'Архив / все ретриты…', 'Archive / all retreats…', 'संग्रह / सभी रिट्रीट…'),
  ('timeline_booking_notes',        'Примечание брони',     'Booking note',            'बुकिंग नोट'),
  ('timeline_retreat_from_booking', 'из брони',             'from booking',            'बुकिंग से'),
  ('timeline_checkin_by_booking',   'Заселение по брони',   'Check-in by booking',     'बुकिंग द्वारा चेक-इन')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
