-- Таблица для безопасной привязки Telegram-бота к пользователю через deep link
-- Одноразовые токены с TTL для защиты от подстановки чужого vaishnava_id

CREATE TABLE telegram_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  vaishnava_id UUID REFERENCES vaishnavas(id) ON DELETE CASCADE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Комментарии для документации
COMMENT ON TABLE telegram_link_tokens IS 'Одноразовые токены для привязки Telegram-бота к пользователю через deep link (t.me/bot?start=TOKEN)';
COMMENT ON COLUMN telegram_link_tokens.token IS 'Случайный UUID, передаётся в deep link';
COMMENT ON COLUMN telegram_link_tokens.expires_at IS 'Токен истекает через 15 минут после создания';
COMMENT ON COLUMN telegram_link_tokens.used IS 'true после успешной привязки, запрещает повторное использование';

-- RLS: пользователь может читать только свои токены
ALTER TABLE telegram_link_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telegram_link_tokens_select_own" ON telegram_link_tokens
FOR SELECT
USING (
  vaishnava_id IN (
    SELECT id FROM vaishnavas WHERE user_id = auth.uid()
  )
);

-- INSERT: любой аутентифицированный пользователь может создать токен для себя
CREATE POLICY "telegram_link_tokens_insert_own" ON telegram_link_tokens
FOR INSERT
WITH CHECK (
  vaishnava_id IN (
    SELECT id FROM vaishnavas WHERE user_id = auth.uid()
  )
);

-- UPDATE/DELETE: только Edge Functions (service_role_key)
-- RLS не применяется к service_role, поэтому отдельная политика не нужна

-- Индекс для быстрого поиска токенов (lookup по token)
CREATE INDEX idx_telegram_link_tokens_token ON telegram_link_tokens(token);

-- Индекс для очистки старых токенов (по expires_at)
CREATE INDEX idx_telegram_link_tokens_expires_at ON telegram_link_tokens(expires_at);

-- Индекс для фильтрации неиспользованных токенов
CREATE INDEX idx_telegram_link_tokens_used ON telegram_link_tokens(used) WHERE NOT used;
