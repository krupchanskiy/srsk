-- =============================================================================
-- Миграция 164: Право confirm_prepayment + выдача Нитье-виласини
-- =============================================================================
-- Нитья-виласини (user_id ee76f10d-cff9-4efe-8a28-3cad716673e9) сейчас суперюзер
-- — право ей доступно автоматически. Выдаём явно через user_permissions на случай,
-- если позже её уберут из superusers. Менеджеры (Юля Б., Наталья Е.) — не суперюзеры
-- и без явной выдачи этого права иметь не будут.
-- =============================================================================

INSERT INTO permissions (code, name_ru, name_en, category, sort_order) VALUES
    ('confirm_prepayment', 'Подтверждение предоплаты', 'Confirm prepayment', 'crm', 100)
ON CONFLICT (code) DO NOTHING;

-- Выдача Нитье-виласини
INSERT INTO user_permissions (user_id, permission_id, is_granted, reason, granted_at)
SELECT 'ee76f10d-cff9-4efe-8a28-3cad716673e9',
       p.id,
       TRUE,
       'Первичная выдача по ТЗ «Предоплата»',
       NOW()
  FROM permissions p
 WHERE p.code = 'confirm_prepayment'
ON CONFLICT (user_id, permission_id) DO NOTHING;
