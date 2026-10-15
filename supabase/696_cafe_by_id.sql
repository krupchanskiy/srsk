-- 696: «Выдано на сдачу» — Кафе по постоянному id, а не по названию (ВГ, 15.10.2026).
-- В 693/694 Кафе искалось по name = 'Кафе': переименование департамента в справочнике
-- тихо ломало бы учёт сдачи. Постоянного code у fin_departments ещё нет (691 не выложена),
-- id же не меняется ни при переименовании, ни после 691 — хвост закрыт без ожидания.

CREATE OR REPLACE FUNCTION public.fin_private_cafe_department()
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT '4b2b3528-abd8-42de-ad35-935029c29340'::uuid $function$;
COMMENT ON FUNCTION public.fin_private_cafe_department() IS 'Департамент «Кафе» (постоянный id) — для учёта сдачи кассы 2 этажа (693, 694)';

CREATE OR REPLACE FUNCTION public.fin_private_cafe_float_account(p_currency text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id FROM fin_accounts a
   WHERE a.department_id = fin_private_cafe_department()
     AND a.kind = 'custodial' AND a.is_active AND a.currency_code = p_currency
   LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.fin_private_cafe_float_account(text) FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE def text; new text;
BEGIN
  def := pg_get_functiondef('public.tg_department_balance(bigint)'::regprocedure);
  new := replace(def, $$CASE WHEN d.name = 'Кафе' THEN$$,
                      $$CASE WHEN v_dept = fin_private_cafe_department() THEN$$);
  IF new = def THEN RAISE EXCEPTION 'tg_department_balance: замена не сработала'; END IF;
  EXECUTE new;
END
$do$;
