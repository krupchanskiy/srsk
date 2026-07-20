-- =============================================================
-- Финансовый модуль, Этап 0: права, helpers авторизации,
-- утилиты идемпотентности, запрет прямого DML (RLS deny-all)
-- Роли финмодуля живут в существующей RBAC (permissions/role_permissions):
--   fin_admin        — администратор финансов (Ванамали Гопал, АК)
--   fin_observer     — наблюдатель (попечители, бухгалтер)
--   fin_account_user — пользователь счетов (руководители департаментов)
-- Участник ретрита отдельного права не требует — portal-RPC (Этап 3)
-- определяют его через vaishnavas.user_id = auth.uid().
-- =============================================================

-- Модуль «Финансы» в реестре модулей
INSERT INTO modules (code, name_ru, name_en, name_hi, sort_order)
SELECT 'finance', 'Финансы', 'Finance', 'वित्त', 50
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE code = 'finance');

-- Права
INSERT INTO permissions (module_id, code, name_ru, name_en, category, sort_order)
SELECT m.id, p.code, p.name_ru, p.name_en, 'finance', p.sort_order
FROM (VALUES
  ('fin_admin',        'Финансы: администратор',        'Finance: administrator', 1),
  ('fin_observer',     'Финансы: наблюдатель',          'Finance: observer',      2),
  ('fin_account_user', 'Финансы: пользователь счетов',  'Finance: account user',  3)
) AS p(code, name_ru, name_en, sort_order)
CROSS JOIN (SELECT id FROM modules WHERE code = 'finance') m
WHERE NOT EXISTS (SELECT 1 FROM permissions x WHERE x.code = p.code);

-- -------------------------------------------------------------
-- Helpers авторизации (каждая RPC проверяет права сама,
-- не полагаясь только на RLS)
-- -------------------------------------------------------------

-- Актор: auth.uid() или отказ
CREATE OR REPLACE FUNCTION fin_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION fin_is_admin(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_user IS NOT NULL
     AND (is_superuser(p_user) OR has_permission(p_user, 'fin_admin'));
$$;

CREATE OR REPLACE FUNCTION fin_is_observer(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND has_permission(p_user, 'fin_observer');
$$;

-- Чтение всех данных финмодуля: администратор или наблюдатель
CREATE OR REPLACE FUNCTION fin_can_read_all(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT fin_is_admin(p_user) OR fin_is_observer(p_user);
$$;

CREATE OR REPLACE FUNCTION fin_is_account_user(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND has_permission(p_user, 'fin_account_user');
$$;

-- Контакт актора: vaishnava, связанный с auth-пользователем (contacts = vaishnavas)
CREATE OR REPLACE FUNCTION fin_actor_contact_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1;
$$;

-- -------------------------------------------------------------
-- Утилиты идемпотентности (используются command-idempotent RPC)
-- -------------------------------------------------------------

-- SHA-256 канонизированного jsonb-payload.
-- jsonb в Postgres хранит ключи в детерминированном порядке, поэтому
-- одинаковое содержимое даёт одинаковый текст независимо от порядка
-- полей в исходном запросе. Нормализация значений (деньги до 2 знаков,
-- uuid в lowercase, '' -> NULL) — обязанность канонизатора каждой RPC.
CREATE OR REPLACE FUNCTION fin_private_hash(p_payload jsonb) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
$$;

-- Денежная сумма -> каноническая строка с 2 знаками (для payload-hash)
CREATE OR REPLACE FUNCTION fin_private_norm_money(p_amount numeric) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT to_char(round(p_amount, 2), 'FM999999999999990.00');
$$;

-- -------------------------------------------------------------
-- Запрет прямого DML: RLS включён, политик нет -> deny-all
-- для anon/authenticated. Чтение — только через будущие safe views
-- и RPC; запись — только через SECURITY DEFINER RPC.
-- -------------------------------------------------------------

ALTER TABLE fin_currencies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_cost_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_contractors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_audit_log    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON fin_currencies, fin_cost_centers, fin_categories, fin_contractors, fin_audit_log
  FROM anon, authenticated;

-- Внутренние функции недоступны клиентским ролям
REVOKE ALL ON FUNCTION fin_private_hash(jsonb)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_norm_money(numeric)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_attach_audit(text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_audit_row()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_audit_log_immutable()        FROM PUBLIC, anon, authenticated;

-- pgTAP для SQL-тестов финмодуля
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
