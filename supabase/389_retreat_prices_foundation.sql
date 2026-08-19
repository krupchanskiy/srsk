-- 389: фундамент стоимости ретрита (ТЗ, Этап 1, п. 1.1–1.2; Этап 3, п. 3.5)
--
-- 1. Позиции проживания привязываются к зданию и вместимости номера — иначе
--    расчёт «цена по факту заселённого номера» не может найти нужную строку прайса.
-- 2. «Доп. кровать» — отдельная услуга, цена своя на каждый ретрит (Приложение Б).
-- 3. Менеджеры продаж получают view_timeline: пункт «Шахматка» в меню CRM
--    работает только на просмотр (edit_timeline им не выдаётся).

alter table public.crm_services
    add column if not exists building_id uuid references public.buildings(id),
    add column if not exists room_capacity int;

comment on column public.crm_services.building_id is
    'Для категории accommodation: здание, к которому относится цена';
comment on column public.crm_services.room_capacity is
    'Для категории accommodation: вместимость номера, по которой ищется цена при расчёте';

-- Существующие позиции Сева-ретрита — сопоставление зданиям
update crm_services set building_id = '5fd72663-f118-4be4-80d7-155fb6264af7', room_capacity = 2
 where code = 'room_srsk_double' and building_id is null;
update crm_services set building_id = '5fd72663-f118-4be4-80d7-155fb6264af7', room_capacity = 4
 where code = 'room_srsk_quad' and building_id is null;
update crm_services set building_id = '6b5f6ba0-189c-40c0-a552-bafa64f69dac', room_capacity = 2
 where code = 'room_bhadur_double' and building_id is null;
update crm_services set building_id = 'a4fed42a-5b66-45ae-bdd1-e4ea74cfde46', room_capacity = 2
 where code = 'room_aniyor_double' and building_id is null;

-- Доп. кровать: не константа, цена вносится на каждый ретрит (п. 1.1, Приложение Б)
insert into crm_services (code, name_ru, name_en, category, unit, is_active, sort_order)
select 'extra_bed', 'Доп. кровать', 'Extra bed', 'accommodation', 'day', true, 55
 where not exists (select 1 from crm_services where code = 'extra_bed');

-- Шахматка для ОП — только просмотр
insert into role_permissions (role_id, permission_id)
select r.id, p.id
  from roles r, permissions p
 where r.code in ('sales_manager', 'sales_head') and p.code = 'view_timeline'
   and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id);

-- Переводы новых пунктов меню и вкладок
insert into translations (key, ru, en, hi) values
('nav_crm_timeline', 'Шахматка', 'Timeline', 'टाइमलाइन'),
('crm_prices_tab_retreat', 'Ретрит', 'Retreat', 'रिट्रीट'),
('crm_prices_tab_transport', 'Трансфер и выездные', 'Transfer & trips', 'स्थानांतरण और यात्राएँ'),
('crm_prices_transport_hint', 'Справочные цены для менеджера: такси, парикрамы, выездные программы. Не входят в расчёт стоимости ретрита — трансфер организуется отдельно.', 'Reference prices for managers: taxi, parikramas, trips. Not part of the retreat price calculation.', 'प्रबंधक के लिए संदर्भ मूल्य: टैक्सी, परिक्रमा, यात्राएँ।'),
('crm_price_change_confirm', 'Цена уже сохранена. Точно изменить?', 'This price is already saved. Change it?', 'यह मूल्य पहले से सहेजा गया है। बदलें?'),
('crm_price_building', 'Здание', 'Building', 'भवन'),
('crm_price_capacity', 'Мест', 'Beds', 'बिस्तर')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
