-- 690: «Уточнить выдачу» → «Никому — потратил сам» (ВГ, 14.10.2026).
-- Завод написал «выдано Гест-хаусу (Ретриту) на белые пенки», а Гест-хаус денег
-- не получал — Завод сам купил на ретрит. Убрать получателя было нельзя:
-- tg_refine_draft требовал департамент, и честно провести трату не получалось.
--
-- p_self_spent = true: выдача превращается в расход автора заявки
-- (kind='expense', получатель снят). Проводит потом обычный tg_post_draft
-- строками «сумма / статья / ретрит» — со счёта автора (или выбранного),
-- получатель в учёте не появляется вовсе.
--
-- Старую 4-аргументную версию удаляем: иначе вызов по именам с 4 параметрами
-- неоднозначен между двумя перегрузками.

DROP FUNCTION IF EXISTS public.tg_refine_draft(uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.tg_refine_draft(p_id uuid, p_target_department uuid,
    p_source_account uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text,
    p_self_spent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_cur text;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;

  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  IF v_d.kind <> 'transfer' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Уточнять получателя можно только у выдачи');
  END IF;

  IF NOT COALESCE(p_self_spent, false) THEN
    IF p_target_department IS NULL
       OR NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = p_target_department) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Не выбран департамент-получатель');
    END IF;
    IF p_target_department = v_d.department_id
       AND NOT EXISTS (SELECT 1 FROM tg_treasurer() t WHERE t.vaishnava_id = v_d.author_vaishnava_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Получатель совпадает с автором заявки');
    END IF;
  END IF;

  IF p_source_account IS NOT NULL THEN
    SELECT currency_code INTO v_cur FROM fin_accounts
     WHERE id = p_source_account AND is_active;
    IF v_cur IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Счёт-источник не найден или деактивирован');
    END IF;
    IF v_cur IS DISTINCT FROM v_d.currency THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Валюта счёта не совпадает с валютой заявки');
    END IF;
  END IF;

  IF COALESCE(p_self_spent, false) THEN
    -- purpose нужен расходу (проверка «на что потрачено» в tg_post_draft)
    UPDATE tg_drafts
       SET kind = 'expense',
           target_department_id = NULL,
           source_account_id    = p_source_account,
           purpose = COALESCE(NULLIF(btrim(purpose), ''), raw_text),
           note = CASE WHEN p_note IS NULL THEN note ELSE NULLIF(btrim(p_note), '') END
     WHERE id = p_id;
  ELSE
    UPDATE tg_drafts
       SET target_department_id = p_target_department,
           source_account_id    = p_source_account,
           note = CASE WHEN p_note IS NULL THEN note ELSE NULLIF(btrim(p_note), '') END
     WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.tg_refine_draft(uuid, uuid, uuid, text, boolean) TO authenticated;

insert into translations (key, ru, en, hi) values
  ('fin_refine_self_spent', 'Никому — потратил сам', 'Nobody — spent by the sender', 'किसी को नहीं — स्वयं खर्च किया')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
