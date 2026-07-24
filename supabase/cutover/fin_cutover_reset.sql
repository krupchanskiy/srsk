-- =============================================================
-- CUTOVER RESET — выполняется ОДИН РАЗ перед датой X (ТЗ раздел 11).
-- НЕ МИГРАЦИЯ. Запускать вручную: maintenance mode (нет активных
-- сессий записи), ПОСЛЕ резервной копии, одной транзакцией.
--
-- Очищает данные shadow/тест-периода, СОХРАНЯЯ справочники и
-- объекты подготовки: fin_accounts, fin_categories, fin_currencies,
-- fin_exchange_rates, fin_contractors, fin_account_access,
-- fin_accounting_objects, fin_cost_centers, fin_denominations.
--
-- СОХРАНЯЮТСЯ ТАКЖЕ (появились после первой версии, 23.07.2026):
--   fin_settings      — дата запуска (cutover_date);
--   tg_channels       — chat_id Telegram-каналов;
--   fin_crm_channel_map — подсказки счёта по валюте.
-- ОЧИЩАЮТСЯ ДОПОЛНИТЕЛЬНО (тестовые логи интеграции — иначе в первое
-- утро запуска витрина неразнесённых и сторож дадут ложные сигналы):
--   fin_crm_autopost_log, fin_integrity_alerts, tg_log.
--
-- Это единственное официально допустимое нарушение append-only
-- (ТЗ раздел 5, инвариант 7) — одноразовое, только для окна cutover.
-- =============================================================

BEGIN;

-- 1) временно отключаем защитные и аудит-триггеры (только на время reset)
ALTER TABLE fin_postings   DISABLE TRIGGER trg_fin_postings_guard;
ALTER TABLE fin_operations DISABLE TRIGGER trg_fin_operations_guard;
ALTER TABLE fin_audit_log  DISABLE TRIGGER trg_fin_audit_immutable;
ALTER TABLE fin_operations                   DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_postings                     DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_reconciliations              DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_charges                      DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_participant_opening_balances DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_attachments                  DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_object_closures              DISABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_accounting_objects           DISABLE TRIGGER trg_fin_audit;

-- 2) очистка в порядке FK (closures ссылаются на attachments;
--    postings/reconciliations — на operations)
DELETE FROM fin_object_closures;
DELETE FROM fin_attachments;
DELETE FROM fin_reconciliations;
DELETE FROM fin_postings;
DELETE FROM fin_operations;
DELETE FROM fin_charges;
DELETE FROM fin_participant_opening_balances;
-- аудит shadow-периода (весь лог: до даты X других записей нет)
DELETE FROM fin_audit_log;
-- тестовые логи интеграции (справочники fin_settings/tg_channels/
-- fin_crm_channel_map НЕ трогаем — они настроены к запуску)
DELETE FROM fin_crm_autopost_log;
DELETE FROM fin_integrity_alerts;
DELETE FROM tg_log;

-- 3) боевая последовательность начинается с 1 (ТЗ раздел 11)
ALTER SEQUENCE fin_ledger_seq RESTART WITH 1;

-- 4) сброс «грязных» отчётов, оставшихся от shadow-закрытий
UPDATE fin_accounting_objects SET report_dirty_at = NULL;

-- 5) включаем триггеры обратно
ALTER TABLE fin_postings   ENABLE TRIGGER trg_fin_postings_guard;
ALTER TABLE fin_operations ENABLE TRIGGER trg_fin_operations_guard;
ALTER TABLE fin_audit_log  ENABLE TRIGGER trg_fin_audit_immutable;
ALTER TABLE fin_operations                   ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_postings                     ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_reconciliations              ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_charges                      ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_participant_opening_balances ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_attachments                  ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_object_closures              ENABLE TRIGGER trg_fin_audit;
ALTER TABLE fin_accounting_objects           ENABLE TRIGGER trg_fin_audit;

-- 6) контроль: очищаемые пусты, сохраняемые на месте, триггеры включены
DO $$
DECLARE
  v_cleared int;
  v_kept int;
  v_disabled int;
BEGIN
  SELECT (SELECT count(*) FROM fin_operations)
       + (SELECT count(*) FROM fin_postings)
       + (SELECT count(*) FROM fin_reconciliations)
       + (SELECT count(*) FROM fin_charges)
       + (SELECT count(*) FROM fin_participant_opening_balances)
       + (SELECT count(*) FROM fin_object_closures)
       + (SELECT count(*) FROM fin_attachments)
       + (SELECT count(*) FROM fin_audit_log)
       + (SELECT count(*) FROM fin_crm_autopost_log)
       + (SELECT count(*) FROM fin_integrity_alerts)
    INTO v_cleared;
  IF v_cleared <> 0 THEN
    RAISE EXCEPTION 'RESET FAILED: очищаемые таблицы не пусты (%)', v_cleared;
  END IF;

  SELECT (SELECT count(*) FROM fin_accounts)
       + (SELECT count(*) FROM fin_categories)
       + (SELECT count(*) FROM fin_currencies)
    INTO v_kept;
  IF v_kept = 0 THEN
    RAISE EXCEPTION 'RESET FAILED: справочники пусты — восстановите из бэкапа';
  END IF;

  SELECT count(*) INTO v_disabled
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname LIKE 'fin_%' AND t.tgname LIKE 'trg_fin_%' AND t.tgenabled = 'D';
  IF v_disabled <> 0 THEN
    RAISE EXCEPTION 'RESET FAILED: % триггеров остались выключенными', v_disabled;
  END IF;

  RAISE NOTICE 'RESET OK: данные очищены, справочники целы, триггеры включены';
END $$;

COMMIT;

-- 7) ПОСЛЕ коммита (вне SQL):
--    - Dashboard → Storage → finance-files → удалить все файлы
--      (метаданные вложений уже очищены; физические файлы — через UI
--      или вызов fin-cleanup, который снимет всё старше 24 часов)
--    - убедиться, что бакет пуст: SELECT count(*) FROM storage.objects
--      WHERE bucket_id = 'finance-files';
