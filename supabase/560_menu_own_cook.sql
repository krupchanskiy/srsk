-- =============================================================
-- Меню: «Готовил Бридж Кишор» (решение ВГ 27.09.2026).
-- Дни без меню — готовил Бридж Кишор из наших же закупленных продуктов.
-- Строка как «Готовое со стороны», но ничего не покупаем: цена ориентировочная,
-- на одного вкушающего (завтрак 60 ₹, обед 160 ₹ — всего 220 ₹ в день),
-- в себестоимости = цена × вкушающие по подсчёту, идёт в «Продукты».
-- =============================================================

alter table public.menu_external_items
  add column if not exists kind text not null default 'bought',
  add column if not exists per_person numeric;

alter table public.menu_external_items
  drop constraint if exists menu_external_items_kind_check;
alter table public.menu_external_items
  add constraint menu_external_items_kind_check check (
    kind in ('bought', 'own_cook')
    and (kind <> 'own_cook' or (per_person is not null and per_person >= 0)));

comment on column public.menu_external_items.kind is
  'bought — куплено готовым (сумма по чеку); own_cook — готовил повар из наших продуктов (per_person × вкушающие)';
comment on column public.menu_external_items.per_person is
  'Для own_cook: ориентировочная стоимость на одного вкушающего, ₹';

insert into translations (key, ru, en, hi, context) values
('menu_own_cook_add', 'Готовил Бридж Кишор', 'Cooked by Brij Kishore', 'बृज किशोर ने बनाया', 'Меню: приём пищи без меню — готовил Бридж Кишор из наших продуктов'),
('menu_own_cook_title', 'Готовил из наших продуктов', 'Cooked from our products', 'हमारे उत्पादों से बनाया', 'Меню'),
('menu_own_cook_name', 'Кто готовил', 'Cooked by', 'किसने बनाया', 'Меню'),
('menu_own_cook_rate', 'Стоимость на одного вкушающего, ₹', 'Cost per person, ₹', 'प्रति व्यक्ति लागत, ₹', 'Меню'),
('menu_own_cook_hint', 'Продукты не покупаются — берутся из наших закупок. Цена ориентировочная: в себестоимости она умножается на число вкушающих.', 'Products are not bought — taken from our stock. The price is approximate: in the cost it is multiplied by the number of eaters.', 'उत्पाद खरीदे नहीं जाते — हमारे भंडार से लिए जाते हैं। मूल्य अनुमानित है: लागत में इसे खाने वालों की संख्या से गुणा किया जाता है।', 'Меню')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
