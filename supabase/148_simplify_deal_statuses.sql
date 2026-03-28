-- ============================================
-- Миграция 148: Упрощение воронки CRM до 6 статусов
-- Было: lead, contacted, invoice_sent, prepaid, tickets, room_booked, checked_in, fully_paid, completed, upsell, cancelled
-- Стало: lead, contacted, paid, ready, completed, cancelled
-- ============================================

-- 1. Обновить существующие сделки на новые статусы
UPDATE crm_deals SET status = 'paid' WHERE status IN ('prepaid', 'fully_paid', 'tickets');
UPDATE crm_deals SET status = 'contacted' WHERE status = 'invoice_sent';
UPDATE crm_deals SET status = 'ready' WHERE status IN ('room_booked', 'checked_in');
UPDATE crm_deals SET status = 'completed' WHERE status = 'upsell';

-- 2. Заменить CHECK constraint
ALTER TABLE crm_deals DROP CONSTRAINT IF EXISTS crm_deals_status_check;
ALTER TABLE crm_deals ADD CONSTRAINT crm_deals_status_check
  CHECK (status IN ('lead', 'contacted', 'paid', 'ready', 'completed', 'cancelled'));

-- 3. Обновить триггер автозадач (убрать invoice_sent, добавить paid)
CREATE OR REPLACE FUNCTION crm_auto_tasks()
RETURNS TRIGGER AS $$
DECLARE
  guest_name TEXT;
BEGIN
  SELECT COALESCE(spiritual_name, first_name || ' ' || COALESCE(last_name, ''))
  INTO guest_name
  FROM vaishnavas WHERE id = NEW.vaishnava_id;

  -- Новая сделка → задача «Связаться» (дедлайн 24ч, приоритет high)
  IF TG_OP = 'INSERT' AND NEW.status = 'lead' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Связаться с ' || guest_name, NOW() + INTERVAL '24 hours', 'high', NEW.manager_id);
  END IF;

  -- Статус → cancelled → follow-up через 30 дней
  IF TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Follow-up: предложить ' || guest_name || ' следующий ретрит', NOW() + INTERVAL '30 days', 'low', NEW.manager_id);
  END IF;

  -- Статус → contacted → задача «Уточнить детали» через 48ч
  IF TG_OP = 'UPDATE' AND NEW.status = 'contacted' AND OLD.status = 'lead' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Уточнить детали у ' || guest_name, NOW() + INTERVAL '48 hours', 'normal', NEW.manager_id);
  END IF;

  -- Статус → paid → задача «Подготовить к заезду» через 3 дня
  IF TG_OP = 'UPDATE' AND NEW.status = 'paid' AND OLD.status = 'contacted' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Подготовить к заезду ' || guest_name, NOW() + INTERVAL '3 days', 'normal', NEW.manager_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Добавить переводы для новых статусов
INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_status_paid', 'Оплачено', 'Paid', 'भुगतान'),
  ('crm_status_ready', 'Готов', 'Ready', 'तैयार')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;

-- 5. Удалить переводы старых статусов
DELETE FROM translations WHERE key IN (
  'crm_status_invoice_sent', 'crm_status_prepaid', 'crm_status_tickets',
  'crm_status_room_booked', 'crm_status_checked_in', 'crm_status_fully_paid',
  'crm_status_upsell'
);
