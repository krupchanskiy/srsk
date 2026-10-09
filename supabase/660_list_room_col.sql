-- 660: «Номер комнаты» в предпросмотре «Вставить список» (ВГ, 09.10.2026).
insert into translations (key, ru, en, hi, page)
select 'timeline_list_room_col', 'Номер комнаты', 'Room number', 'कमरा नंबर', 'timeline'
 where not exists (select 1 from translations where key = 'timeline_list_room_col');
