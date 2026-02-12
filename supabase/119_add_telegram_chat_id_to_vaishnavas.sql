-- Добавляем поле telegram_chat_id в таблицу vaishnavas
-- Используется для хранения Telegram chat_id гостя для отправки уведомлений

ALTER TABLE vaishnavas
ADD COLUMN telegram_chat_id BIGINT;

-- Комментарий для документации
COMMENT ON COLUMN vaishnavas.telegram_chat_id IS 'Telegram chat ID для отправки push-уведомлений через бота. NULL = не подключено';

-- Индекс для быстрого поиска пользователей с подключенным ботом
CREATE INDEX idx_vaishnavas_telegram_chat_id ON vaishnavas(telegram_chat_id)
WHERE telegram_chat_id IS NOT NULL;
