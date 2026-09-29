-- 583: бронь следует за шахматкой (ВГ, 29.09.2026).
-- Уджвалу Расу убрали из шахматки, а её бронь осталась «живой» без единого места —
-- в «Бронированиях» висела как предстоящая, в окне группы — «бронь без мест».
-- Теперь, когда место брони удаляют из шахматки (или отменяют / переносят в другую бронь):
--   • у брони ещё есть места → число мест брони = сколько осталось;
--   • мест не осталось → бронь снята (status 'cancelled', пометка в заметке) и уходит
--     во вкладку «Прошедшие».
-- Только при снятии места: брони, которые ещё не расставляли по номерам (заявки без мест),
-- не трогаются. Уже висящие пустые брони этот триггер не чистит.

create or replace function trg_booking_follows_residents()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
    v_bk uuid := old.booking_id;
    v_left int;
begin
    if v_bk is null or old.status = 'cancelled' then return null; end if;
    -- обновление, которое место не снимает, — не наше
    if tg_op = 'UPDATE' and new.booking_id is not distinct from old.booking_id
       and new.status is not distinct from old.status then
        return null;
    end if;
    if tg_op = 'UPDATE' and new.booking_id is not distinct from old.booking_id
       and new.status <> 'cancelled' then
        return null;
    end if;
    select count(*) into v_left from residents where booking_id = v_bk and status <> 'cancelled';
    if v_left = 0 then
        update bookings
           set status = 'cancelled',
               notes = concat_ws(E'\n', nullif(notes, ''),
                   'Снята ' || to_char(now() at time zone 'Asia/Kolkata', 'DD.MM.YYYY') || ': места убраны из шахматки')
         where id = v_bk and status in ('active', 'confirmed');
    else
        update bookings set beds_count = v_left
         where id = v_bk and status in ('active', 'confirmed') and beds_count > v_left;
    end if;
    return null;
end;
$$;

drop trigger if exists trg_booking_follows_residents on residents;
create trigger trg_booking_follows_residents
    after delete or update of status, booking_id on residents
    for each row execute function trg_booking_follows_residents();
