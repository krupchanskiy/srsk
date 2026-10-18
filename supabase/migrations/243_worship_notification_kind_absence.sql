-- Отметка недоступности пишет событие, значит её вид должен быть разрешён:
-- иначе человек, заболевший в четыре утра, получает ошибку вместо отметки.
alter table worship_notifications drop constraint if exists worship_notifications_kind_check;
alter table worship_notifications add constraint worship_notifications_kind_check
    check (kind in ('submitted', 'approved', 'returned', 'remark', 'stale',
                    'kit_granted', 'absence_set'));
