-- 758: подписи списка департаментов в карточке статьи (ВГ 29.10, к миграции 757)
insert into translations (key, ru, en, hi, page) values
  ('fin_cat_depts', 'Каким департаментам видна', 'Visible to departments', 'किन विभागों को दिखे', 'Справочники'),
  ('fin_cat_income_depts', 'В выручке департаментов', 'In department revenue', 'विभागों की आय में', 'Справочники'),
  ('fin_cat_depts_common', 'общий набор', 'common set', 'साझा सूची', 'Справочники'),
  ('fin_cat_depts_hint',
   'Департаменты на общем наборе видят все статьи с галочкой «Видна департаментам». Свой набор у департамента задаётся в его карточке.',
   'Departments on the common set see every category marked “Visible to departments”. A department''s own set is edited in its card.',
   'साझा सूची वाले विभाग «विभागों को दिखे» वाली सभी मदें देखते हैं। विभाग की अपनी सूची उसके कार्ड में बदली जाती है।', 'Справочники')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
