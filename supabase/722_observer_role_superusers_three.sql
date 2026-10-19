-- 722: суперпользователей трое; остальным — «Наблюдатель» (ВГ 19.10).
-- Суперпользователь мог смотреть и МЕНЯТЬ всё вне Финансов. Теперь суперпользователи только
-- ВГ, Ачинтья Кришна и Нитья-виласини. Бывшим суперпользователям — роль «Наблюдатель»:
-- видит все разделы (кроме Финансов, цен продуктов и служебных настроек), ничего не меняет.
-- Менять человек может только то, что дают его роли, — свой департамент
-- (Сундара Рупа — вся кухня: Шеф-повар, Завскладом, цены; Олег — CRM; Премамрита — Поклонение).
-- Сварупананде (роль «Гость», входил только в марте) наблюдателя не даём — только снимаем отметку.

insert into roles (code, name_ru, name_en, name_hi, description_ru, description_en, color, is_system, sort_order)
select 'observer', 'Наблюдатель', 'Observer', 'पर्यवेक्षक',
       'Видит все разделы, кроме Финансов, цен продуктов и служебных настроек; ничего не меняет',
       'Sees every section except Finance, product prices and system settings; changes nothing',
       '#64748b', false, 2
 where not exists (select 1 from roles where code = 'observer');

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where r.code = 'observer'
   and (p.code like 'view\_%' or p.code in ('worship_view', 'shop_analytics'))
   and p.code not in ('view_prices', 'view_translations', 'view_own_bookings')
   and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id);

-- наблюдатель — 15 бывшим суперпользователям (кроме Сварупананды)
insert into user_roles (user_id, role_id, is_active, assigned_at)
select u.uid, r.id, true, now()
  from roles r,
       unnest(array[
         '4bc604f3-d094-43e4-8d7f-beae833cf9bb',  -- Сундара Рупа (Кухня)
         '03549bcd-2d37-4b7b-978d-eb3279753df0',  -- Олег Карпов (Отдел продаж)
         '22d84f52-9f46-43a1-afea-bcb091e1f105',  -- Премамрита (Поклонение)
         '61d7fda5-be84-42e7-a1c6-8dcf3c476056',  -- Мани Манджари (Мастерская)
         '54691e8e-3eee-4599-820f-f868af0f11ec',  -- Дина Харидас
         '877f5a98-5ae2-43fb-a723-dfe80fa19bac',  -- Нарада
         '24be9dc1-09aa-4bd6-a4f6-7a424b0bcb82',  -- Ирина Чичак
         'acf9aa7c-a39b-4c65-b02e-cffd73940ce0',  -- Владимир Иванов
         '9caedf49-21a0-467b-bac4-f2307617aae5',  -- Светлана Сазонова
         '81adef33-2af7-4b06-a4b0-a9a6f67fee27',  -- Рати-кели
         '2c94394f-f9a4-4bd2-a14d-a08936ac26dc',  -- Ранганатх
         '7cf9baeb-ba64-4a51-bb50-605b4347584e',  -- Кунджавасини
         'f0b29bb7-9073-4dbf-b2e3-7eaf284f15e6',  -- Аударья-вилас
         '65d786b0-7dff-4c90-886e-413b39f77e3f',  -- Васудева Датта
         '3e38b28a-0bda-478d-b021-a9033541b7c6'   -- Рати Манджари
       ]::uuid[]) as u(uid)
 where r.code = 'observer'
   and not exists (select 1 from user_roles ur where ur.user_id = u.uid and ur.role_id = r.id);

-- Премамрита — глава Поклонения: «старший пуджари» (смотреть, писать, утверждать)
insert into user_roles (user_id, role_id, is_active, assigned_at)
select '22d84f52-9f46-43a1-afea-bcb091e1f105'::uuid, r.id, true, now()
  from roles r
 where r.code = 'worship_senior'
   and not exists (select 1 from user_roles ur where ur.user_id = '22d84f52-9f46-43a1-afea-bcb091e1f105' and ur.role_id = r.id);

-- снять отметку суперпользователя у 16
update vaishnavas set is_superuser = false
 where is_superuser and user_id in (
   '4bc604f3-d094-43e4-8d7f-beae833cf9bb', '03549bcd-2d37-4b7b-978d-eb3279753df0', '22d84f52-9f46-43a1-afea-bcb091e1f105',
   '61d7fda5-be84-42e7-a1c6-8dcf3c476056', '54691e8e-3eee-4599-820f-f868af0f11ec', '877f5a98-5ae2-43fb-a723-dfe80fa19bac',
   '24be9dc1-09aa-4bd6-a4f6-7a424b0bcb82', 'acf9aa7c-a39b-4c65-b02e-cffd73940ce0', '9caedf49-21a0-467b-bac4-f2307617aae5',
   '81adef33-2af7-4b06-a4b0-a9a6f67fee27', '2c94394f-f9a4-4bd2-a14d-a08936ac26dc', '7cf9baeb-ba64-4a51-bb50-605b4347584e',
   'f0b29bb7-9073-4dbf-b2e3-7eaf284f15e6', '65d786b0-7dff-4c90-886e-413b39f77e3f', '3e38b28a-0bda-478d-b021-a9033541b7c6',
   '74e6f828-6b2c-4ccd-b835-1e076dbe9bbd');
