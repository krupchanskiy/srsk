-- =============================================================================
-- Миграция 170: Страховочный триггер автоназначения менеджера на новую сделку
-- =============================================================================
-- Если в crm_deals.manager_id приходит NULL (например, бот rupaseva_telegram
-- забыл проставить — кейс 25.06.2026 со сделкой Ольги Гущиной), БД сама
-- выбирает следующего активного менеджера по round-robin и обновляет
-- crm_manager_queue.last_assigned_at.
--
-- Логика выбора:
--   1) Если у сделки указан retreat_id — менеджер из пересечения
--      crm_retreat_managers (этот ретрит, is_active) и crm_manager_queue
--      (is_active), сортировка по last_assigned_at NULLS FIRST.
--   2) Если нет ретрита или нет менеджеров на ретрите — берётся любой
--      активный из общей очереди по тому же критерию.
--
-- SECURITY DEFINER — на случай, если PostgREST-клиент (бот) ходит без прав
-- на UPDATE crm_manager_queue под RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION crm_assign_manager_if_missing()
RETURNS TRIGGER AS $$
DECLARE
    picked_id UUID;
BEGIN
    IF NEW.manager_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.retreat_id IS NOT NULL THEN
        SELECT q.manager_id INTO picked_id
          FROM crm_manager_queue q
          JOIN crm_retreat_managers rm
            ON rm.manager_id = q.manager_id
           AND rm.retreat_id = NEW.retreat_id
         WHERE q.is_active = TRUE AND rm.is_active = TRUE
         ORDER BY q.last_assigned_at NULLS FIRST
         LIMIT 1;
    END IF;

    IF picked_id IS NULL THEN
        SELECT q.manager_id INTO picked_id
          FROM crm_manager_queue q
         WHERE q.is_active = TRUE
         ORDER BY q.last_assigned_at NULLS FIRST
         LIMIT 1;
    END IF;

    IF picked_id IS NOT NULL THEN
        NEW.manager_id := picked_id;
        UPDATE crm_manager_queue
           SET last_assigned_at = NOW()
         WHERE manager_id = picked_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS crm_deal_manager_backstop ON crm_deals;
CREATE TRIGGER crm_deal_manager_backstop
BEFORE INSERT ON crm_deals
FOR EACH ROW EXECUTE FUNCTION crm_assign_manager_if_missing();
