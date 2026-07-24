-- Описание из самого сообщения + возможность его переписать.
--
-- «Купил овощи 500 рупий» уже содержит ответ на вопрос «на что» — глупо
-- переспрашивать. Бот вынимает описание из текста, показывает его в карточке,
-- а кнопка «Исправить описание» стирает его и спрашивает заново.

CREATE OR REPLACE FUNCTION tg_create_draft(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid; v_author uuid; v_dept uuid;
BEGIN
  SELECT vaishnava_id INTO v_author FROM tg_user_links WHERE tg_user_id = (p->>'tg_user_id')::bigint;
  SELECT department_id INTO v_dept FROM tg_chat_links WHERE chat_id = (p->>'chat_id')::bigint AND is_active;
  IF v_dept IS NULL THEN RETURN NULL; END IF;
  INSERT INTO tg_drafts (chat_id, source_message_id, tg_user_id, author_vaishnava_id,
                         department_id, target_department_id, kind, amount, currency,
                         purpose, raw_text, status)
  VALUES ((p->>'chat_id')::bigint, (p->>'source_message_id')::bigint, (p->>'tg_user_id')::bigint, v_author,
          v_dept, NULLIF(p->>'target_department_id','')::uuid, NULLIF(p->>'kind',''),
          (p->>'amount')::numeric, NULLIF(p->>'currency',''),
          NULLIF(btrim(p->>'purpose'),''), p->>'raw_text', 'proposed')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION tg_patch_draft(p_id uuid, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_d tg_drafts%ROWTYPE; v_dept text; v_target text; v_cat text;
BEGIN
  UPDATE tg_drafts SET
    kind = COALESCE(NULLIF(p->>'kind','')::text, kind),
    currency = COALESCE(NULLIF(p->>'currency','')::text, currency),
    target_department_id = COALESCE(NULLIF(p->>'target_department_id','')::uuid, target_department_id),
    category_id = COALESCE(NULLIF(p->>'category_id','')::uuid, category_id),
    -- clear=purpose — единственный способ стереть уже записанное описание
    purpose = CASE WHEN p->>'clear' = 'purpose' THEN NULL
                   ELSE COALESCE(NULLIF(btrim(p->>'purpose'),''), purpose) END
  WHERE id = p_id AND status = 'proposed'
  RETURNING * INTO v_d;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;

  SELECT name INTO v_dept FROM fin_departments WHERE id = v_d.department_id;
  SELECT name INTO v_target FROM fin_departments WHERE id = v_d.target_department_id;
  SELECT name INTO v_cat FROM fin_categories WHERE id = v_d.category_id;

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
    'needs_kind', v_d.kind IS NULL,
    'needs_target', v_d.kind = 'transfer' AND v_d.target_department_id IS NULL,
    'needs_currency', v_d.currency IS NULL,
    -- статью и описание спрашиваем только у расхода: передача департаменту
    -- сама себя объясняет («выдал кухне»)
    'needs_category', v_d.kind = 'expense' AND v_d.category_id IS NULL,
    'needs_purpose', v_d.kind = 'expense' AND COALESCE(length(btrim(v_d.purpose)), 0) < 3,
    'complete', v_d.kind IS NOT NULL AND v_d.currency IS NOT NULL
                AND (v_d.kind <> 'transfer' OR v_d.target_department_id IS NOT NULL)
                AND (v_d.kind <> 'expense' OR (v_d.category_id IS NOT NULL
                     AND COALESCE(length(btrim(v_d.purpose)), 0) >= 3))
  );
END;
$$;
