-- 279: слова в «Поклонении» — «стандарт» вместо «статьи», архив материалов
-- и папок называется одинаково (у стандартов — «отменённые», у библиотеки
-- и галереи — «архив»; раньше библиотека брала подпись стандартов).

update translations set ru = 'Новый стандарт', en = 'New standard', hi = 'नया मानक'
 where key = 'worship_new_article';

update translations set
    ru = 'Порядок задаётся стрелками. Раздел с содержимым не удаляется — его можно скрыть: стандарты останутся доступны по ссылке и в поиске.',
    en = 'Order is set with the arrows. A section with standards is not deleted, only hidden: its standards stay reachable by link and in search.',
    hi = 'क्रम तीरों से तय होता है। मानक वाला अनुभाग हटाया नहीं जाता, केवल छिपाया जाता है: उसके मानक लिंक और खोज से उपलब्ध रहते हैं।'
 where key = 'worship_sections_modal_hint';

update translations set
    ru = 'Короткая заметка уйдёт автору и старшему. Это не спор и не ветка обсуждения — поправит тот, кто правит стандарт.',
    en = 'A short note goes to the author and the senior. This is not a debate — whoever edits the standard will fix it.',
    hi = 'छोटा नोट लेखक और वरिष्ठ को जाता है। यह बहस नहीं — जो मानक संपादित करता है वही सुधारेगा।'
 where key = 'worship_remarks_article_hint';

insert into translations (key, ru, en, hi) values
    ('worship_show_archive', 'Показывать архив', 'Show archive', 'संग्रह दिखाएँ')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
