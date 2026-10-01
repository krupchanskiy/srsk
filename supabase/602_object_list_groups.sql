-- Список ретритов в финансах: группы «Идут и предстоящие» / «Недавно прошли»,
-- старые (закончились > 60 дней назад) и закрытые — под пунктом «Показать прошедшие…»

insert into translations (key, ru, en, hi) values
  ('fin_object_group_current', 'Идут и предстоящие',  'Ongoing and upcoming', 'चल रहे और आगामी'),
  ('fin_object_group_recent',  'Недавно прошли',      'Recently ended',       'हाल ही में समाप्त'),
  ('fin_object_group_past',    'Прошедшие',           'Past',                 'पिछले'),
  ('fin_object_show_past',     'Показать прошедшие…', 'Show past…',           'पिछले दिखाएँ…')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
