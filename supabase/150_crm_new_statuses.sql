-- Обновление статусов воронки CRM
-- Старые: lead → contacted → paid → ready → completed + cancelled
-- Новые:  lead → working → invoiced → booked → checklist → ready → completed + cancelled

-- 1. Сбросить старый constraint
ALTER TABLE crm_deals DROP CONSTRAINT IF EXISTS crm_deals_status_check;

-- 2. Мигрировать существующие данные
UPDATE crm_deals SET status = 'working' WHERE status = 'contacted';
UPDATE crm_deals SET status = 'booked'  WHERE status = 'paid';

-- 3. Добавить новый constraint
ALTER TABLE crm_deals ADD CONSTRAINT crm_deals_status_check
  CHECK (status = ANY (ARRAY[
    'lead'::text,
    'working'::text,
    'invoiced'::text,
    'booked'::text,
    'checklist'::text,
    'ready'::text,
    'completed'::text,
    'cancelled'::text
  ]));

-- 4. Обновить авто-задачи (contacted → working, paid → booked)
CREATE OR REPLACE FUNCTION crm_auto_tasks()
RETURNS TRIGGER LANGUAGE plpgsql AS $func$
DECLARE guest_name TEXT;
BEGIN
    SELECT COALESCE(spiritual_name, first_name || ' ' || COALESCE(last_name, ''))
    INTO guest_name FROM vaishnavas WHERE id = NEW.vaishnava_id;

    -- Новая заявка → задача "Связаться"
    IF TG_OP = 'INSERT' AND NEW.status = 'lead' THEN
        INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
        VALUES (NEW.id, 'Связаться с ' || guest_name, NOW() + INTERVAL '24 hours', 'high', NEW.manager_id);
    END IF;

    -- Отказ → задача "Follow-up через 30 дней"
    IF TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
        INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
        VALUES (NEW.id, 'Follow-up: предложить ' || guest_name || ' следующий ретрит', NOW() + INTERVAL '30 days', 'low', NEW.manager_id);
    END IF;

    -- В работе → задача "Уточнить детали"
    IF TG_OP = 'UPDATE' AND NEW.status = 'working' AND OLD.status = 'lead' THEN
        INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
        VALUES (NEW.id, 'Уточнить детали у ' || guest_name, NOW() + INTERVAL '48 hours', 'normal', NEW.manager_id);
    END IF;

    -- Оплачена бронь → задача "Подготовить к заезду"
    IF TG_OP = 'UPDATE' AND NEW.status = 'booked' AND OLD.status != 'booked' THEN
        INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
        VALUES (NEW.id, 'Подготовить к заезду ' || guest_name, NOW() + INTERVAL '3 days', 'normal', NEW.manager_id);
    END IF;

    RETURN NEW;
END;
$func$;
