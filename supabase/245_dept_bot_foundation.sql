-- =============================================================
-- Бот-департаменты, день 1: фундамент (план от 23.07.2026).
--
-- Принцип безопасности: бот НЕ пишет в ядро финмодуля. Он лишь
-- складывает ЗАЯВКИ (tg_drafts) из чатов; настоящий расход/перевод
-- создаёт только fin-админ кнопкой «Провести» во «Входящих». Периметр
-- финмодуля не меняется.
--
-- Три таблицы:
--   tg_chat_links — чат департамента ↔ подотчётный счёт (+ темы);
--   tg_user_links — Telegram-пользователь ↔ вайшнав (кто пишет);
--   tg_drafts     — заявки из чатов, ждущие проведения.
-- =============================================================

-- Чат ↔ департамент. topic_* — id тем Telegram (форумные чаты): в какую
-- тему слать финансы, в какую — прочие уведомления. NULL = обычный чат
-- без тем, всё одним потоком.
CREATE TABLE IF NOT EXISTS tg_chat_links (
  chat_id bigint PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES fin_accounts(id),
  department_name text NOT NULL,
  topic_finance int,
  topic_notify int,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tg_chat_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_chat_links FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE tg_chat_links IS
'Чат Telegram департамента ↔ его подотчётный счёт. Расход из чата ложится на этот счёт; в чат приходят уведомления о выдачах.';

-- Telegram-пользователь ↔ вайшнав. Привязка одноразовая (кнопка в
-- профиле или /start боту). Без неё расход из чата будет безымянным —
-- бот попросит привязаться.
CREATE TABLE IF NOT EXISTS tg_user_links (
  tg_user_id bigint PRIMARY KEY,
  vaishnava_id uuid NOT NULL REFERENCES vaishnavas(id),
  tg_username text,
  linked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tg_user_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_user_links FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE tg_user_links IS
'Telegram-пользователь ↔ вайшнав. Кто написал расход в чат департамента.';

-- Заявки из чатов. kind: expense (расход департамента) |
-- transfer (передача другому департаменту, «выдать кухне …»).
-- Для transfer target_account_id — счёт получателя.
CREATE TABLE IF NOT EXISTS tg_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  source_message_id bigint NOT NULL,
  card_message_id bigint,
  tg_user_id bigint,
  author_vaishnava_id uuid REFERENCES vaishnavas(id),
  account_id uuid NOT NULL REFERENCES fin_accounts(id),
  target_account_id uuid REFERENCES fin_accounts(id),
  kind text NOT NULL CHECK (kind IN ('expense', 'transfer')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'INR' REFERENCES fin_currencies(code),
  raw_text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'dismissed')),
  operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);
CREATE INDEX IF NOT EXISTS idx_tg_drafts_pending ON tg_drafts (created_at DESC) WHERE status = 'pending';
ALTER TABLE tg_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_drafts FROM PUBLIC, anon;
-- fin-админ видит заявки во «Входящих»
DROP POLICY IF EXISTS "Drafts read fin admin" ON tg_drafts;
CREATE POLICY "Drafts read fin admin" ON tg_drafts
  FOR SELECT TO authenticated USING (fin_can_read_all((SELECT auth.uid())));
COMMENT ON TABLE tg_drafts IS
'Заявки из чатов департаментов, ждущие проведения fin-админом. Бот их создаёт, но в учёт не проводит — это делает человек кнопкой «Провести».';

-- Секрет вебхука (сверка входящих вызовов от Telegram), в vault
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'tg_webhook_secret') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(24), 'hex'), 'tg_webhook_secret');
  END IF;
END $$;
