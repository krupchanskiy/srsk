-- =============================================================
-- Финансовый модуль, Этап 1а: вспомогательные функции ядра
-- Курсы, остатки, валидация payload, детерминированные child-UUID,
-- view остатков счетов.
-- =============================================================

-- -------------------------------------------------------------
-- Выбор курса (ТЗ 4.7): 1) курс объекта с MAX(effective_date) <= даты;
-- 2) общий курс тем же правилом; 3) отказ.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_get_rate(
  p_from_currency text,
  p_object_id     uuid,
  p_on            date
) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_rate numeric;
BEGIN
  IF p_from_currency = 'INR' THEN
    RETURN 1.0;
  END IF;

  IF p_object_id IS NOT NULL THEN
    SELECT rate INTO v_rate
    FROM fin_exchange_rates
    WHERE from_currency = p_from_currency AND object_id = p_object_id AND effective_date <= p_on
    ORDER BY effective_date DESC
    LIMIT 1;
    IF FOUND THEN RETURN v_rate; END IF;
  END IF;

  SELECT rate INTO v_rate
  FROM fin_exchange_rates
  WHERE from_currency = p_from_currency AND object_id IS NULL AND effective_date <= p_on
  ORDER BY effective_date DESC
  LIMIT 1;
  IF FOUND THEN RETURN v_rate; END IF;

  RAISE EXCEPTION 'exchange_rate_missing'
    USING DETAIL = format('Нет курса %s→INR на %s — внесите курс в справочник', p_from_currency, p_on);
END;
$$;

-- -------------------------------------------------------------
-- Остаток счёта (весь или по чекпоинту)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_account_balance(
  p_account_id uuid,
  p_cutoff_seq bigint DEFAULT NULL
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
  FROM fin_postings
  WHERE account_id = p_account_id
    AND (p_cutoff_seq IS NULL OR ledger_seq <= p_cutoff_seq);
$$;

-- -------------------------------------------------------------
-- Валидация payload: неизвестные поля отклоняются (Guide 8.2)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_assert_keys(p_payload jsonb, p_allowed text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_extra text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ожидается JSON-объект';
  END IF;
  SELECT k INTO v_extra FROM jsonb_object_keys(p_payload) AS k WHERE k <> ALL (p_allowed) LIMIT 1;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Неизвестное поле: %s', v_extra);
  END IF;
END;
$$;

-- Типизированные геттеры: дружелюбная ошибка вместо голого cast-fail
CREATE OR REPLACE FUNCTION fin_private_get_uuid(p jsonb, k text, required boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text;
BEGIN
  v := NULLIF(p->>k, '');
  IF v IS NULL THEN
    IF required THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s обязательно', k); END IF;
    RETURN NULL;
  END IF;
  RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s: некорректный UUID', k);
END;
$$;

CREATE OR REPLACE FUNCTION fin_private_get_money(p jsonb, k text, required boolean DEFAULT false) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v text;
  n numeric;
BEGIN
  v := NULLIF(p->>k, '');
  IF v IS NULL THEN
    IF required THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s обязательно', k); END IF;
    RETURN NULL;
  END IF;
  n := v::numeric;
  IF n <= 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s: сумма должна быть > 0', k);
  END IF;
  RETURN round(n, 2);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s: некорректная сумма', k);
END;
$$;

CREATE OR REPLACE FUNCTION fin_private_get_date(p jsonb, k text, required boolean DEFAULT false) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text;
BEGIN
  v := NULLIF(p->>k, '');
  IF v IS NULL THEN
    IF required THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s обязательно', k); END IF;
    RETURN NULL;
  END IF;
  RETURN v::date;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
  RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Поле %s: некорректная дата (ожидается YYYY-MM-DD)', k);
END;
$$;

-- -------------------------------------------------------------
-- Детерминированный дочерний UUID (например, reversal внутри
-- replace_opening): повтор команды даёт те же id
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_child_uuid(p_parent uuid, p_tag text) RETURNS uuid
LANGUAGE sql IMMUTABLE
AS $$
  SELECT substring(encode(extensions.digest(convert_to(p_parent::text || ':' || p_tag, 'UTF8'), 'sha256'), 'hex') FROM 1 FOR 32)::uuid;
$$;

-- -------------------------------------------------------------
-- Идемпотентность операций: вернуть существующий результат по id,
-- конфликт при другом hash, NULL если операции нет.
-- Проверяется ПЕРВЫМ шагом каждой создающей RPC (инвариант 6).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_idempotency_check(p_request_id uuid, p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op fin_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_op FROM fin_operations WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_op.request_hash <> p_hash THEN
    RAISE EXCEPTION 'idempotency_conflict'
      USING DETAIL = 'Тот же request_id уже использован с другим содержимым формы';
  END IF;
  RETURN fin_private_operation_result(p_request_id);
END;
$$;

-- Стандартный result для операции (используется и при первом ответе,
-- и при идемпотентном повторе)
CREATE OR REPLACE FUNCTION fin_private_operation_result(p_operation_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'operation_id', o.id,
    'type', o.type,
    'occurred_on', o.occurred_on,
    'approval', o.approval,
    'postings', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'ledger_seq', p.ledger_seq,
        'account_id', p.account_id,
        'direction', p.direction,
        'amount', p.amount,
        'currency_code', p.currency_code,
        'amount_base', p.amount_base,
        'rate_used', p.rate_used,
        'is_post_close', p.is_post_close
      ) ORDER BY p.ledger_seq)
      FROM fin_postings p WHERE p.operation_id = o.id
    )
  )
  FROM fin_operations o WHERE o.id = p_operation_id;
$$;

-- -------------------------------------------------------------
-- View остатков счетов: админ/наблюдатель видят все, пользователь
-- счетов — только свои (fin_account_access)
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_account_balances AS
SELECT
  a.id AS account_id,
  a.name,
  a.kind,
  a.reconciliation_mode,
  a.currency_code,
  a.group_name,
  a.responsible_person_id,
  a.default_cost_center_id,
  a.is_active,
  COALESCE(s.balance, 0)::numeric(14,2) AS balance,
  s.last_ledger_seq,
  (COALESCE(s.balance, 0) < 0) AS is_negative
FROM fin_accounts a
LEFT JOIN (
  SELECT account_id,
         SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END) AS balance,
         MAX(ledger_seq) AS last_ledger_seq
  FROM fin_postings
  GROUP BY account_id
) s ON s.account_id = a.id
WHERE fin_can_read_all()
   OR EXISTS (
        SELECT 1 FROM fin_account_access aa
        WHERE aa.account_id = a.id AND aa.user_id = auth.uid()
      );

GRANT SELECT ON fin_v_account_balances TO authenticated;

-- -------------------------------------------------------------
-- Права на внутренние функции
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION fin_private_get_rate(text, uuid, date)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_account_balance(uuid, bigint)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_assert_keys(jsonb, text[])             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_get_uuid(jsonb, text, boolean)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_get_money(jsonb, text, boolean)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_get_date(jsonb, text, boolean)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_child_uuid(uuid, text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_idempotency_check(uuid, text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_operation_result(uuid)                 FROM PUBLIC, anon, authenticated;
