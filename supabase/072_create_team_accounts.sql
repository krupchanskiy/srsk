-- Создание аккаунтов для всех членов команды
-- Пароль для всех: rupaseva
--
-- ВАЖНО: Этот скрипт создает пользователей через Supabase Auth
-- Выполнять через Supabase Dashboard SQL Editor

-- Функция для создания пользователя (требует права администратора)
-- Примечание: В Supabase нет прямого способа создать пользователей через SQL
-- Нужно использовать либо Supabase Dashboard → Authentication → Users → Invite user
-- Либо API с Service Role Key

-- Альтернативный подход: Создаем временную таблицу с данными для импорта
CREATE TEMP TABLE IF NOT EXISTS team_accounts_to_create AS
SELECT
    id as vaishnava_id,
    COALESCE(
        email,
        LOWER(REGEXP_REPLACE(
            COALESCE(spiritual_name, first_name, 'user'),
            '[^a-z0-9]',
            '',
            'g'
        )) || '@rupaseva.com'
    ) as email,
    COALESCE(spiritual_name, first_name || ' ' || last_name) as name
FROM vaishnavas
WHERE is_deleted = false
  AND is_team_member = true
ORDER BY spiritual_name, first_name;

-- Показать список аккаунтов для создания
SELECT * FROM team_accounts_to_create;

-- ИНСТРУКЦИЯ:
-- 1. Выполните этот скрипт, чтобы увидеть список email'ов
-- 2. Скопируйте список
-- 3. Откройте Supabase Dashboard → Authentication → Users
-- 4. Для каждого пользователя кликните "Invite user"
-- 5. Введите email и установите пароль: rupaseva
-- 6. Отключите "Send email confirmation" если не хотите отправлять письма

-- Альтернатива: экспорт в CSV для массового импорта
-- COPY team_accounts_to_create TO '/tmp/team_accounts.csv' WITH CSV HEADER;

DROP TABLE IF EXISTS team_accounts_to_create;
