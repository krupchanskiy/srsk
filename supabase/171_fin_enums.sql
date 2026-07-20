-- =============================================================
-- Финансовый модуль, Этап 0: enum-типы
-- ТЗ v4.2.10 + Implementation Guide v1.0, раздел 4
-- Enum-значения — API-контракт: UI переводит их через словарь,
-- расширение — только отдельной миграцией (ALTER TYPE ... ADD VALUE),
-- никогда не пересозданием типа.
-- =============================================================

CREATE TYPE fin_account_kind AS ENUM ('real', 'custodial');

CREATE TYPE fin_reconciliation_mode AS ENUM ('cash_count', 'statement');

CREATE TYPE fin_operation_type AS ENUM (
  'payment', 'refund', 'transfer', 'expense', 'income',
  'donation', 'opening', 'reversal', 'reconciliation_adjustment'
);

CREATE TYPE fin_direction AS ENUM ('in', 'out');

CREATE TYPE fin_approval AS ENUM ('pending', 'approved', 'disputed', 'not_required');

CREATE TYPE fin_payment_channel AS ENUM ('cash', 'bank_transfer', 'card', 'paypal');

CREATE TYPE fin_participant_balance_kind AS ENUM (
  'none', 'org_fee', 'accommodation', 'meals', 'extra', 'general'
);

CREATE TYPE fin_charge_kind AS ENUM ('org_fee', 'accommodation', 'meals', 'extra');

CREATE TYPE fin_attachment_parent_type AS ENUM ('operation', 'accounting_object');

CREATE TYPE fin_closure_status AS ENUM ('report_pending', 'finalized', 'generation_error');

-- В MVP только retreat; фаза 2 добавит guesthouse_period, external_event
-- отдельной миграцией без изменения существующих строк
CREATE TYPE fin_object_type AS ENUM ('retreat');

CREATE TYPE fin_contractor_type AS ENUM ('person', 'organization');

CREATE TYPE fin_opening_position_kind AS ENUM ('debt', 'credit');
