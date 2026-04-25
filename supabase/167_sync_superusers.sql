-- =============================================================================
-- Миграция 167: Синхронизация superusers ↔ vaishnavas.is_superuser
-- =============================================================================
-- Контекст: в системе две таблицы суперюзеров.
--   • superusers — используется RLS-функциями (is_staff, политиками БД).
--   • vaishnavas.is_superuser — читается фронтом (auth-check.js → window.currentUser.is_superuser).
-- Они расходились: 13 пользователей в superusers, но НЕ в vaishnavas.is_superuser
-- (Нитья-виласини, Премамрита, Ранганатх и др.) — RLS их пускал, UI прятал кнопки/модули.
-- Плюс 1 наоборот (Нарада дас) — UI считал суперюзером, RLS — нет.
--
-- Решение по согласованию: привести vaishnavas.is_superuser в соответствие
-- с superusers (источник истины), и зеркально добавить всех vaishnavas.is_superuser=true
-- в superusers, чтобы две таблицы перестали расходиться.
-- =============================================================================

-- 1. Все из superusers → vaishnavas.is_superuser=TRUE
UPDATE vaishnavas v
   SET is_superuser = TRUE
 WHERE v.user_id IS NOT NULL
   AND v.is_superuser = FALSE
   AND EXISTS (SELECT 1 FROM superusers s WHERE s.user_id = v.user_id);

-- 2. Зеркально: все vaishnavas.is_superuser=TRUE без записи в superusers → добавить
INSERT INTO superusers (user_id)
SELECT v.user_id
  FROM vaishnavas v
 WHERE v.user_id IS NOT NULL
   AND v.is_superuser = TRUE
   AND NOT EXISTS (SELECT 1 FROM superusers s WHERE s.user_id = v.user_id)
ON CONFLICT DO NOTHING;
