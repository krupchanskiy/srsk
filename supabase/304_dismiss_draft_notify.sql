-- Отклонение заявки: сказать об этом в чат.
--
-- Было несимметрично: при проведении бот ставил 👍 на исходное сообщение, а при
-- отклонении не делал ничего. Человек написал «выдал кухне 1000», увидел
-- «Записано, ждёт проведения» — и дальше тишина навсегда. Замечание ВГ с боевого
-- теста 29.07.2026: «только что отменил (не подтвердил) и тут ничего не отобразилось».
--
-- Теперь отклонение отвечает в тот же чат ответом на исходное сообщение и
-- помечает его 👎 (❌ Telegram в реакциях не принимает). Причина необязательна,
-- но если её указали — попадёт в сообщение: чаще всего человеку важно понять,
-- переписать заявку или деньги учли иначе.

-- Причина без DEFAULT: со старой одноаргументной версией default сделал бы вызов
-- tg_dismiss_draft(p_id) неоднозначным. Старая версия ниже превращена в обёртку,
-- поэтому уведомление придёт даже из ещё не обновившегося у пользователя интерфейса.
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
    PERFORM tg_send_chat(v_d.chat_id, v_text);
    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

grant execute on function tg_dismiss_draft(uuid, text) to authenticated;

-- Старый вызов без причины — теперь обёртка, чтобы поведение было одинаковым
create or replace function tg_dismiss_draft(p_id uuid)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select tg_dismiss_draft(p_id, null::text);
$$;

grant execute on function tg_dismiss_draft(uuid) to authenticated;
