-- Отказ по заявке: сумма в том же формате, что и во всех сообщениях бота («55 ₹», а не «55 INR»)

CREATE OR REPLACE FUNCTION public.tg_dismiss_draft(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d       tg_drafts%ROWTYPE;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_who     text;
  v_text    text;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  UPDATE tg_drafts SET status = 'dismissed', resolved_by = auth.uid(), resolved_at = now()
  WHERE id = p_id AND status = 'pending'
  RETURNING * INTO v_d;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  SELECT coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''))
    INTO v_who
  FROM vaishnavas v WHERE v.user_id = auth.uid();

  IF v_d.chat_id IS NOT NULL THEN
    v_text := '✖️ <b>Заявка не проведена</b>'
           || CASE WHEN v_d.amount IS NOT NULL AND v_d.currency IS NOT NULL
                   THEN ' · ' || fin_fmt_money(v_d.amount, v_d.currency) ELSE '' END
           || coalesce(E'\nПричина: ' || tg_escape(v_reason), '')
           || coalesce(E'\nОтклонил: ' || tg_escape(v_who), '');
    PERFORM tg_send_chat(v_d.chat_id, v_text, v_d.source_message_id);
    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
