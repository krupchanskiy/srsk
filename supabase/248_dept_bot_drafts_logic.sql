-- День 2 бота-департаментов: слой БД.
-- Заявка живёт: proposed (карточка показана) → pending (человек нажал
-- «Записать», ждёт проведения) → posted (fin-админ провёл) | dismissed.

ALTER TABLE tg_drafts DROP CONSTRAINT IF EXISTS tg_drafts_status_check;
ALTER TABLE tg_drafts ADD CONSTRAINT tg_drafts_status_check
  CHECK (status IN ('proposed', 'pending', 'posted', 'dismissed'));

INSERT INTO fin_categories (code, name, direction, is_active)
SELECT 'dept_expense', 'Расход департамента', 'out', true
WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code='dept_expense');

CREATE OR REPLACE FUNCTION public.tg_bot_token() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token' $$;
REVOKE ALL ON FUNCTION public.tg_bot_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_bot_token() TO service_role;

CREATE OR REPLACE FUNCTION public.tg_set_reaction(p_chat bigint, p_message bigint, p_emoji text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_token text;
BEGIN
  IF p_chat IS NULL OR p_message IS NULL THEN RETURN; END IF;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='telegram_bot_token';
  PERFORM net.http_post(
    url := format('https://api.telegram.org/bot%s/setMessageReaction', v_token),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat, 'message_id', p_message,
            'reaction', jsonb_build_array(jsonb_build_object('type','emoji','emoji',p_emoji))));
EXCEPTION WHEN OTHERS THEN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_set_reaction(bigint, bigint, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_resolve_chat(p_chat bigint)
RETURNS TABLE (department_id uuid, department_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT l.department_id, d.name
  FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
  WHERE l.chat_id = p_chat AND l.is_active;
$$;
REVOKE ALL ON FUNCTION public.tg_resolve_chat(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_resolve_chat(bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_resolve_user(p_user bigint)
RETURNS TABLE (vaishnava_id uuid, person_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT u.vaishnava_id, COALESCE(NULLIF(v.spiritual_name,''), trim(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
  FROM tg_user_links u JOIN vaishnavas v ON v.id = u.vaishnava_id
  WHERE u.tg_user_id = p_user;
$$;
REVOKE ALL ON FUNCTION public.tg_resolve_user(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_resolve_user(bigint) TO service_role;

-- Найти департамент-получатель по тексту («выдать кухне» → Кухня)
CREATE OR REPLACE FUNCTION public.tg_match_department(p_text text, p_exclude uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM fin_departments
  WHERE id <> COALESCE(p_exclude, '00000000-0000-0000-0000-000000000000')
    AND lower(p_text) LIKE '%' || lower(left(name, 4)) || '%'
  ORDER BY length(name) DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.tg_match_department(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_match_department(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_create_draft(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_id uuid; v_author uuid; v_dept uuid;
BEGIN
  SELECT vaishnava_id INTO v_author FROM tg_user_links WHERE tg_user_id = (p->>'tg_user_id')::bigint;
  SELECT department_id INTO v_dept FROM tg_chat_links WHERE chat_id = (p->>'chat_id')::bigint AND is_active;
  IF v_dept IS NULL THEN RETURN NULL; END IF;
  INSERT INTO tg_drafts (chat_id, source_message_id, tg_user_id, author_vaishnava_id,
                         department_id, target_department_id, kind, amount, currency, raw_text, status)
  VALUES ((p->>'chat_id')::bigint, (p->>'source_message_id')::bigint, (p->>'tg_user_id')::bigint, v_author,
          v_dept, NULLIF(p->>'target_department_id','')::uuid, p->>'kind',
          (p->>'amount')::numeric, COALESCE(p->>'currency','INR'), p->>'raw_text', 'proposed')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_create_draft(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_create_draft(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_set_draft_status(p_id uuid, p_status text, p_card_message_id bigint DEFAULT NULL)
RETURNS TABLE (chat_id bigint, source_message_id bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE tg_drafts SET status = p_status,
    card_message_id = COALESCE(p_card_message_id, card_message_id)
  WHERE id = p_id AND status = 'proposed'
  RETURNING chat_id, source_message_id;
$$;
REVOKE ALL ON FUNCTION public.tg_set_draft_status(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_set_draft_status(uuid, text, bigint) TO service_role;

CREATE OR REPLACE VIEW public.fin_v_chat_drafts AS
SELECT t.id, t.chat_id, t.source_message_id, t.kind, t.amount, t.currency, t.raw_text, t.created_at,
       d.name AS department, td.name AS target_department,
       COALESCE(NULLIF(v.spiritual_name,''), trim(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,''))) AS author
FROM tg_drafts t
JOIN fin_departments d ON d.id = t.department_id
LEFT JOIN fin_departments td ON td.id = t.target_department_id
LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
WHERE t.status = 'pending' AND fin_can_read_all(auth.uid())
ORDER BY t.created_at;
REVOKE ALL ON public.fin_v_chat_drafts FROM anon;
GRANT SELECT ON public.fin_v_chat_drafts TO authenticated;

-- Провести заявку: fin-админ создаёт настоящую операцию, 👍 на сообщение
CREATE OR REPLACE FUNCTION public.tg_post_draft(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_acc uuid; v_tgt uuid; v_cat uuid; v_res jsonb; v_op uuid;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;

  v_acc := fin_dept_account(v_d.department_id, v_d.currency);

  IF v_d.kind = 'expense' THEN
    SELECT id INTO v_cat FROM fin_categories WHERE code='dept_expense';
    v_res := fin_create_expense(jsonb_build_object(
      'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
      'comment', format('Из чата: %s', v_d.raw_text),
      'rows', jsonb_build_array(jsonb_build_object(
        'id', fin_private_child_uuid(v_d.id, 'chat-expense-row'),
        'account_id', v_acc, 'amount', v_d.amount, 'category_id', v_cat))));
  ELSE
    IF v_d.target_department_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_target'); END IF;
    v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);
    v_res := fin_create_transfer(jsonb_build_object(
      'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
      'source_account_id', v_acc, 'target_account_id', v_tgt,
      'source_amount', v_d.amount, 'target_amount', v_d.amount,
      'comment', format('Из чата: %s', v_d.raw_text)));
  END IF;

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(v_res#>>'{error,message}', 'fail'));
  END IF;

  v_op := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
  UPDATE tg_drafts SET status='posted', operation_id=v_op, resolved_by=v_actor, resolved_at=now() WHERE id = v_d.id;
  PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👍');
  RETURN jsonb_build_object('ok', true, 'operation_id', v_op);
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_post_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_post_draft(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_send_chat(p_chat bigint, p_text text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='telegram_bot_token';
  PERFORM net.http_post(
    url := format('https://api.telegram.org/bot%s/sendMessage', v_token),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text, 'parse_mode','HTML','disable_web_page_preview',true));
EXCEPTION WHEN OTHERS THEN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_send_chat(bigint, text) FROM PUBLIC, anon, authenticated;

-- Перевод «пришёл» на подотчётный счёт департамента с привязанным чатом →
-- сообщение «Выдано под отчёт» в этот чат.
CREATE OR REPLACE FUNCTION public.tg_notify_dept_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_acc fin_accounts%ROWTYPE; v_optype text; v_chat bigint; v_bal numeric;
BEGIN
  IF NEW.direction <> 'in' THEN RETURN NEW; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;
  SELECT type INTO v_optype FROM fin_operations WHERE id = NEW.operation_id;
  IF v_optype <> 'transfer' THEN RETURN NEW; END IF;
  SELECT chat_id INTO v_chat FROM tg_chat_links WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;
  PERFORM tg_send_chat(v_chat, format(
    E'📥 <b>Выдано под отчёт: %s</b>\nНа руках у департамента: %s',
    fin_fmt_money(NEW.amount, v_acc.currency_code), fin_fmt_money(v_bal, v_acc.currency_code)));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tg_notify_dept_credit ON fin_postings;
CREATE TRIGGER trg_tg_notify_dept_credit
  AFTER INSERT ON fin_postings FOR EACH ROW
  EXECUTE FUNCTION tg_notify_dept_credit();
