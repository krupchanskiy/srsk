-- «Уточнить выдачу»: казначей может выдавать департаменту чата (ВГ, 21.09.2026).
-- Когда казначей пишет «выдал …» в чате департамента, бот ставит получателем сам
-- этот департамент (приход с реального счёта). Но tg_refine_draft отказывал:
-- «Получатель совпадает с автором заявки» — правило верно для департаментов
-- (себе не передают), но не для казначея. Теперь отказ только если автор — не казначей.
CREATE OR REPLACE FUNCTION public.tg_refine_draft(p_id uuid, p_target_department uuid, p_source_account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_cur text;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;

  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  IF v_d.kind <> 'transfer' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Уточнять получателя можно только у выдачи');
  END IF;

  IF p_target_department IS NULL
     OR NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = p_target_department) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Не выбран департамент-получатель');
  END IF;
  IF p_target_department = v_d.department_id
     AND NOT EXISTS (SELECT 1 FROM tg_treasurer() t WHERE t.vaishnava_id = v_d.author_vaishnava_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Получатель совпадает с автором заявки');
  END IF;

  IF p_source_account IS NOT NULL THEN
    SELECT currency_code INTO v_cur FROM fin_accounts
     WHERE id = p_source_account AND is_active;
    IF v_cur IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Счёт-источник не найден или деактивирован');
    END IF;
    IF v_cur IS DISTINCT FROM v_d.currency THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Валюта счёта не совпадает с валютой заявки');
    END IF;
  END IF;

  UPDATE tg_drafts
     SET target_department_id = p_target_department,
         source_account_id    = p_source_account
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
