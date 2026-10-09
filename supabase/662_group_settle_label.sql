-- 662: «Номера группы» → «Расселение группы» (кнопка в окне брони, карточка брони, заголовок окна при правке) (ВГ, 09.10.2026).
update translations set ru = 'Расселение группы', en = 'Group accommodation', hi = 'समूह का आवास'
 where key in ('timeline_group_rooms_btn', 'booking_rooms_seats', 'timeline_group_edit');
