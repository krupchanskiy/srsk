-- Триггер для логирования бронирования номера в историю сделки CRM
-- Фиксирует момент когда сделка связывается с бронью (booking_id меняется NULL → значение)
-- Это решает проблему гонки времени: триггер на residents INSERT не находил сделку,
-- потому что crm_deals.booking_id устанавливается ПОСЛЕ вставки residents.

-- Убираем старый нерабочий триггер INSERT на residents
DROP TRIGGER IF EXISTS trg_crm_log_placement_insert ON residents;
DROP FUNCTION IF EXISTS fn_crm_log_placement_insert();

-- Новая функция: срабатывает когда deal.booking_id меняется NULL → значение
CREATE OR REPLACE FUNCTION fn_crm_log_deal_booking_linked()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    v_room_number text;
    v_building_name text;
    v_vaishnava_id uuid;
BEGIN
    -- Срабатываем только когда booking_id меняется с NULL на значение
    IF OLD.booking_id IS NOT NULL OR NEW.booking_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Получаем информацию о комнате через residents
    SELECT r.number, b.name_ru
    INTO v_room_number, v_building_name
    FROM residents res
    JOIN rooms r ON r.id = res.room_id
    JOIN buildings b ON b.id = r.building_id
    WHERE res.booking_id = NEW.booking_id
    LIMIT 1;

    -- Если комната не назначена — не логируем
    IF v_room_number IS NULL THEN
        RETURN NEW;
    END IF;

    -- Автор действия (текущий пользователь)
    SELECT id INTO v_vaishnava_id FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1;

    -- Записываем в историю сделки
    INSERT INTO crm_communications (deal_id, type, summary, created_by)
    VALUES (
        NEW.id,
        'placement',
        'Номер забронирован: ' || COALESCE(v_building_name, '') || ', комн. ' || COALESCE(v_room_number, ''),
        v_vaishnava_id
    );

    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_crm_log_deal_booking_linked ON crm_deals;
CREATE TRIGGER trg_crm_log_deal_booking_linked
    AFTER UPDATE ON crm_deals
    FOR EACH ROW
    EXECUTE FUNCTION fn_crm_log_deal_booking_linked();
