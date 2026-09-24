-- Департаменты без своего набора статей (Завод, Стройка, Мастерская…) больше не получают в боте
-- вопрос «какая статья» с общим списком из 39 кнопок (уточнение ВГ 24.09.2026): их расходы идут
-- во «Входящие» без статьи, и статью выбирает фин-админ там, где работает подсказка.
-- Департаменты со своим набором статей — как раньше. Правим только два условия tg_patch_draft.
DO $do$
DECLARE
  def text := pg_get_functiondef('public.tg_patch_draft(uuid, jsonb)'::regprocedure);
  new text;
BEGIN
  new := replace(def,
    $$'needs_category', v_d.amount IS NOT NULL AND v_d.kind = 'expense' AND v_d.category_id IS NULL,$$,
    $$'needs_category', v_d.amount IS NOT NULL AND v_d.kind = 'expense' AND v_d.category_id IS NULL
                        AND EXISTS (SELECT 1 FROM fin_department_categories fdc WHERE fdc.department_id = v_d.department_id),$$);
  IF new = def THEN RAISE EXCEPTION 'замена 1 не сработала'; END IF;
  def := new;
  new := replace(def,
    $$AND (v_d.kind <> 'expense' OR (v_d.category_id IS NOT NULL$$,
    $$AND (v_d.kind <> 'expense' OR ((v_d.category_id IS NOT NULL
                     OR NOT EXISTS (SELECT 1 FROM fin_department_categories fdc WHERE fdc.department_id = v_d.department_id))$$);
  IF new = def THEN RAISE EXCEPTION 'замена 2 не сработала'; END IF;
  EXECUTE new;
END
$do$;
