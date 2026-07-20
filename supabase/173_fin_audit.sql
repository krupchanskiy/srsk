-- =============================================================
-- Финансовый модуль, Этап 0: аудит-лог
-- Один триггер на все fin_-таблицы, кроме самой fin_audit_log.
-- State-RPC передают причину через transaction-local контекст:
--   set_config('app.change_reason', ..., true)
--   set_config('app.request_id', ..., true)
--   set_config('app.correlation_id', ..., true)
-- Лог append-only: UPDATE/DELETE блокируются триггером.
-- =============================================================

CREATE TABLE fin_audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity         text NOT NULL,
  entity_id      text,
  action         text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  before_data    jsonb,
  after_data     jsonb,
  user_id        uuid,
  reason         text,
  request_id     uuid,
  correlation_id uuid,
  at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fin_audit_log_entity_idx ON fin_audit_log (entity, entity_id, at DESC);

CREATE OR REPLACE FUNCTION fin_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
  ELSE
    v_before := to_jsonb(OLD);
  END IF;

  INSERT INTO public.fin_audit_log
    (entity, entity_id, action, before_data, after_data, user_id, reason, request_id, correlation_id)
  VALUES (
    TG_TABLE_NAME,
    -- fin_currencies живёт по текстовому PK code, остальные по uuid id
    COALESCE(v_after->>'id', v_before->>'id', v_after->>'code', v_before->>'code'),
    lower(TG_OP),
    v_before,
    v_after,
    auth.uid(),
    NULLIF(current_setting('app.change_reason', true), ''),
    NULLIF(current_setting('app.request_id', true), '')::uuid,
    NULLIF(current_setting('app.correlation_id', true), '')::uuid
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Подключение аудита к таблице — используется этой и всеми последующими
-- fin_-миграциями, чтобы триггер везде создавался единообразно
CREATE OR REPLACE FUNCTION fin_private_attach_audit(p_table text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_fin_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fin_audit_row()',
    p_table
  );
END;
$$;

SELECT fin_private_attach_audit(t)
FROM unnest(ARRAY['fin_currencies', 'fin_cost_centers', 'fin_categories', 'fin_contractors']) AS t;

CREATE OR REPLACE FUNCTION fin_audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fin_audit_log is append-only';
END;
$$;

CREATE TRIGGER trg_fin_audit_immutable
  BEFORE UPDATE OR DELETE ON fin_audit_log
  FOR EACH ROW EXECUTE FUNCTION fin_audit_log_immutable();
