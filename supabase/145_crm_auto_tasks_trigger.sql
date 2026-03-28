-- ============================================
-- Миграция 145: Автозадачи при смене статуса сделки
-- ============================================

CREATE OR REPLACE FUNCTION crm_auto_tasks()
RETURNS TRIGGER AS $$
DECLARE
  guest_name TEXT;
BEGIN
  -- Получаем имя гостя
  SELECT COALESCE(spiritual_name, first_name || ' ' || COALESCE(last_name, ''))
  INTO guest_name
  FROM vaishnavas WHERE id = NEW.vaishnava_id;

  -- 1. Новая сделка → задача «Связаться» (дедлайн 24ч, приоритет high)
  IF TG_OP = 'INSERT' AND NEW.status = 'lead' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Связаться с ' || guest_name, NOW() + INTERVAL '24 hours', 'high', NEW.manager_id);
  END IF;

  -- 2. Статус → cancelled → follow-up через 30 дней
  IF TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Follow-up: предложить ' || guest_name || ' следующий ретрит', NOW() + INTERVAL '30 days', 'low', NEW.manager_id);
  END IF;

  -- 3. Статус → contacted → задача «Уточнить детали» через 48ч
  IF TG_OP = 'UPDATE' AND NEW.status = 'contacted' AND OLD.status = 'lead' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Уточнить детали у ' || guest_name, NOW() + INTERVAL '48 hours', 'normal', NEW.manager_id);
  END IF;

  -- 4. Статус → invoice_sent → напомнить об оплате через 5 дней
  IF TG_OP = 'UPDATE' AND NEW.status = 'invoice_sent' AND OLD.status != 'invoice_sent' THEN
    INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id)
    VALUES (NEW.id, 'Напомнить об оплате ' || guest_name, NOW() + INTERVAL '5 days', 'normal', NEW.manager_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_auto_tasks_trigger ON crm_deals;

CREATE TRIGGER crm_auto_tasks_trigger
  AFTER INSERT OR UPDATE OF status ON crm_deals
  FOR EACH ROW
  EXECUTE FUNCTION crm_auto_tasks();
