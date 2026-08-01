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
--   fin_crm_channel_map — подсказки счёта по валюте;
--   tg_chat_links, tg_user_links — привязки чатов и людей бота-департаментов.
-- СОХРАНЯЮТСЯ ТАКЖЕ (появились 26–29.07.2026, сверено со схемой 29.07):
--   fin_departments            — сами департаменты и их ответственные;
--   fin_department_categories  — свой набор статей у департамента (просьба ВГ);
--   tg_known_chats             — чаты, куда бота уже добавили;
--   tg_link_tokens             — одноразовые токены привязки: не мешают, сгорают сами.
-- Скрипт их не трогает, то есть настройки департаментов переживут переход.
-- ОЧИЩАЮТСЯ ДОПОЛНИТЕЛЬНО (тестовые логи и заявки интеграции — иначе в
-- первое утро запуска витрина неразнесённых и сторож дадут ложные сигналы,
-- а во «Входящих» повиснут тестовые заявки из чатов):
--   fin_crm_autopost_log, fin_integrity_alerts, tg_log, tg_drafts, tg_incoming,
--   tg_draft_operations (связь заявки с её операциями, добавлена 01.08.2026).
--
-- Это единственное официально допустимое нарушение append-only
-- (ТЗ раздел 5, инвариант 7) — одноразовое, только для окна cutover.
-- =============================================================

-- =============================================================
-- ШАГ 0 (ОБЯЗАТЕЛЬНО, ДО reset) — снимок внутри базы.
--
-- PITR у проекта не включён, ежедневный бэкап снимается около 05:05 по
-- Мумбаи. Снимок точнее: ровно те таблицы, что стирает этот скрипт.
--
--   SELECT fin_cutover_snapshot();        -- вернёт число скопированных строк
--   SELECT fin_cutover_snapshot_info();   -- убедиться, что снимок на месте
--
-- Если после reset выяснится, что данные были нужны:
--   SELECT fin_cutover_restore('ВОССТАНОВИТЬ ИЗ СНИМКА');
--
-- Полная репетиция (снимок → reset → возврат) прогнана 01.08.2026 в откате на
-- актуальной схеме: снимок 1409 строк, после сброса всё пусто и последовательность
-- сброшена в 1, восстановление вернуло 1409 строк и ledger_seq 666. Сверка по
-- контрольным суммам всех 14 стираемых таблиц — ноль расхождений: совпали и
-- количество строк, и содержимое. Справочники целы: 35 счетов, 11 департаментов,
-- 7 привязок чатов.
-- =============================================================

BEGIN;

-- 0) не даём запустить reset без снимка — иначе откатываться будет некуда
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cutover_snapshot') THEN
    RAISE EXCEPTION 'Сначала снимок: SELECT fin_cutover_snapshot();'
      USING DETAIL = 'reset необратим, без снимка откатываться будет некуда.';
  END IF;
END $$;

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
--    postings/reconciliations и связи заявок — на operations)
DELETE FROM tg_draft_operations;
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
DELETE FROM tg_drafts;
DELETE FROM tg_incoming;

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
       + (SELECT count(*) FROM tg_drafts)
       + (SELECT count(*) FROM tg_incoming)
       + (SELECT count(*) FROM tg_draft_operations)
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
