-- 584: бронь — папка с местами шахматки (ВГ, 29.09.2026, схема «шахматка главная»).
-- Бронь не хранит ничего своего, что может разойтись с шахматкой: при любой правке места
-- (шахматка, «Предварительные», карточка человека, оплата) база пересчитывает бронь:
--   • даты брони = от первого заезда до последнего выезда её мест;
--   • число мест = сколько мест брони стоит в шахматке;
--   • все места убраны / отменены → бронь снята (как в 583).
-- Статус «предстоящая / не заселились / заселена / выехали» не хранится —
-- страница «Бронирования» считает его по местам и отметке «заехал».
-- Разовое выравнивание (выполнено 29.09 после проверки списка, 34 брони: 8 актуальных —
-- Василий Зябов 01.10→15.07, «4 прабху» 4→2 места, Тарини 12→5 и др., 26 прошлых):
--   update bookings b set check_in = мин. заезд мест, check_out = макс. выезд, beds_count = число мест
--    where живая бронь с местами и что-то из этого расходится.

create or replace function trg_booking_follows_residents()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
    v_ids uuid[];
    v_bk uuid;
    v_n int; v_in date; v_out date;
begin
    -- какие брони задеты: прежняя (снятие/перенос) и новая (добавление/перенос)
    if tg_op in ('UPDATE', 'DELETE') then v_ids := array_append(v_ids, old.booking_id); end if;
    if tg_op in ('INSERT', 'UPDATE') then v_ids := array_append(v_ids, new.booking_id); end if;
    foreach v_bk in array coalesce(v_ids, '{}') loop
        continue when v_bk is null;
        select count(*), min(check_in), max(coalesce(check_out, check_in))
          into v_n, v_in, v_out
          from residents where booking_id = v_bk and status <> 'cancelled';
        if v_n = 0 then
            -- снимаем только когда место действительно убрали — не при создании брони
            if tg_op <> 'INSERT' then
                update bookings
                   set status = 'cancelled',
                       notes = concat_ws(E'\n', nullif(notes, ''),
                           'Снята ' || to_char(now() at time zone 'Asia/Kolkata', 'DD.MM.YYYY') || ': места убраны из шахматки')
                 where id = v_bk and status in ('active', 'confirmed');
            end if;
        else
            update bookings
               set check_in = v_in, check_out = v_out, beds_count = v_n
             where id = v_bk and status in ('active', 'confirmed')
               and (check_in, check_out, beds_count) is distinct from (v_in, v_out, v_n);
        end if;
    end loop;
    return null;
end;
$$;

drop trigger if exists trg_booking_follows_residents on residents;
create trigger trg_booking_follows_residents
    after insert or delete or update of status, booking_id, check_in, check_out on residents
    for each row execute function trg_booking_follows_residents();
