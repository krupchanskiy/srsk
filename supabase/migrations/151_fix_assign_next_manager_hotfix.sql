-- HOTFIX для миграции 147: функция assign_next_manager_for_retreat
-- использовала несуществующую колонку retreat_id в crm_manager_queue.
-- При вызове возвращала 400 "column retreat_id does not exist" —
-- лид-форма (crm/form.html) не могла назначить менеджера.
--
-- Правильная архитектура:
--   crm_manager_queue (manager_id, last_assigned_at, is_active)
--     — ГЛОБАЛЬНАЯ очередь round-robin (без retreat_id).
--   crm_retreat_managers (retreat_id, manager_id, is_active)
--     — связь «какие менеджеры работают с каким ретритом».
--
-- Новая логика:
--   1. Берём менеджеров, закреплённых за данным ретритом
--      (JOIN crm_retreat_managers.retreat_id = p_retreat_id).
--   2. Среди них выбираем того, у кого самая старая last_assigned_at
--      в глобальной очереди.
--   3. Обновляем его last_assigned_at.
--   4. FOR UPDATE OF q SKIP LOCKED — атомарная блокировка,
--      предотвращает race condition между одновременными лид-формами.
--
-- Применено на prod 2026-04-17.

CREATE OR REPLACE FUNCTION public.assign_next_manager_for_retreat(p_retreat_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_manager_id uuid;
BEGIN
  SELECT q.manager_id
    INTO v_manager_id
  FROM public.crm_manager_queue q
  JOIN public.crm_retreat_managers rm
    ON rm.manager_id = q.manager_id
  WHERE q.is_active = true
    AND rm.is_active = true
    AND rm.retreat_id = p_retreat_id
  ORDER BY q.last_assigned_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE OF q SKIP LOCKED;

  IF v_manager_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.crm_manager_queue
     SET last_assigned_at = now()
   WHERE manager_id = v_manager_id;

  RETURN v_manager_id;
END;
$$;
