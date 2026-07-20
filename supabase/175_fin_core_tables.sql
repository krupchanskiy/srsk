-- =============================================================
-- Финансовый модуль, Этап 1а: все оставшиеся таблицы DDL-контракта
-- (Implementation Guide v1.0, раздел 5; ТЗ v4.2.10, раздел 4)
-- Таблицы создаются полным комплектом, чтобы FK и проверки
-- (checkpoint, closure, post-close) существовали с первого дня;
-- RPC поздних этапов приходят своими миграциями.
-- =============================================================

-- -------------------------------------------------------------
-- 5.10 Учётные объекты (в MVP только ретриты)
-- -------------------------------------------------------------
CREATE TABLE fin_accounting_objects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            fin_object_type NOT NULL,
  retreat_id      uuid UNIQUE REFERENCES retreats(id),
  display_name    text NOT NULL,
  report_dirty_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_objects_retreat_link CHECK ((type = 'retreat') = (retreat_id IS NOT NULL))
);

-- -------------------------------------------------------------
-- 5.1 Счета
-- -------------------------------------------------------------
CREATE TABLE fin_accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  kind                   fin_account_kind NOT NULL,
  reconciliation_mode    fin_reconciliation_mode NOT NULL,
  currency_code          text NOT NULL REFERENCES fin_currencies(code),
  group_name             text,
  responsible_person_id  uuid REFERENCES vaishnavas(id),
  default_cost_center_id uuid REFERENCES fin_cost_centers(id),
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL
);

CREATE UNIQUE INDEX fin_accounts_active_name_uniq ON fin_accounts (name) WHERE is_active;

-- -------------------------------------------------------------
-- 5.2 Операции (id — клиентский request UUID)
-- -------------------------------------------------------------
CREATE TABLE fin_operations (
  id                          uuid PRIMARY KEY,
  request_hash                text NOT NULL,
  type                        fin_operation_type NOT NULL,
  occurred_on                 date NOT NULL,
  approval                    fin_approval NOT NULL,
  is_reversed                 boolean NOT NULL DEFAULT false,
  original_operation_id       uuid REFERENCES fin_operations(id),
  payer_contact_id            uuid REFERENCES vaishnavas(id),
  refund_recipient_contact_id uuid REFERENCES vaishnavas(id),
  reason                      text,
  comment                     text,
  created_by                  uuid NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  -- reversal <=> есть ссылка на исходную
  CONSTRAINT fin_operations_reversal_link
    CHECK ((type = 'reversal') = (original_operation_id IS NOT NULL)),
  -- reason обязательна для reversal и reconciliation_adjustment
  CONSTRAINT fin_operations_reason_required
    CHECK (type NOT IN ('reversal', 'reconciliation_adjustment') OR reason IS NOT NULL)
);

-- сторно сторно запрещено, значит одно reversal на операцию
CREATE UNIQUE INDEX fin_operations_one_reversal
  ON fin_operations (original_operation_id) WHERE type = 'reversal';

CREATE INDEX fin_operations_created_idx ON fin_operations (created_at DESC);
CREATE INDEX fin_operations_approval_idx ON fin_operations (approval)
  WHERE approval IN ('pending', 'disputed');

-- -------------------------------------------------------------
-- 5.3 Проводки (ledger_seq выдаётся ТОЛЬКО в RPC после FOR UPDATE счёта:
-- вставки идут исключительно из RPC, где блокировка уже взята)
-- -------------------------------------------------------------
CREATE SEQUENCE fin_ledger_seq;

CREATE TABLE fin_postings (
  id                       uuid PRIMARY KEY,
  ledger_seq               bigint NOT NULL UNIQUE DEFAULT nextval('fin_ledger_seq'),
  operation_id             uuid NOT NULL REFERENCES fin_operations(id),
  account_id               uuid NOT NULL REFERENCES fin_accounts(id),
  direction                fin_direction NOT NULL,
  amount                   numeric(14,2) NOT NULL CHECK (amount > 0),
  currency_code            text NOT NULL REFERENCES fin_currencies(code),
  amount_base              numeric(14,2) NOT NULL CHECK (amount_base >= 0),
  rate_used                numeric(12,6) NOT NULL CHECK (rate_used > 0),
  category_id              uuid REFERENCES fin_categories(id),
  cost_center_id           uuid REFERENCES fin_cost_centers(id),
  object_id                uuid REFERENCES fin_accounting_objects(id),
  is_post_close            boolean NOT NULL DEFAULT false,
  participant_id           uuid REFERENCES vaishnavas(id),
  participant_balance_kind fin_participant_balance_kind,
  refund_of_posting_id     uuid REFERENCES fin_postings(id),
  contractor_id            uuid REFERENCES fin_contractors(id),
  payment_channel          fin_payment_channel,
  CONSTRAINT fin_postings_participant_pair
    CHECK ((participant_id IS NULL) = (participant_balance_kind IS NULL)),
  CONSTRAINT fin_postings_post_close_needs_object
    CHECK (NOT is_post_close OR object_id IS NOT NULL)
);

CREATE INDEX fin_postings_account_seq_idx ON fin_postings (account_id, ledger_seq);
CREATE INDEX fin_postings_operation_idx ON fin_postings (operation_id);
CREATE INDEX fin_postings_object_idx ON fin_postings (object_id, ledger_seq) WHERE object_id IS NOT NULL;
CREATE INDEX fin_postings_participant_idx ON fin_postings (participant_id, object_id) WHERE participant_id IS NOT NULL;
CREATE INDEX fin_postings_refund_of_idx ON fin_postings (refund_of_posting_id) WHERE refund_of_posting_id IS NOT NULL;

-- -------------------------------------------------------------
-- 5.5 Курсы валют (объектный или общий, к INR)
-- -------------------------------------------------------------
CREATE TABLE fin_exchange_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id      uuid REFERENCES fin_accounting_objects(id),
  effective_date date NOT NULL,
  from_currency  text NOT NULL REFERENCES fin_currencies(code),
  rate           numeric(12,6) NOT NULL CHECK (rate > 0),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (object_id, effective_date, from_currency)
);

-- -------------------------------------------------------------
-- 5.8 Доступ пользователей к счетам
-- -------------------------------------------------------------
CREATE TABLE fin_account_access (
  user_id    uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES fin_accounts(id),
  PRIMARY KEY (user_id, account_id)
);

-- -------------------------------------------------------------
-- 5.4 Начисления участников (только INR; id — клиентский request UUID)
-- -------------------------------------------------------------
CREATE TABLE fin_charges (
  id               uuid PRIMARY KEY,
  request_hash     text NOT NULL,
  participant_id   uuid NOT NULL REFERENCES vaishnavas(id),
  retreat_id       uuid NOT NULL REFERENCES retreats(id),
  kind             fin_charge_kind NOT NULL,
  description      text NOT NULL,
  quantity         numeric NOT NULL CHECK (quantity > 0),
  unit_price       numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  amount           numeric(14,2) NOT NULL,
  discount_amount  numeric(14,2) NOT NULL DEFAULT 0,
  currency_code    text NOT NULL DEFAULT 'INR' CHECK (currency_code = 'INR'),
  discount_reason  text,
  is_cancelled     boolean NOT NULL DEFAULT false,
  cancelled_reason text,
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  creation_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  CONSTRAINT fin_charges_discount_range CHECK (discount_amount >= 0 AND discount_amount <= amount),
  CONSTRAINT fin_charges_discount_reason CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
  CONSTRAINT fin_charges_cancel_triple CHECK (
    (NOT is_cancelled AND cancelled_reason IS NULL AND cancelled_at IS NULL AND cancelled_by IS NULL)
    OR (is_cancelled AND cancelled_reason IS NOT NULL AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  )
);

CREATE INDEX fin_charges_participant_idx ON fin_charges (participant_id, retreat_id) WHERE NOT is_cancelled;

-- -------------------------------------------------------------
-- 5.11 Входящие позиции участников (cutover; только INR)
-- -------------------------------------------------------------
CREATE TABLE fin_participant_opening_balances (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id              uuid NOT NULL REFERENCES vaishnavas(id),
  retreat_id                  uuid NOT NULL REFERENCES retreats(id),
  amount                      numeric(14,2) NOT NULL CHECK (amount > 0),
  currency_code               text NOT NULL DEFAULT 'INR' CHECK (currency_code = 'INR'),
  kind                        fin_opening_position_kind NOT NULL,
  balance_kind                fin_participant_balance_kind NOT NULL
                                CHECK (balance_kind <> 'none'),
  source_document             text NOT NULL,
  corrects_opening_balance_id uuid REFERENCES fin_participant_opening_balances(id),
  request_hash                text,
  correction_reason           text,
  cutover_batch_id            uuid,
  source_row_id               text,
  source_payload_hash         text,
  comment                     text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid NOT NULL,
  UNIQUE (cutover_batch_id, source_document, source_row_id),
  -- коррекция несёт hash и причину; cutover-строка — нет
  CONSTRAINT fin_pob_correction_shape CHECK (
    (corrects_opening_balance_id IS NULL AND correction_reason IS NULL)
    OR (corrects_opening_balance_id IS NOT NULL AND correction_reason IS NOT NULL AND request_hash IS NOT NULL)
  ),
  CONSTRAINT fin_pob_no_self_reference CHECK (corrects_opening_balance_id <> id)
);

CREATE INDEX fin_pob_participant_idx ON fin_participant_opening_balances (participant_id, retreat_id);

-- -------------------------------------------------------------
-- 5.6 Сверки (RPC perform_reconciliation — Этап 2; таблица нужна
-- уже сейчас: create_opening/replace_opening проверяют отсутствие
-- чекпоинта)
-- -------------------------------------------------------------
CREATE TABLE fin_reconciliations (
  id                      uuid PRIMARY KEY,
  request_hash            text NOT NULL,
  account_id              uuid NOT NULL REFERENCES fin_accounts(id),
  performed_at            timestamptz NOT NULL DEFAULT now(),
  performed_by            uuid NOT NULL,
  system_balance          numeric(14,2) NOT NULL,
  counted_balance         numeric(14,2) NOT NULL,
  original_difference     numeric(14,2),
  difference              numeric(14,2) NOT NULL,
  cutoff_ledger_seq       bigint NOT NULL,
  adjustment_operation_id uuid REFERENCES fin_operations(id),
  counts                  jsonb,
  comment                 text,
  is_checkpoint           boolean NOT NULL
);

CREATE INDEX fin_reconciliations_account_idx ON fin_reconciliations (account_id, cutoff_ledger_seq DESC);

-- -------------------------------------------------------------
-- 5.9 Вложения (referential-триггер согласованности — Этап 5)
-- -------------------------------------------------------------
CREATE TABLE fin_attachments (
  id           uuid PRIMARY KEY,
  request_hash text NOT NULL,
  parent_type  fin_attachment_parent_type NOT NULL,
  parent_id    uuid NOT NULL,
  posting_id   uuid REFERENCES fin_postings(id),
  storage_path text NOT NULL UNIQUE,
  sha256       text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  file_name    text NOT NULL,
  uploaded_by  uuid NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_attachments_object_no_posting
    CHECK (parent_type <> 'accounting_object' OR posting_id IS NULL)
);

CREATE INDEX fin_attachments_parent_idx ON fin_attachments (parent_type, parent_id);

-- -------------------------------------------------------------
-- 5.12 Версии закрытия объектов (RPC — Этап 6; таблица нужна сейчас:
-- post-close-логика денежных RPC проверяет initial closure)
-- -------------------------------------------------------------
CREATE TABLE fin_object_closures (
  id                      uuid PRIMARY KEY,
  request_hash            text NOT NULL,
  object_id               uuid NOT NULL REFERENCES fin_accounting_objects(id),
  version                 int NOT NULL CHECK (version > 0),
  is_initial              boolean NOT NULL,
  status                  fin_closure_status NOT NULL,
  closed_at               timestamptz NOT NULL DEFAULT now(),
  closed_by               uuid NOT NULL,
  finalized_at            timestamptz,
  finalized_by            uuid,
  totals_snapshot         jsonb NOT NULL,
  snapshot_schema_version int NOT NULL,
  attachment_id           uuid REFERENCES fin_attachments(id),
  reason                  text,
  UNIQUE (object_id, version),
  CONSTRAINT fin_closures_initial_is_v1 CHECK (is_initial = (version = 1)),
  CONSTRAINT fin_closures_finalized_needs_pdf CHECK (status <> 'finalized' OR attachment_id IS NOT NULL),
  CONSTRAINT fin_closures_reissue_needs_reason CHECK (version = 1 OR reason IS NOT NULL)
);

CREATE UNIQUE INDEX fin_closures_one_initial ON fin_object_closures (object_id) WHERE is_initial;
CREATE INDEX fin_closures_object_idx ON fin_object_closures (object_id, version DESC);

-- -------------------------------------------------------------
-- Защитные триггеры (Guide 14.2): деньги проведённой операции
-- неизменны даже для ошибочно написанной RPC
-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION fin_postings_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fin_postings_immutable' USING DETAIL = 'Проводки не удаляются; исправление — только сторно';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.ledger_seq <> OLD.ledger_seq
     OR NEW.operation_id <> OLD.operation_id
     OR NEW.account_id <> OLD.account_id
     OR NEW.direction <> OLD.direction
     OR NEW.amount <> OLD.amount
     OR NEW.currency_code <> OLD.currency_code
     OR NEW.amount_base <> OLD.amount_base
     OR NEW.rate_used <> OLD.rate_used
     OR NEW.refund_of_posting_id IS DISTINCT FROM OLD.refund_of_posting_id THEN
    RAISE EXCEPTION 'fin_postings_immutable' USING DETAIL = 'Денежные поля проводки неизменны';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fin_postings_guard
  BEFORE UPDATE OR DELETE ON fin_postings
  FOR EACH ROW EXECUTE FUNCTION fin_postings_guard();

CREATE OR REPLACE FUNCTION fin_operations_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fin_operations_immutable' USING DETAIL = 'Операции не удаляются; исправление — только сторно';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.type <> OLD.type
     OR NEW.occurred_on <> OLD.occurred_on
     OR NEW.request_hash <> OLD.request_hash
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at
     OR NEW.original_operation_id IS DISTINCT FROM OLD.original_operation_id
     OR NEW.refund_recipient_contact_id IS DISTINCT FROM OLD.refund_recipient_contact_id THEN
    RAISE EXCEPTION 'fin_operations_immutable' USING DETAIL = 'Денежные метаданные операции неизменны';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fin_operations_guard
  BEFORE UPDATE OR DELETE ON fin_operations
  FOR EACH ROW EXECUTE FUNCTION fin_operations_guard();

-- Валидация строки проводки по типу операции (защита в глубину;
-- дружелюбные ошибки даёт RPC раньше этого триггера)
CREATE OR REPLACE FUNCTION fin_postings_validate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op   fin_operations%ROWTYPE;
  v_acc  fin_accounts%ROWTYPE;
  v_cat_direction fin_direction;
BEGIN
  SELECT * INTO v_op FROM fin_operations WHERE id = NEW.operation_id;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;

  IF NEW.currency_code <> v_acc.currency_code THEN
    RAISE EXCEPTION 'account_currency_mismatch'
      USING DETAIL = 'Валюта проводки не совпадает с валютой счёта';
  END IF;

  IF NEW.refund_of_posting_id IS NOT NULL AND v_op.type <> 'refund' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'refund_of_posting_id допустим только для refund';
  END IF;

  IF v_op.type IN ('transfer', 'opening', 'reconciliation_adjustment') THEN
    IF NEW.category_id IS NOT NULL OR NEW.cost_center_id IS NOT NULL OR NEW.object_id IS NOT NULL
       OR NEW.participant_id IS NOT NULL OR NEW.participant_balance_kind IS NOT NULL
       OR NEW.contractor_id IS NOT NULL OR NEW.payment_channel IS NOT NULL THEN
      RAISE EXCEPTION 'technical_posting_no_analytics'
        USING DETAIL = 'Технические проводки не несут аналитику';
    END IF;
    IF v_op.type = 'opening' AND NEW.direction = 'out'
       AND v_acc.kind = 'real' AND v_acc.reconciliation_mode = 'cash_count' THEN
      RAISE EXCEPTION 'negative_cash_opening_forbidden'
        USING DETAIL = 'Расходный opening запрещён для наличного реального счёта';
    END IF;
  ELSIF v_op.type = 'reversal' THEN
    NULL; -- полное зеркало: направление и аналитика наследуются без проверок
  ELSE
    IF NEW.category_id IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья обязательна для ' || v_op.type;
    END IF;
    SELECT direction INTO v_cat_direction FROM fin_categories WHERE id = NEW.category_id;
    IF v_op.type IN ('payment', 'income', 'donation') THEN
      IF NEW.direction <> 'in' THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = v_op.type || ' допускает только in-проводки';
      END IF;
      IF v_cat_direction <> 'in' THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья направления out недопустима для ' || v_op.type;
      END IF;
    ELSIF v_op.type IN ('expense', 'refund') THEN
      IF NEW.direction <> 'out' THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = v_op.type || ' допускает только out-проводки';
      END IF;
      IF v_cat_direction <> 'out' THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья направления in недопустима для ' || v_op.type;
      END IF;
    END IF;
    IF v_op.type IN ('expense', 'income', 'donation')
       AND NEW.participant_id IS NOT NULL AND NEW.participant_balance_kind <> 'none' THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'Для expense/income/donation с участником допустим только balance_kind = none';
    END IF;
    IF v_op.type = 'refund' AND NEW.refund_of_posting_id IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'refund требует refund_of_posting_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fin_postings_validate
  BEFORE INSERT ON fin_postings
  FOR EACH ROW EXECUTE FUNCTION fin_postings_validate();

-- -------------------------------------------------------------
-- Аудит и RLS deny-all на все новые таблицы
-- -------------------------------------------------------------
SELECT fin_private_attach_audit(t) FROM unnest(ARRAY[
  'fin_accounting_objects', 'fin_accounts', 'fin_operations', 'fin_postings',
  'fin_exchange_rates', 'fin_account_access', 'fin_charges',
  'fin_participant_opening_balances', 'fin_reconciliations',
  'fin_attachments', 'fin_object_closures'
]) AS t;

ALTER TABLE fin_accounting_objects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_accounts                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_operations                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_postings                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_exchange_rates               ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_account_access               ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_charges                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_participant_opening_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_reconciliations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_attachments                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_object_closures              ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON fin_accounting_objects, fin_accounts, fin_operations, fin_postings,
  fin_exchange_rates, fin_account_access, fin_charges,
  fin_participant_opening_balances, fin_reconciliations,
  fin_attachments, fin_object_closures
  FROM anon, authenticated;

REVOKE ALL ON SEQUENCE fin_ledger_seq FROM anon, authenticated;
REVOKE ALL ON FUNCTION fin_postings_guard()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_operations_guard()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_postings_validate() FROM PUBLIC, anon, authenticated;
