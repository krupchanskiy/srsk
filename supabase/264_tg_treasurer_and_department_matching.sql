-- Выдача от казначея, узнавание департамента по имени ответственного.
--
-- Правило Адриана: когда о выдаче пишет казначей (ВГ), это не списание с
-- подотчёта, а приход департаменту с настоящего счёта — кассы или банка.
-- Поэтому у заявки появляется источник, и бот спрашивает, откуда деньги.

-- 1. Кто казначей. Отдельная настройка, а не fin_is_admin: админов несколько,
--    и у части из них есть свои департаменты — их «выдал» означает обычную
--    передачу с подотчёта, а не выдачу из кассы.
INSERT INTO fin_settings (key, value)
SELECT 'treasurer_vaishnava_id', v.id::text
FROM vaishnavas v WHERE tg_norm_username(v.telegram) = 'vanamaligopal'
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION tg_treasurer()
RETURNS TABLE(vaishnava_id uuid, username text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT v.id, tg_norm_username(v.telegram)
  FROM fin_settings s JOIN vaishnavas v ON v.id = s.value::uuid
  WHERE s.key = 'treasurer_vaishnava_id';
$$;

-- 2. Источник выдачи
ALTER TABLE tg_drafts
  ADD COLUMN IF NOT EXISTS source_account_id uuid REFERENCES fin_accounts(id);

COMMENT ON COLUMN tg_drafts.source_account_id IS
  'Реальный счёт, с которого выдал казначей. NULL — обычная передача с подотчёта';

-- 3. Счета, откуда казначей может выдать: настоящие, в нужной валюте.
--    p_cash: true — только наличные кассы, false — только безналичные,
--    NULL — все (когда в сообщении не сказано).
CREATE OR REPLACE FUNCTION tg_list_source_accounts(p_currency text, p_cash boolean DEFAULT NULL)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.id, a.name FROM fin_accounts a
  WHERE a.is_active AND a.kind = 'real' AND NOT a.is_restricted
    AND a.currency_code = p_currency
    AND (p_cash IS NULL OR (a.reconciliation_mode = 'cash_count') = p_cash)
  ORDER BY a.name;
$$;

-- 4. Департамент по тексту: по названию ИЛИ по имени ответственного.
--    «выдал Сундаре 5000» → Кухня. Неоднозначность (Олег Карпов отвечает за
--    два департамента) — не угадываем, вернём NULL и бот спросит кнопками.
CREATE OR REPLACE FUNCTION tg_match_department(p_text text, p_exclude uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH t AS (SELECT lower(translate(p_text, 'Ёё', 'Ее')) AS txt),
  keys AS (
    SELECT d.id, lower(translate(left(d.name, 4), 'Ёё', 'Ее')) AS k
    FROM fin_departments d
    UNION ALL
    SELECT d.id, lower(translate(left(COALESCE(NULLIF(v.spiritual_name,''),
             trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))), 4), 'Ёё', 'Ее'))
    FROM fin_departments d JOIN vaishnavas v ON v.id = d.responsible_person_id
  ),
  hits AS (
    SELECT DISTINCT k.id FROM keys k, t
    WHERE length(k.k) >= 3 AND t.txt LIKE '%' || k.k || '%'
      AND k.id <> COALESCE(p_exclude, '00000000-0000-0000-0000-000000000000')
  )
  SELECT id FROM hits WHERE (SELECT count(*) FROM hits) = 1;
$$;

-- 5. Диалог: добавился шаг «откуда выдаём» — только для казначея
CREATE OR REPLACE FUNCTION tg_patch_draft(p_id uuid, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_d tg_drafts%ROWTYPE; v_dept text; v_target text; v_cat text; v_src text;
  v_treasurer uuid; v_is_treasurer boolean;
BEGIN
  UPDATE tg_drafts SET
    kind = COALESCE(NULLIF(p->>'kind','')::text, kind),
    currency = COALESCE(NULLIF(p->>'currency','')::text, currency),
    target_department_id = COALESCE(NULLIF(p->>'target_department_id','')::uuid, target_department_id),
    category_id = COALESCE(NULLIF(p->>'category_id','')::uuid, category_id),
    source_account_id = COALESCE(NULLIF(p->>'source_account_id','')::uuid, source_account_id)
  WHERE id = p_id AND status = 'proposed'
  RETURNING * INTO v_d;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;

  SELECT t.vaishnava_id INTO v_treasurer FROM tg_treasurer() t;
  v_is_treasurer := v_d.author_vaishnava_id IS NOT NULL AND v_d.author_vaishnava_id = v_treasurer;

  SELECT name INTO v_dept FROM fin_departments WHERE id = v_d.department_id;
  SELECT name INTO v_target FROM fin_departments WHERE id = v_d.target_department_id;
  SELECT name INTO v_cat FROM fin_categories WHERE id = v_d.category_id;
  SELECT name INTO v_src FROM fin_accounts WHERE id = v_d.source_account_id;

  RETURN jsonb_build_object(
    'ok', true,
    'kind', v_d.kind,
    'currency', v_d.currency,
    'amount', v_d.amount,
    'raw_text', v_d.raw_text,
    'purpose', v_d.purpose,
    'category', v_cat,
    'department', v_dept,
    'target_department', v_target,
    'source_account', v_src,
    'is_treasurer', v_is_treasurer,
    'needs_kind', v_d.kind IS NULL,
    'needs_target', v_d.kind = 'transfer' AND v_d.target_department_id IS NULL,
    'needs_currency', v_d.currency IS NULL,
    -- статью спрашиваем только у расхода: передача сама себя объясняет
    'needs_category', v_d.kind = 'expense' AND v_d.category_id IS NULL,
    -- откуда деньги — только у казначея: департамент выдаёт со своего подотчёта
    'needs_source', v_is_treasurer AND v_d.kind = 'transfer'
                    AND v_d.currency IS NOT NULL AND v_d.source_account_id IS NULL,
    'complete', v_d.kind IS NOT NULL AND v_d.currency IS NOT NULL
                AND (v_d.kind <> 'transfer' OR (v_d.target_department_id IS NOT NULL
                     AND (NOT v_is_treasurer OR v_d.source_account_id IS NOT NULL)))
                AND (v_d.kind <> 'expense' OR (v_d.category_id IS NOT NULL
                     AND COALESCE(length(btrim(v_d.purpose)), 0) >= 3))
  );
END;
$$;

-- 6. Проведение: у казначея источник — выбранный реальный счёт
CREATE OR REPLACE FUNCTION tg_post_draft(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_acc uuid; v_tgt uuid; v_cat uuid; v_res jsonb; v_op uuid;
  v_comment text; v_src_cur text;
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

  IF v_d.kind = 'expense' THEN
    v_acc := fin_dept_account(v_d.department_id, v_d.currency);
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

    IF v_d.source_account_id IS NOT NULL THEN
      -- Выдача казначея: деньги уходят с настоящего счёта
      SELECT currency_code INTO v_src_cur FROM fin_accounts WHERE id = v_d.source_account_id;
      IF v_src_cur IS DISTINCT FROM v_d.currency THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Валюта счёта не совпадает с валютой заявки');
      END IF;
      v_acc := v_d.source_account_id;
    ELSE
      v_acc := fin_dept_account(v_d.department_id, v_d.currency);
    END IF;

    v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);
    IF v_tgt = v_acc THEN RETURN jsonb_build_object('ok', false, 'error', 'Источник и получатель совпадают'); END IF;
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

-- 7. Во «Входящих» видно, откуда выдано
DROP VIEW IF EXISTS fin_v_chat_drafts;
CREATE VIEW fin_v_chat_drafts AS
  SELECT t.id, t.chat_id, t.source_message_id, t.kind, t.amount, t.currency,
         t.raw_text, t.purpose, c.name AS category, a.name AS source_account, t.created_at,
         d.name AS department, td.name AS target_department,
         COALESCE(NULLIF(v.spiritual_name, ''), TRIM(BOTH FROM COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))) AS author
  FROM tg_drafts t
    JOIN fin_departments d ON d.id = t.department_id
    LEFT JOIN fin_departments td ON td.id = t.target_department_id
    LEFT JOIN fin_categories c ON c.id = t.category_id
    LEFT JOIN fin_accounts a ON a.id = t.source_account_id
    LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
  WHERE t.status = 'pending' AND fin_can_read_all(auth.uid())
  ORDER BY t.created_at;

REVOKE ALL ON fin_v_chat_drafts FROM anon;
REVOKE ALL ON FUNCTION tg_treasurer() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION tg_list_source_accounts(text, boolean) FROM PUBLIC, anon;

-- 8. Перевод для «Входящих»
INSERT INTO translations (key, ru, en, hi, page)
VALUES ('fin_from', 'Откуда', 'From', 'कहाँ से', 'finance/inbox.html')
ON CONFLICT (key) DO NOTHING;
