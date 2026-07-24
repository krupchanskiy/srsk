-- «На что потрачено» — обязательная часть заявки из чата.
--
-- Было: любой расход из чата падал в единственную статью «Расход департамента»
-- с сырым текстом сообщения. В отчёте получались суммы без смысла.
-- Стало: бот спрашивает статью (кнопками) и описание (текстом), и без них
-- заявку нельзя провести.

-- 1. Статьи расходов, которыми пользуются департаменты.
--    Стартовый набор — ВГ переименует/дополнит в Справочниках.
INSERT INTO fin_categories (code, name, direction, visible_to_departments, is_active) VALUES
  ('dept_food',      'Продукты',                    'out', true, true),
  ('dept_household', 'Хозтовары и расходники',      'out', true, true),
  ('dept_repair',    'Ремонт и стройматериалы',     'out', true, true),
  ('dept_transport', 'Транспорт и топливо',         'out', true, true),
  ('dept_labor',     'Оплата труда',                'out', true, true),
  ('dept_rent',      'Аренда',                      'out', true, true),
  ('dept_utilities', 'Электричество, вода, газ',    'out', true, true),
  ('dept_plants',    'Растения и семена',           'out', true, true),
  ('dept_equipment', 'Инвентарь и оборудование',    'out', true, true),
  ('dept_other',     'Прочее',                      'out', true, true)
ON CONFLICT (code) DO NOTHING;

-- 2. Новые поля заявки
ALTER TABLE tg_drafts
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES fin_categories(id),
  ADD COLUMN IF NOT EXISTS purpose text;

COMMENT ON COLUMN tg_drafts.purpose IS 'На что потрачено — человеческим языком, обязательно для расхода';

-- 3. Список статей для кнопок бота
CREATE OR REPLACE FUNCTION tg_list_expense_categories()
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT c.id, c.name FROM fin_categories c
  WHERE c.direction = 'out' AND c.visible_to_departments AND c.is_active
  ORDER BY c.name;
$$;

-- 4. Заявка ждёт ответа: запоминаем id карточки, чтобы ловить ответ текстом
CREATE OR REPLACE FUNCTION tg_set_card_message(p_id uuid, p_msg bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public'
AS $$ UPDATE tg_drafts SET card_message_id = p_msg WHERE id = p_id; $$;

CREATE OR REPLACE FUNCTION tg_find_card_draft(p_chat bigint, p_msg bigint)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM tg_drafts
  WHERE chat_id = p_chat AND card_message_id = p_msg AND status = 'proposed';
$$;

-- 5. Проведение: статья из заявки, комментарий — человеческое описание.
--    Неполную заявку (без «на что») провести нельзя.
CREATE OR REPLACE FUNCTION tg_post_draft(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_acc uuid; v_tgt uuid; v_cat uuid; v_res jsonb; v_op uuid;
  v_comment text;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  IF v_d.kind IS NULL OR v_d.currency IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указан вид или валюта');
  END IF;
  IF v_d.kind = 'expense' AND COALESCE(length(btrim(v_d.purpose)), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указано, на что потрачено');
  END IF;

  v_acc := fin_dept_account(v_d.department_id, v_d.currency);

  IF v_d.kind = 'expense' THEN
    v_cat := COALESCE(v_d.category_id, (SELECT id FROM fin_categories WHERE code='dept_expense'));
    v_comment := format('%s (из чата: %s)', btrim(v_d.purpose), v_d.raw_text);
    v_res := fin_create_expense(jsonb_build_object(
      'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
      'comment', v_comment,
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
$$;

-- 6. Во «Входящих» видно, на что и по какой статье
DROP VIEW IF EXISTS fin_v_chat_drafts;
CREATE VIEW fin_v_chat_drafts AS
  SELECT t.id, t.chat_id, t.source_message_id, t.kind, t.amount, t.currency,
         t.raw_text, t.purpose, c.name AS category, t.created_at,
         d.name AS department, td.name AS target_department,
         COALESCE(NULLIF(v.spiritual_name, ''), TRIM(BOTH FROM COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))) AS author
  FROM tg_drafts t
    JOIN fin_departments d ON d.id = t.department_id
    LEFT JOIN fin_departments td ON td.id = t.target_department_id
    LEFT JOIN fin_categories c ON c.id = t.category_id
    LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
  WHERE t.status = 'pending' AND fin_can_read_all(auth.uid())
  ORDER BY t.created_at;

-- Пересозданная витрина теряет права — anon сюда не нужен
REVOKE ALL ON fin_v_chat_drafts FROM anon;

REVOKE ALL ON FUNCTION tg_list_expense_categories() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION tg_set_card_message(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_find_card_draft(bigint, bigint) FROM PUBLIC, anon, authenticated;
