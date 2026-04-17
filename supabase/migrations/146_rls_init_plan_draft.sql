-- PR 9 (часть 3) — DRAFT миграция для RLS initPlan оптимизации.
--
-- Статус: НЕ ПРИМЕНЕНО. Сначала протестировать на dev-проекте
--         (vzuiwpeovnzfokekdetq), затем prod.
--
-- Проблема: 94 RLS-политики содержат голый `auth.uid()` / `auth.jwt()` / `auth.role()`,
-- которые Postgres пересчитывает per-row. Обёрнутый `(SELECT auth.uid())`
-- исполняется один раз через initPlan и кешируется на весь запрос.
-- Прирост перфоманса на таблицах >1000 записей — значительный.
--
-- Источник: Supabase performance advisors → auth_rls_initplan (94 WARN).
--
-- Семантика не меняется (SELECT того же значения).
--
-- Как применить:
--   1. Получить список всех текущих политик с auth.uid() для двойной проверки:
--      SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
--      WHERE schemaname = 'public' AND (qual LIKE '%auth.uid()%' OR with_check LIKE '%auth.uid()%');
--   2. Прогнать на dev-проекте.
--   3. Прогнать Playwright-тесты + smoke (guest portal login, кухня, CRM).
--   4. Применить на prod через MCP apply_migration.
--
-- Альтернатива: вручную переписать 94 политики через CREATE OR REPLACE POLICY.
--
-- Подход: DO-блок с динамическим DROP + CREATE для каждой политики.
-- Postgres не поддерживает ALTER POLICY ... USING (...), поэтому нужен DROP + CREATE.

DO $$
DECLARE
  r record;
  new_qual text;
  new_check text;
  sql text;
BEGIN
  FOR r IN
    SELECT
      schemaname, tablename, policyname, cmd, permissive, roles,
      qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        qual ~ '(?<!select )auth\.(uid|jwt|role)\(\)'
        OR with_check ~ '(?<!select )auth\.(uid|jwt|role)\(\)'
      )
  LOOP
    -- Оборачиваем голые auth.*() в (SELECT auth.*())
    -- (?<!...) negative lookbehind чтобы не тронуть уже обёрнутые.
    new_qual := regexp_replace(
      COALESCE(r.qual, ''),
      '(?<!select )(auth\.(?:uid|jwt|role)\(\))',
      '(SELECT \1)',
      'gi'
    );
    new_check := regexp_replace(
      COALESCE(r.with_check, ''),
      '(?<!select )(auth\.(?:uid|jwt|role)\(\))',
      '(SELECT \1)',
      'gi'
    );

    -- DROP + CREATE (ALTER POLICY не умеет менять USING/WITH CHECK)
    sql := format('DROP POLICY %I ON %I.%I;',
                  r.policyname, r.schemaname, r.tablename);
    EXECUTE sql;

    sql := format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',
      r.policyname,
      r.schemaname,
      r.tablename,
      CASE WHEN r.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      r.cmd,
      array_to_string(r.roles, ', '),
      CASE WHEN NULLIF(new_qual, '') IS NOT NULL THEN ' USING (' || new_qual || ')' ELSE '' END,
      CASE WHEN NULLIF(new_check, '') IS NOT NULL THEN ' WITH CHECK (' || new_check || ')' ELSE '' END
    );
    EXECUTE sql;

    RAISE NOTICE 'Updated policy %.% "%"', r.schemaname, r.tablename, r.policyname;
  END LOOP;
END;
$$;
