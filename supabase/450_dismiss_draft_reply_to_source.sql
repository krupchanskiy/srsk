-- Отклонение заявки в чате депаратамента визуально «отвечало» не на саму
-- заявку, а на служебное сообщение-корень темы форума (Telegram подписывает
-- так первое сообщение в ленте темы, если у него нет явного reply_to).
-- Путаница ВГ 16.09.2026: «бот пишет ответ не на то сообщение, которое я
-- отклонил, а на самое первое, что счёт создан».
--
-- Правка: явно отвечаем на исходное сообщение с заявкой (source_message_id) —
-- то же самое, на которое уже ставится реакция 👎 чуть ниже.

create or replace function tg_dismiss_draft(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Имя того, кто отклонил: человеку в чате важно знать, к кому идти с вопросом
  SELECT coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''))
    INTO v_who
  FROM vaishnavas v WHERE v.user_id = auth.uid();

  IF v_d.chat_id IS NOT NULL THEN
    v_text := '✖️ <b>Заявка не проведена</b>'
           || coalesce(' — ' || tg_escape(v_d.purpose), '')
           || coalesce(' · ' || v_d.amount::text || ' ' || tg_escape(v_d.currency), '')
           || coalesce(E'\nПричина: ' || tg_escape(v_reason), '')
           || coalesce(E'\nОтклонил: ' || tg_escape(v_who), '');
    PERFORM tg_send_chat(v_d.chat_id, v_text, v_d.source_message_id);
    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
