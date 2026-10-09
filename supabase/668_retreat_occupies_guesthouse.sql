-- Ретрит занимает весь Гостевой дом (ВГ 09.10.2026, случай Нарендры в БВПутешествии).
-- true — бронь человека не из этого ретрита в номер Гостевого дома на ночи ретрита
--        даёт предупреждение (js/house-guard.js), впритык (выезд в день заезда,
--        заезд в день разъезда) — вопрос «успеете убрать?». Не запрет.
-- false — ретрит живёт в части номеров или не в Гостевом доме: молчим.
-- null — не отвечено: карточка ретрита спросит при сохранении (защита от забывчивости).

alter table retreats add column if not exists occupies_guesthouse boolean;

comment on column retreats.occupies_guesthouse is
    'Занимает весь Гостевой дом: true — предупреждать о чужих бронях на его ночи, false — нет, null — не отвечено (спросит карточка ретрита)';

update retreats set occupies_guesthouse = true
where id in ('21711b68-9d09-4125-be90-360b4bc690bb',   -- Дикша Ретрит Бхакти Вигьяны Госвами
             '4e47a4f6-5141-4829-abde-f99e646da8a8',   -- БВПутешествие
             'cd310ffb-40c6-413a-bf5a-ab8afb6d1e70');  -- БВПаломничество

update retreats set occupies_guesthouse = false
where id in ('1ce123cc-b2ec-48c1-b675-23c46ea0a40c',   -- Группа Говинда Махараджа
             '0bf47193-a6e9-4156-92cf-fc430fbc88a0');  -- Группа Бхакти Чайтаньи Свами

-- Дополнено 09.10 по ответу ВГ (текущие и будущие ретриты; прошлые не трогаем):
update retreats set occupies_guesthouse = true
where id in ('059b86b3-7411-4343-a46a-10bbb5e18e08',   -- Лила-киртан-ретрит 2027
             '9528ac06-b09a-4806-84a5-139b3d0fe6f5',   -- Бхагаватам-ретрит 2027
             '2cb6adba-ea24-4189-917f-44b9e08b810f')   -- Фестиваль Шри-Шри Радхи Говинды 2027
  and occupies_guesthouse is null;
update retreats set occupies_guesthouse = false
where id = '75826808-76b4-4b9b-bace-1d70140fe30c'      -- Ретрит Художников
  and occupies_guesthouse is null;
