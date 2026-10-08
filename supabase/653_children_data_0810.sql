-- 653: данные по детям (ВГ, 08.10.2026, «Шахматка 9»), после 651/652.
-- 1) «Ребёнок подтверждён» — настоящие дети с датами рождения (жили с родителями, детское питание)
update vaishnavas set child_confirmed_at = now()
 where id in ('3a336ee7-0632-42c1-a4c6-8dcfc5afbf6a',   -- Хемагаури (2024), с Поповыми
              '62cc603d-dc35-4145-a40b-76255233d5d8',   -- Гауранга (2023), с мамой
              '68e2e4f6-e309-4d75-a143-8b8e3a969e1e',   -- Кристина Нигматьянова (2020)
              '62ca10a5-3be2-4ce5-906d-46d5d887a435',   -- София Нигматьянова (2016)
              '9deab59e-486d-4253-b44f-473db7321612',   -- Лила Елпашева (2014)
              '65c798f7-b069-41d6-807f-643572b27251',   -- Вришабхану Елпашев (2010)
              'fe39b43c-6ef9-4a34-8e43-ee1b01fdd136')   -- Ананда (2017)
   and child_confirmed_at is null;

-- 2) Одна и та же «детская» дата 16.03.2013 у двух взрослых, живших вдвоём, — опечатка (ВГ: убрать)
update vaishnavas set birth_date = null
 where id in ('e6f634b4-82c5-496d-8857-8fd00e8d35cf',   -- Дханя Зубова
              '5f032452-4695-43e2-b945-dba02d6e03b4')   -- Владлена Мартель
   and birth_date = '2013-03-16';

-- 3) Дикша-ретрит: «С ребёнком (без доп кровати)» в брони = «с Ре» в таблице организаторов —
--    «+1» к тому, кто с ребёнком (№1, 3, 4, 5, 8 Гостевого дома). Питание у мест выключено.
insert into resident_children (resident_id, guest_name)
select x.id, 'Ребёнок'
  from residents x
 where x.id in ('5fef9b32-edcf-4cc0-bd29-d92929f958e7',   -- №1 Chernova Anastasiia
                '7371c861-183c-4f67-9858-3c52bf0dfcec',   -- №3 Storozhilova Nadezhda
                'abfe2c6d-3b83-4662-9e47-4f6a54dd5969',   -- №4 Matveev Evgenii
                '0be9ab74-d904-46a7-9c55-59132c1bc422',   -- №5 Jaysinova Malika
                'bd99535e-b4a5-42a8-8467-3ec9f6baebfd')   -- №8 Tratsenka Nastassia
   and not exists (select 1 from resident_children k where k.resident_id = x.id);
