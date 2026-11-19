-- 807: автор может исправить или удалить свою заявку из чата «Счёт», пока она не проведена
-- (решение ВГ 19.11.2026).
--   • Сумма и описание — правкой самого сообщения в Телеграме (tg_author_edit_text).
--   • Вид, кому, валюта, статья, счёт — кнопкой «✏️ Изменить» под строкой бота (tg_author_reopen):
--     заявка возвращается в карточку-диалог (proposed) и уходит из «Входящих» до «Записать».
--   • «🗑 Удалить» — tg_author_dismiss: заявка отклонена, 👎 на сообщении.
-- Нажимать может автор заявки и казначей. После проведения ничего не меняется —
-- строка бота с кнопками убирается сама (триггер ниже).

-- Кто вправе: автор (тот же Телеграм) или казначей
CREATE OR REPLACE FUNCTION tg_draft_can_author_edit(p_draft tg_drafts, p_tg_user bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_draft.tg_user_id = p_tg_user
      OR EXISTS (SELECT 1 FROM tg_user_links u JOIN tg_treasurer() t ON t.vaishnava_id = u.vaishnava_id
                  WHERE u.tg_user_id = p_tg_user);
$$;

-- Состояние заявки для строки бота — в любом статусе (tg_patch_draft отдаёт только proposed)
CREATE OR REPLACE FUNCTION tg_draft_summary(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d tg_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'status', v_d.status,
    'kind', v_d.kind,
    'amount', v_d.amount,
    'currency', v_d.currency,
    'tg_user_id', v_d.tg_user_id,
    'card_message_id', v_d.card_message_id,
    'source_message_id', v_d.source_message_id,
    'category', (SELECT name FROM fin_categories WHERE id = v_d.category_id),
    'source_account', (SELECT name FROM fin_accounts WHERE id = v_d.source_account_id),
    'target_department', (SELECT name FROM fin_departments WHERE id = v_d.target_department_id),
    'has_categories', EXISTS (SELECT 1 FROM fin_department_categories fdc WHERE fdc.department_id = v_d.department_id),
    'is_ip_chat', EXISTS (SELECT 1 FROM tg_account_chats a WHERE a.chat_id = v_d.chat_id)
  );
END $$;

-- «✏️ Изменить» → выбранное поле: заявку обратно в карточку, поле очищается — бот спросит его заново
CREATE OR REPLACE FUNCTION tg_author_reopen(p_id uuid, p_tg_user bigint, p_field text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d tg_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT tg_draft_can_author_edit(v_d, p_tg_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF v_d.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'error', 'resolved', 'status', v_d.status); END IF;
  IF p_field NOT IN ('kind', 'target', 'currency', 'category', 'source') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_field');
  END IF;

  UPDATE tg_drafts SET
    status = 'proposed',
    kind = CASE WHEN p_field = 'kind' THEN NULL ELSE kind END,
    target_department_id = CASE WHEN p_field IN ('kind', 'target') THEN NULL ELSE target_department_id END,
    currency = CASE WHEN p_field = 'currency' THEN NULL ELSE currency END,
    category_id = CASE WHEN p_field IN ('kind', 'category') THEN NULL ELSE category_id END,
    -- счёт привязан к валюте и к виду — меняются они, выбираем счёт заново
    source_account_id = CASE WHEN p_field IN ('kind', 'target', 'currency', 'source') THEN NULL ELSE source_account_id END
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- «🗑 Удалить» — пока не проведена (и в середине «Изменить» тоже)
CREATE OR REPLACE FUNCTION tg_author_dismiss(p_id uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d tg_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT tg_draft_can_author_edit(v_d, p_tg_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF v_d.status NOT IN ('pending', 'proposed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolved', 'status', v_d.status);
  END IF;

  UPDATE tg_drafts SET status = 'dismissed', resolved_at = now(),
         note = concat_ws(' · ', NULLIF(note, ''), 'удалено автором в Телеграме')
   WHERE id = p_id;
  PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  RETURN jsonb_build_object('ok', true);
END $$;

-- Правка самого сообщения: новая сумма, текст, описание (и валюта, если в тексте указана другая).
-- Первоначальная сумма бота остаётся в amount_original — «Входящие» показывают «было → стало».
CREATE OR REPLACE FUNCTION tg_author_edit_text(p_id uuid, p_tg_user bigint, p_amount numeric,
                                               p_currency text, p_raw_text text, p_purpose text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_d tg_drafts%ROWTYPE;
  v_amount numeric := round(p_amount, 2);
  v_orig numeric;
  v_cur text;
  v_note text;
BEGIN
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  -- текст правит только сам автор сообщения — казначей тут ни при чём
  IF v_d.tg_user_id IS DISTINCT FROM p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF v_d.status NOT IN ('pending', 'proposed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolved', 'status', v_d.status);
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_amount'); END IF;

  v_cur := COALESCE(NULLIF(p_currency, ''), v_d.currency);
  v_orig := COALESCE(v_d.amount_original, v_d.amount);
  -- прежняя отметка автора заменяется, а не копится при повторной правке
  v_note := NULLIF(btrim(regexp_replace(COALESCE(v_d.note, ''), '( · )?автор исправил сообщение[^·]*', '', 'g')), '');
  IF v_amount IS DISTINCT FROM v_orig OR v_cur IS DISTINCT FROM v_d.currency THEN
    v_note := concat_ws(' · ', v_note, format('автор исправил сообщение: %s → %s',
      fin_fmt_money(v_orig, COALESCE(v_d.currency, v_cur)), fin_fmt_money(v_amount, v_cur)));
  END IF;

  UPDATE tg_drafts SET
    -- у выдачи казначея счёт привязан к валюте: валюта сменилась — дособрать в карточке
    status = CASE WHEN v_d.status = 'pending' AND v_cur IS DISTINCT FROM v_d.currency
                       AND v_d.source_account_id IS NOT NULL THEN 'proposed' ELSE v_d.status END,
    amount = v_amount,
    amount_original = CASE WHEN v_amount = v_orig AND v_cur IS NOT DISTINCT FROM v_d.currency THEN NULL ELSE v_orig END,
    currency = v_cur,
    source_account_id = CASE WHEN v_cur IS DISTINCT FROM v_d.currency THEN NULL ELSE source_account_id END,
    raw_text = p_raw_text,
    purpose = COALESCE(NULLIF(p_purpose, ''), purpose),
    note = v_note
  WHERE id = p_id;

  RETURN jsonb_build_object('ok', true,
    'status', (SELECT status FROM tg_drafts WHERE id = p_id),
    'old_amount', v_d.amount, 'old_currency', v_d.currency,
    'new_amount', v_amount, 'new_currency', v_cur);
END $$;

-- Заявку провели или отклонили на сайте — строку бота с кнопками убираем из чата.
-- Чаты счетов ИП не трогаем: там карточку правит сама база (tg_ip_edit_card).
CREATE OR REPLACE FUNCTION tg_on_draft_resolved_drop_card()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.card_message_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tg_account_chats a WHERE a.chat_id = NEW.chat_id) THEN
    PERFORM tg_schedule_delete(NEW.chat_id, NEW.card_message_id, 0);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;   -- учёт важнее строки в чате
END $$;

DROP TRIGGER IF EXISTS tg_drafts_resolved_drop_card ON tg_drafts;
CREATE TRIGGER tg_drafts_resolved_drop_card
  AFTER UPDATE OF status ON tg_drafts
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status IN ('posted', 'dismissed'))
  EXECUTE FUNCTION tg_on_draft_resolved_drop_card();

-- Памятка в чаты «Счёт»: раз в 3 дня до 19.12.2026 (просьба ВГ 19.11.2026)
CREATE OR REPLACE FUNCTION tg_edit_help_broadcast()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0;
BEGIN
  IF current_date > date '2026-12-19' THEN
    PERFORM cron.unschedule('tg-edit-help');
    RETURN 0;
  END IF;
  FOR r IN
    SELECT l.chat_id FROM tg_chat_links l
     WHERE l.is_active AND l.department_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tg_account_chats a WHERE a.chat_id = l.chat_id)
  LOOP
    PERFORM tg_send_chat(r.chat_id,
      E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\n'
      || E'🆕 Теперь трату можно исправить или удалить, пока она не проведена (на сообщении 👀):\n\n'
      || E'• Ошиблись в сумме или описании — просто исправьте своё сообщение (удерживайте его → «Изменить»).\n'
      || E'• Ошиблись в статье или счёте — нажмите «✏️ Изменить» под ответом бота.\n'
      || E'• Записали по ошибке — нажмите «🗑 Удалить» под ответом бота. Само сообщение не удаляйте.\n\n'
      || E'После 👍 трата уже проведена — тогда напишите Ванамали Гопалу, что поправить.',
      NULL, 'finance');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION tg_draft_can_author_edit(tg_drafts, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_draft_summary(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_author_reopen(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_author_dismiss(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_author_edit_text(uuid, bigint, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_on_draft_resolved_drop_card() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_edit_help_broadcast() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION tg_draft_summary(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION tg_author_reopen(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION tg_author_dismiss(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION tg_author_edit_text(uuid, bigint, numeric, text, text, text) TO service_role;

-- 10:00 по Индии (04:30 UTC), каждые 3 дня
SELECT cron.schedule('tg-edit-help', '30 4 */3 * *', 'SELECT tg_edit_help_broadcast()');
