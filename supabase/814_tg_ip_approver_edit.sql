-- 814: в чате счетов ИП кнопки «Изменить / Удалить» под расходом во «Входящих» — и у ВГ
-- (одобряющий чата), не только у автора (решение ВГ 20.11.2026).
--   • ВГ меняет счёт, департамент, статью и может удалить; «Вид операции» — только автор:
--     приход и перевод проводятся сразу от имени автора.
--   • ВГ может нажать «Отправить» у расхода, который вернули на исправление.
--   • Правка текста сообщения — по-прежнему только автор (чужое сообщение не изменить).

CREATE OR REPLACE FUNCTION tg_ip_is_approver(p_chat bigint, p_tg_user bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tg_account_chats a JOIN tg_user_links l ON l.vaishnava_id = a.approver_vaishnava_id
                  WHERE a.chat_id = p_chat AND l.tg_user_id = p_tg_user);
$$;

CREATE OR REPLACE FUNCTION tg_ip_author_check(p_id uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE; v_st text; v_author boolean;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
  v_author := d.tg_user_id = p_tg_user;
  IF NOT v_author AND NOT tg_ip_is_approver(d.chat_id, p_tg_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT status INTO v_st FROM tg_drafts WHERE id = d.inbox_draft_id;
  IF d.status <> 'sent_to_inbox' OR v_st IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', CASE WHEN v_st = 'posted' THEN 'posted' ELSE 'closed' END);
  END IF;
  RETURN jsonb_build_object('ok', true, 'text', tg_ip_saved_text(p_id),
                            'is_author', v_author,
                            'has_department', d.department_id IS NOT NULL,
                            'source_message_id', d.source_message_id);
END $$;

CREATE OR REPLACE FUNCTION tg_ip_author_reopen(p_id uuid, p_tg_user bigint, p_field text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF d.tg_user_id IS DISTINCT FROM p_tg_user
     AND NOT (tg_ip_is_approver(d.chat_id, p_tg_user) AND p_field <> 'kind') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  PERFORM 1 FROM tg_drafts WHERE id = d.inbox_draft_id FOR UPDATE;
  IF NOT tg_ip_editable_inbox(d) THEN RETURN jsonb_build_object('ok', false, 'error', 'resolved'); END IF;
  IF p_field NOT IN ('kind', 'account', 'department', 'category') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_field');
  END IF;

  UPDATE tg_drafts SET status = 'dismissed', resolved_at = now(),
         note = concat_ws(' · ', NULLIF(note, ''), 'возвращено автором на исправление')
   WHERE id = d.inbox_draft_id;

  UPDATE tg_ip_drafts SET
    status = 'proposed', resolved_at = NULL,
    kind = CASE WHEN p_field = 'kind' THEN NULL ELSE kind END,
    account_id = CASE WHEN p_field = 'account' THEN NULL ELSE account_id END,
    target_account_id = CASE WHEN p_field = 'kind' THEN NULL ELSE target_account_id END,
    department_id = CASE WHEN p_field IN ('kind', 'department') THEN NULL ELSE department_id END,
    no_department = CASE WHEN p_field IN ('kind', 'department') THEN false ELSE no_department END,
    category_id = CASE WHEN p_field IN ('kind', 'department', 'category') THEN NULL ELSE category_id END
  WHERE id = p_id;
  RETURN tg_ip_state(p_id);
END $$;

CREATE OR REPLACE FUNCTION tg_ip_author_dismiss(p_id uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF d.tg_user_id IS DISTINCT FROM p_tg_user AND NOT tg_ip_is_approver(d.chat_id, p_tg_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  PERFORM 1 FROM tg_drafts WHERE id = d.inbox_draft_id FOR UPDATE;
  IF NOT tg_ip_editable_inbox(d) THEN RETURN jsonb_build_object('ok', false, 'error', 'resolved'); END IF;

  UPDATE tg_drafts SET status = 'dismissed', resolved_at = now(),
         note = concat_ws(' · ', NULLIF(note, ''),
                          CASE WHEN d.tg_user_id = p_tg_user THEN 'удалено автором в Телеграме'
                               ELSE 'удалено в Телеграме казначеем' END)
   WHERE id = d.inbox_draft_id;
  UPDATE tg_ip_drafts SET status = 'dismissed', resolved_at = now() WHERE id = p_id;
  PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👎');
  RETURN jsonb_build_object('ok', true);
END $$;

-- «Отправить»: расход, который вернули на исправление, может отправить и ВГ.
-- Приход и перевод — только автор (проводятся от его имени).
DO $$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('tg_ip_confirm(uuid,bigint)'::regprocedure);
  IF position('IF d.tg_user_id <> p_tg_user THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not_author''); END IF;' IN v) = 0 THEN
    RAISE EXCEPTION 'tg_ip_confirm изменилась — правку 814 нужно пересобрать';
  END IF;
  v := replace(v,
    'IF d.tg_user_id <> p_tg_user THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not_author''); END IF;',
    'IF d.tg_user_id <> p_tg_user AND NOT (d.inbox_draft_id IS NOT NULL AND d.kind = ''expense'''
    || ' AND tg_ip_is_approver(d.chat_id, p_tg_user)) THEN'
    || ' RETURN jsonb_build_object(''ok'', false, ''error'', ''not_author''); END IF;');
  EXECUTE v;
END $$;

REVOKE ALL ON FUNCTION tg_ip_is_approver(bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION tg_ip_is_approver(bigint, bigint) TO service_role;
