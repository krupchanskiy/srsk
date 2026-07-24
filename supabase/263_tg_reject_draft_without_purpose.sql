-- Описание больше не спрашивается диалогом: заявка без него не создаётся,
-- бот отвечает «не могу принять» и просит переписать сообщение.
-- Поэтому убираем шаг «на что» и всё, что его обслуживало.
--
-- Проверка в tg_post_draft остаётся: это последний рубеж на случай, если
-- заявка попадёт в базу мимо бота.

DROP FUNCTION IF EXISTS tg_set_card_message(uuid, bigint);
DROP FUNCTION IF EXISTS tg_find_card_draft(bigint, bigint);

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
    category_id = COALESCE(NULLIF(p->>'category_id','')::uuid, category_id)
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
    -- статью спрашиваем только у расхода: передача департаменту сама себя
    -- объясняет («выдал кухне»)
    'needs_category', v_d.kind = 'expense' AND v_d.category_id IS NULL,
    'complete', v_d.kind IS NOT NULL AND v_d.currency IS NOT NULL
                AND (v_d.kind <> 'transfer' OR v_d.target_department_id IS NOT NULL)
                AND (v_d.kind <> 'expense' OR (v_d.category_id IS NOT NULL
                     AND COALESCE(length(btrim(v_d.purpose)), 0) >= 3))
  );
END;
$$;
