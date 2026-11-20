-- 812: исправление непроведённого в чате счетов ИП (решение ВГ 20.11.2026 — как в чатах «Счёт», 807).
--   • Карточка ещё не записана — правка сообщения меняет сумму, дату и текст в карточке.
--   • Расход во «Входящих» (ещё не проведён):
--       – правка сообщения → сумма/дата/текст в заявке, «было → стало» во «Входящих»;
--       – «✏️ Изменить» → вид / счёт / департамент / статья: заявка уходит из «Входящих»
--         обратно в карточку, после «Отправить» возвращается туда же (та же строка tg_drafts);
--       – «🗑 Удалить» → заявка отклонена, 👎.
--   • Проведённые приход/перевод/расход — как раньше: только через ВГ (сторно на сайте).
-- Всё это может только автор сообщения: ВГ меняет что угодно сам во «Входящих».

-- Черновик по сообщению — для правки сообщения
CREATE OR REPLACE FUNCTION tg_ip_draft_for_message(p_chat bigint, p_message_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', d.id, 'status', d.status, 'kind', d.kind, 'raw_text', d.raw_text,
                            'tg_user_id', d.tg_user_id, 'card_message_id', d.card_message_id,
                            'amount', d.amount, 'inbox_status', t.status)
    FROM tg_ip_drafts d LEFT JOIN tg_drafts t ON t.id = d.inbox_draft_id
   WHERE d.chat_id = p_chat AND d.source_message_id = p_message_id;
$$;

-- Карточка расхода, отправленного во «Входящие» (под ней кнопки «Изменить / Удалить»)
CREATE OR REPLACE FUNCTION tg_ip_saved_text(p_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE; s jsonb;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  s := tg_ip_state(p_id);
  RETURN format('📨 <b>Расход %s — во «Входящих»</b>', s->>'amount_fmt')
      || format(E'\n%s · %s → %s', s->>'occurred_on', tg_escape(s->>'account'),
                CASE WHEN d.no_department THEN tg_escape(s->>'category')
                     ELSE tg_escape(s->>'department') || ' · ' || tg_escape(s->>'category') END)
      || E'\nВ остатке появится после проведения — эта карточка обновится.';
END $$;

-- Расход во «Входящих» и ещё не проведён: строка tg_drafts в pending
CREATE OR REPLACE FUNCTION tg_ip_editable_inbox(d tg_ip_drafts)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.status = 'sent_to_inbox'
     AND EXISTS (SELECT 1 FROM tg_drafts t WHERE t.id = d.inbox_draft_id AND t.status = 'pending');
$$;

-- Кнопки «Изменить / Удалить»: можно ли автору и что показать
CREATE OR REPLACE FUNCTION tg_ip_author_check(p_id uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE; v_st text;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
  IF d.tg_user_id IS DISTINCT FROM p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT status INTO v_st FROM tg_drafts WHERE id = d.inbox_draft_id;
  IF d.status <> 'sent_to_inbox' OR v_st IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', CASE WHEN v_st = 'posted' THEN 'posted' ELSE 'closed' END);
  END IF;
  RETURN jsonb_build_object('ok', true, 'text', tg_ip_saved_text(p_id),
                            'has_department', d.department_id IS NOT NULL,
                            'source_message_id', d.source_message_id);
END $$;

-- Правка самого сообщения: сумма, дата (если указана — иначе прежняя), текст
CREATE OR REPLACE FUNCTION tg_ip_author_edit_text(p_id uuid, p_tg_user bigint, p_amount numeric,
                                                  p_occurred_on date, p_raw_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d tg_ip_drafts%ROWTYPE; v_r jsonb;
  v_amount numeric := round(p_amount, 2);
  v_on date;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF d.tg_user_id IS DISTINCT FROM p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF NOT (d.status = 'proposed' OR tg_ip_editable_inbox(d)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolved', 'status', d.status);
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_amount'); END IF;
  v_on := COALESCE(p_occurred_on, d.occurred_on);
  IF v_on > v_today THEN RETURN jsonb_build_object('ok', false, 'error', 'future_date', 'date', v_on); END IF;
  IF v_on < v_today - 366 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_old', 'date', v_on); END IF;

  IF d.status = 'sent_to_inbox' THEN
    -- заявка во «Входящих»: та же логика, что в чатах «Счёт» («было → стало» в amount_original)
    v_r := tg_author_edit_text(d.inbox_draft_id, p_tg_user, v_amount, 'RUB', p_raw_text, btrim(p_raw_text));
    IF NOT COALESCE((v_r->>'ok')::boolean, false) THEN RETURN v_r; END IF;
    UPDATE tg_drafts SET occurred_on = v_on WHERE id = d.inbox_draft_id;
  END IF;

  UPDATE tg_ip_drafts SET amount = v_amount, occurred_on = v_on, raw_text = p_raw_text WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'status', d.status,
    'old_amount', d.amount, 'new_amount', v_amount,
    'old_date', to_char(d.occurred_on, 'DD.MM.YYYY'), 'new_date', to_char(v_on, 'DD.MM.YYYY'),
    'state', tg_ip_state(p_id),
    'text', CASE WHEN d.status = 'sent_to_inbox' THEN tg_ip_saved_text(p_id) END);
END $$;

-- «✏️ Изменить» → поле: заявка уходит из «Входящих» обратно в карточку, поле спрашивается заново
CREATE OR REPLACE FUNCTION tg_ip_author_reopen(p_id uuid, p_tg_user bigint, p_field text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF d.tg_user_id IS DISTINCT FROM p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  PERFORM 1 FROM tg_drafts WHERE id = d.inbox_draft_id FOR UPDATE;
  IF NOT tg_ip_editable_inbox(d) THEN RETURN jsonb_build_object('ok', false, 'error', 'resolved'); END IF;
  IF p_field NOT IN ('kind', 'account', 'department', 'category') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_field');
  END IF;

  -- из «Входящих» убираем; строка остаётся и вернётся в pending после «Отправить» (tg_ip_confirm)
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
  -- 👀 снимает вебхук: до «Отправить» заявки во «Входящих» нет
  RETURN tg_ip_state(p_id);
END $$;

-- «🗑 Удалить» расход, который ещё во «Входящих»
CREATE OR REPLACE FUNCTION tg_ip_author_dismiss(p_id uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF d.tg_user_id IS DISTINCT FROM p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  PERFORM 1 FROM tg_drafts WHERE id = d.inbox_draft_id FOR UPDATE;
  IF NOT tg_ip_editable_inbox(d) THEN RETURN jsonb_build_object('ok', false, 'error', 'resolved'); END IF;

  UPDATE tg_drafts SET status = 'dismissed', resolved_at = now(),
         note = concat_ws(' · ', NULLIF(note, ''), 'удалено автором в Телеграме')
   WHERE id = d.inbox_draft_id;
  UPDATE tg_ip_drafts SET status = 'dismissed', resolved_at = now() WHERE id = p_id;
  PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👎');
  RETURN jsonb_build_object('ok', true);
END $$;

-- «Записать / Отправить»: расход, возвращённый на исправление, уходит во «Входящие» той же строкой
-- (одна строка tg_drafts на сообщение — уникальный индекс). Остальное — как в 800.
CREATE OR REPLACE FUNCTION public.tg_ip_confirm(p_id uuid, p_tg_user bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d tg_ip_drafts%ROWTYPE; s jsonb; v_res jsonb; v_op uuid; v_note text; v_inbox uuid;
  v_text text;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id AND status = 'proposed' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
  IF d.tg_user_id <> p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'not_author'); END IF;
  s := tg_ip_state(p_id);
  IF s->>'needs' IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'incomplete'); END IF;

  IF d.kind = 'expense' THEN
    IF d.inbox_draft_id IS NOT NULL THEN
      UPDATE tg_drafts SET
        target_department_id = d.department_id, kind = 'expense', amount = d.amount, currency = 'RUB',
        purpose = btrim(d.raw_text), raw_text = d.raw_text, status = 'pending', resolved_at = NULL,
        category_id = d.category_id, source_account_id = d.account_id, occurred_on = d.occurred_on,
        card_message_id = d.card_message_id,
        note = NULLIF(btrim(regexp_replace(COALESCE(note, ''), '( · )?возвращено автором на исправление', '', 'g')), '')
       WHERE id = d.inbox_draft_id AND status = 'dismissed'
      RETURNING id INTO v_inbox;
      IF v_inbox IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
    ELSE
      INSERT INTO tg_drafts (chat_id, source_message_id, card_message_id, tg_user_id, author_vaishnava_id,
                             department_id, target_department_id, kind, amount, currency, purpose, raw_text,
                             status, category_id, source_account_id, occurred_on)
      VALUES (d.chat_id, d.source_message_id, d.card_message_id, d.tg_user_id, d.author_vaishnava_id,
              NULL, d.department_id, 'expense', d.amount, 'RUB', btrim(d.raw_text), d.raw_text,
              'pending', d.category_id, d.account_id, d.occurred_on)
      RETURNING id INTO v_inbox;
    END IF;
    UPDATE tg_ip_drafts SET status = 'sent_to_inbox', inbox_draft_id = v_inbox, resolved_at = now() WHERE id = p_id;
    PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👀');
    RETURN jsonb_build_object('ok', true, 'kind', 'expense', 'text', tg_ip_saved_text(p_id));
  END IF;

  PERFORM tg_ip_act_as(d.author_user_id);
  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  IF d.kind = 'income' THEN
    v_note := s->>'murti';
    v_res := fin_create_income(jsonb_build_object(
      'request_id', d.id, 'occurred_on', d.occurred_on,
      'comment', format('Из чата «%s»: %s',
                        (SELECT title FROM tg_account_chats WHERE chat_id = d.chat_id), d.raw_text),
      'rows', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'id', fin_private_child_uuid(d.id, 'ip-income-row'),
        'account_id', d.account_id, 'amount', d.amount,
        'category_id', d.category_id, 'note', v_note)))));
  ELSE
    v_res := fin_create_transfer(jsonb_build_object(
      'request_id', d.id, 'occurred_on', d.occurred_on,
      'source_account_id', d.account_id, 'target_account_id', d.target_account_id,
      'source_amount', d.amount,
      'comment', format('Из чата «%s»: %s',
                        (SELECT title FROM tg_account_chats WHERE chat_id = d.chat_id), d.raw_text)));
  END IF;

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'post_failed',
                              'message', COALESCE(v_res#>>'{error,message}', 'не удалось провести'));
  END IF;
  v_op := COALESCE(NULLIF(v_res#>>'{result,operation_id}', '')::uuid, d.id);
  UPDATE tg_ip_drafts SET status = 'posted', operation_id = v_op, resolved_at = now() WHERE id = p_id;
  PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👍');

  v_text := CASE WHEN d.kind = 'income'
      THEN format('✅ <b>Приход %s</b>', s->>'amount_fmt')
           || format(E'\n%s · %s%s → %s', s->>'occurred_on', tg_escape(s->>'category'),
                     COALESCE(' (' || tg_escape(v_note) || ')', ''), tg_escape(s->>'account'))
      ELSE format('✅ <b>Перевод %s</b>', s->>'amount_fmt')
           || format(E'\n%s · %s → %s', s->>'occurred_on', tg_escape(s->>'account'), tg_escape(s->>'target'))
    END || COALESCE(tg_ip_balance_line(d.chat_id), '');
  RETURN jsonb_build_object('ok', true, 'kind', d.kind, 'text', v_text);
END $function$;

-- Только вебхук (service_role)
DO $$
DECLARE f text;
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('tg_ip_draft_for_message', 'tg_ip_saved_text', 'tg_ip_editable_inbox', 'tg_ip_author_check',
                                'tg_ip_author_edit_text', 'tg_ip_author_reopen', 'tg_ip_author_dismiss', 'tg_ip_confirm')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
