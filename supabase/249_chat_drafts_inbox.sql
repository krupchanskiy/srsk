-- Отклонить заявку из «Входящих» (pending → dismissed), fin-админ
CREATE OR REPLACE FUNCTION public.tg_dismiss_draft(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  UPDATE tg_drafts SET status='dismissed', resolved_by=auth.uid(), resolved_at=now()
  WHERE id = p_id AND status = 'pending';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_dismiss_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_dismiss_draft(uuid) TO authenticated;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_tab_chat_drafts', 'Из чатов', 'From chats', 'चैट से'),
  ('fin_no_chat_drafts', 'Из чатов департаментов заявок нет', 'No requests from department chats', 'विभाग चैट से कोई अनुरोध नहीं'),
  ('fin_chat_expense', 'Расход', 'Expense', 'व्यय'),
  ('fin_chat_transfer', 'Передача', 'Transfer', 'हस्तांतरण'),
  ('fin_post_draft', 'Провести', 'Post', 'दर्ज करें'),
  ('fin_dismiss_draft', 'Отклонить', 'Dismiss', 'अस्वीकार')
ON CONFLICT (key) DO UPDATE SET ru=EXCLUDED.ru, en=EXCLUDED.en, hi=EXCLUDED.hi;
