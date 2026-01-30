-- 073_update_vaishnavas.sql
-- Обновление таблицы vaishnavas для интеграции с auth.users
-- Добавление полей для управления доступом и типами пользователей

-- Добавляем поля для связи с auth.users и управления доступом
ALTER TABLE vaishnavas
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS user_type TEXT CHECK (user_type IN ('staff', 'guest')) DEFAULT 'staff',
ADD COLUMN IF NOT EXISTS approval_status TEXT CHECK (approval_status IN ('pending', 'approved', 'rejected', 'blocked')) DEFAULT 'approved',
ADD COLUMN IF NOT EXISTS is_superuser BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS telegram_username TEXT;

-- Индексы для улучшения производительности
CREATE INDEX IF NOT EXISTS idx_vaishnavas_user_id ON vaishnavas(user_id);
CREATE INDEX IF NOT EXISTS idx_vaishnavas_user_type ON vaishnavas(user_type);
CREATE INDEX IF NOT EXISTS idx_vaishnavas_approval_status ON vaishnavas(approval_status);
CREATE INDEX IF NOT EXISTS idx_vaishnavas_is_superuser ON vaishnavas(is_superuser) WHERE is_superuser = true;

-- Миграция существующих пользователей
-- Все текущие пользователи из команды становятся суперадминами
UPDATE vaishnavas v
SET
    user_id = (SELECT id FROM auth.users WHERE email = v.email LIMIT 1),
    user_type = 'staff',
    approval_status = 'approved',
    is_superuser = true,
    is_active = true,
    approved_at = NOW()
WHERE v.is_team_member = true
  AND v.is_deleted = false
  AND v.email IS NOT NULL
  AND v.user_id IS NULL; -- Только если ещё не связан

-- Комментарии к новым полям
COMMENT ON COLUMN vaishnavas.user_id IS 'Связь с аккаунтом в auth.users';
COMMENT ON COLUMN vaishnavas.user_type IS 'Тип пользователя: staff (команда) или guest (гость)';
COMMENT ON COLUMN vaishnavas.approval_status IS 'Статус одобрения: pending, approved, rejected, blocked';
COMMENT ON COLUMN vaishnavas.is_superuser IS 'Суперпользователь с полным доступом ко всем функциям';
COMMENT ON COLUMN vaishnavas.is_active IS 'Активен ли пользователь в системе';
COMMENT ON COLUMN vaishnavas.approved_by IS 'Кто одобрил заявку';
COMMENT ON COLUMN vaishnavas.approved_at IS 'Когда одобрена заявка';
COMMENT ON COLUMN vaishnavas.last_login_at IS 'Время последнего входа';
COMMENT ON COLUMN vaishnavas.telegram_username IS 'Никнейм в Telegram (без @)';
