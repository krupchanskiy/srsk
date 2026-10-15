-- 693: Размен кассы кафе (2 этаж) — «по кругу» (ВГ, 14.10.2026).
-- Нитья снимает кассу целиком (вместе со вчерашним разменом) и из собранного выдаёт
-- новый размен. Раньше вся снятая сумма шла доходом, а выданный размен висел на Кафе
-- «не привязано» — выручка считалась дважды (исправлено вручную 14.10, −21 538 ₹).
--
-- Размен = остаток счёта Кафе без держателя (holder_person_id IS NULL):
--  • tg_post_draft(p_no_holder) — выдача на размен ложится на Кафе ни на кого,
--    хотя у Кафе несколько держателей (689 иначе требует выбрать человека);
--  • fin_cafe_float() — сколько размена сейчас в кассе, подсказка в форме прихода;
--  • fin_create_cafe_collection — приход «Касса кафе» + возврат размена с Кафе
--    на счёт прихода одной транзакцией: доходом идёт только «снято минус размен».
-- Кафе ищем по названию, как и везде сейчас; когда появится fin_departments.code
-- (691) — перевести на code = 'cafe'.

-- ==================== tg_post_draft: + p_no_holder ====================
DO $do$
DECLARE
  def text; new text; procedure_step text;
BEGIN
  def := pg_get_functiondef('public.tg_post_draft(uuid, jsonb, uuid, text, uuid)'::regprocedure);
  new := def;

  procedure_step := 'заголовок';
  new := replace(new, 'p_target_holder uuid DEFAULT NULL::uuid)',
                      'p_target_holder uuid DEFAULT NULL::uuid, p_no_holder boolean DEFAULT false)');
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'без держателя';
  new := replace(new, E'        ELSIF v_tgt_holders = 1 THEN',
                      E'        ELSIF COALESCE(p_no_holder, false) THEN\n'
                   || E'          NULL;  -- размен в кассу: ни на кого (693)\n'
                   || E'        ELSIF v_tgt_holders = 1 THEN');
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;

  DROP FUNCTION public.tg_post_draft(uuid, jsonb, uuid, text, uuid);
  EXECUTE new;
END
$do$;

REVOKE ALL ON FUNCTION public.tg_post_draft(uuid, jsonb, uuid, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_post_draft(uuid, jsonb, uuid, text, uuid, boolean) TO authenticated, service_role;

-- ==================== счёт и остаток размена ====================
CREATE OR REPLACE FUNCTION public.fin_private_cafe_float_account(p_currency text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id FROM fin_accounts a
    JOIN fin_departments d ON d.id = a.department_id
   WHERE d.name = 'Кафе' AND a.kind = 'custodial' AND a.is_active AND a.currency_code = p_currency
   LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.fin_private_cafe_float_account(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_cafe_float(p_currency text DEFAULT 'INR')
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT fin_can_read_all(auth.uid()) THEN RETURN NULL; END IF;
  RETURN (SELECT COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)
            FROM fin_postings p
           WHERE p.account_id = fin_private_cafe_float_account(p_currency)
             AND p.holder_person_id IS NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_cafe_float(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_cafe_float(text) TO authenticated;

-- ==================== приход кассы кафе с возвратом размена ====================
-- payload = обычный payload fin_create_income + cafe_float (сумма размена в снятой кассе)
-- + float_account_id (куда вернуть размен — счёт, на который сдана касса 2 этажа).
-- Строки прихода клиент присылает уже за вычетом размена; если всё снятое — размен,
-- строк может не быть вовсе, тогда проводится только возврат.
CREATE OR REPLACE FUNCTION public.fin_create_cafe_collection(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_float numeric := COALESCE(NULLIF(payload->>'cafe_float', '')::numeric, 0);
  v_target uuid := NULLIF(payload->>'float_account_id', '')::uuid;
  v_income jsonb := payload - 'cafe_float' - 'float_account_id';
  v_cur text; v_src uuid; v_have numeric;
  v_res jsonb; v_tr jsonb; v_msg text;
BEGIN
  IF v_float < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload',
      'message', 'Размен не может быть отрицательным'));
  END IF;

  BEGIN
    IF jsonb_array_length(COALESCE(v_income->'rows', '[]'::jsonb)) > 0 THEN
      v_res := fin_create_income(v_income);
      IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN RETURN v_res; END IF;
    END IF;

    IF v_float > 0 THEN
      SELECT currency_code INTO v_cur FROM fin_accounts WHERE id = v_target AND is_active;
      IF v_cur IS NULL THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = 'Не указан счёт, куда сдан размен';
      END IF;
      v_src := fin_private_cafe_float_account(v_cur);
      IF v_src IS NULL THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = format('У Кафе нет подотчётного счёта в %s', v_cur);
      END IF;
      SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) INTO v_have
        FROM fin_postings WHERE account_id = v_src AND holder_person_id IS NULL;
      IF round(v_float, 2) > round(v_have, 2) THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL =
          format('В кассе кафе числится размен %s, а указано %s', fin_fmt_money(v_have, v_cur), fin_fmt_money(v_float, v_cur));
      END IF;

      -- ежедневный возврат размена — не новость для чатов
      PERFORM set_config('tg.suppress_chat_notify', '1', true);
      v_tr := fin_create_transfer(jsonb_build_object(
        'request_id', fin_private_child_uuid((payload->>'request_id')::uuid, 'cafe-float-return'),
        'occurred_on', payload->>'occurred_on',
        'source_account_id', v_src, 'target_account_id', v_target,
        'source_amount', v_float, 'target_amount', v_float,
        'comment', 'Возврат размена — сдан вместе с кассой кафе'
                   || COALESCE(' · ' || NULLIF(btrim(payload->>'comment'), ''), '')));
      PERFORM set_config('tg.suppress_chat_notify', '', true);
      IF NOT COALESCE((v_tr->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = COALESCE(v_tr#>>'{error,message}', 'не удалось вернуть размен');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'cafe_float',
      'message', COALESCE(NULLIF(v_msg, ''), SQLERRM)));
  END;

  RETURN COALESCE(v_res, v_tr);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_create_cafe_collection(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_create_cafe_collection(jsonb) TO authenticated;
