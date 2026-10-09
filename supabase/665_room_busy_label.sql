-- 665: полностью занятый номер в окне брони — «занят» вместо «нахлёст — нельзя» (ВГ, 09.10.2026).
update translations set ru = 'занят', en = 'taken', hi = 'भरा हुआ' where key = 'timeline_room_overlap';
