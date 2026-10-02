-- Портал гостя: рейс больше чем на 3 дня от дат ретрита — гость подтверждает (ВГ 02.10.2026)
insert into translations (key, ru, en, hi) values
  ('portal_flight_date_check',
   'Рейс {date}, а ретрит {dates}. Проверьте, пожалуйста, месяц и год. Сохранить?',
   'Flight {date}, but the retreat is {dates}. Please check the month and year. Save?',
   'उड़ान {date}, लेकिन रिट्रीट {dates} है। कृपया महीना और वर्ष जाँचें। सहेजें?')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
