-- Если в сообщении несколько «весомых» чисел (дата, сумма, что-то ещё) и ни
-- одно явно не помечено валютой — бот раньше молча брал последнее число.
-- Обычно верно («по-русски сумму пишут в конце»), но не всегда — заявка
-- «В больнице Дина Харидаса 28/09/2026 12000₽» показала, что валюту рядом с
-- числом уже покрывает отдельная правка (450), а для случаев БЕЗ валюты
-- рядом ни с одним числом решение ВГ 16.09.2026: не гадать, спросить.
--
-- Порядок вопросов: сумма — ПЕРЕД валютой. Валюта не помогает выбрать сумму
-- (она либо уже прибита к нужному числу через 450, либо её не будет вообще),
-- а показывать «₹/₽/$/€» рядом с угаданной суммой, которая может быть не той,
-- только путает.
--
-- tg_drafts.amount делаем nullable: заявка может существовать до того, как
-- сумма определена (как раньше — до того, как известны валюта или статья).
alter table tg_drafts alter column amount drop not null;

create or replace function tg_patch_draft(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_d tg_drafts%ROWTYPE; v_dept text; v_target text; v_cat text; v_src text;
  v_treasurer uuid; v_is_treasurer boolean;
BEGIN
  UPDATE tg_drafts SET
    kind = COALESCE(NULLIF(p->>'kind','')::text, kind),
    amount = COALESCE(NULLIF(p->>'amount','')::numeric, amount),
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
    -- id нужен боту, чтобы предложить счёт этого же департамента (352)
    'department_id', v_d.department_id,
    'target_department', v_target,
    'source_account', v_src,
    'is_treasurer', v_is_treasurer,
    -- сумму спрашиваем первой: пока она не известна, остальные вопросы
    -- (валюта и далее) не имеют смысла показывать
    'needs_amount', v_d.amount IS NULL,
    'needs_kind', v_d.amount IS NOT NULL AND v_d.kind IS NULL,
    'needs_target', v_d.amount IS NOT NULL AND v_d.kind = 'transfer' AND v_d.target_department_id IS NULL,
    'needs_currency', v_d.amount IS NOT NULL AND v_d.currency IS NULL,
    -- статью спрашиваем только у расхода: передача сама себя объясняет
    'needs_category', v_d.amount IS NOT NULL AND v_d.kind = 'expense' AND v_d.category_id IS NULL,
    -- откуда деньги — только у казначея: департамент выдаёт со своего подотчёта
    'needs_source', v_is_treasurer AND v_d.kind = 'transfer'
                    AND v_d.currency IS NOT NULL AND v_d.source_account_id IS NULL,
    'complete', v_d.amount IS NOT NULL AND v_d.kind IS NOT NULL AND v_d.currency IS NOT NULL
                AND (v_d.kind <> 'transfer' OR (v_d.target_department_id IS NOT NULL
                     AND (NOT v_is_treasurer OR v_d.source_account_id IS NOT NULL)))
                AND (v_d.kind <> 'expense' OR (v_d.category_id IS NOT NULL
                     AND COALESCE(length(btrim(v_d.purpose)), 0) >= 3))
  );
END;
$function$;
