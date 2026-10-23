-- 746: подписи общего списка ретритов «Предстоящие / Сторонние / Архив» (js/retreat-select.js, ВГ 23.10.2026)
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'common'
  from (values
    ('retreat_select_external', 'Сторонние мероприятия', 'External events', 'बाहरी कार्यक्रम'),
    ('retreat_select_archive',  'Архив',                 'Archive',         'संग्रह')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
