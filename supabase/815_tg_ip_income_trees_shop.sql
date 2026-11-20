-- 815: чат счетов ИП — в приходе ещё две статьи: «Пожертвование на деревья» и «Касса Магазин».
-- Порядок кнопок: Мурти, Касса кафе, Касса Магазин, Пожертвование на деревья, Полученные проценты.
-- Подсказка из текста («деревья», «магазин») сразу ставит статью, как у мурти/кафе/процентов.

CREATE OR REPLACE FUNCTION public.tg_ip_options(p_id uuid, p_need text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE d tg_ip_drafts%ROWTYPE; v jsonb;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  IF p_need = 'kind' THEN
    RETURN '[{"v":"income","t":"📥 Приход"},{"v":"expense","t":"💸 Расход"},{"v":"move","t":"🔁 Перевод между счетами"}]'::jsonb;
  ELSIF p_need IN ('account', 'target') THEN
    SELECT jsonb_agg(jsonb_build_object('v', left(a.account_id::text, 8), 't', f.name) ORDER BY a.sort) INTO v
      FROM tg_account_chat_accounts a JOIN fin_accounts f ON f.id = a.account_id
     WHERE a.chat_id = d.chat_id
       AND (p_need = 'account' OR a.account_id <> d.account_id);
  ELSIF p_need = 'category' AND d.kind = 'income' THEN
    SELECT jsonb_agg(jsonb_build_object('v', left(c.id::text, 8), 't', c.name)
                     ORDER BY array_position(ARRAY['murti','cafe_cash','shop_cash','tree_donation','interest_received'], c.code)) INTO v
      FROM fin_categories c
     WHERE c.code IN ('murti', 'cafe_cash', 'shop_cash', 'tree_donation', 'interest_received') AND c.is_active;
  ELSIF p_need = 'department' THEN
    SELECT jsonb_build_array(jsonb_build_object('v', 'none', 't', '🧾 Налоги — без департамента'))
           || COALESCE(jsonb_agg(jsonb_build_object('v', left(x.id::text, 8), 't', x.name) ORDER BY x.name), '[]'::jsonb)
      INTO v FROM fin_departments x;
  ELSIF p_need = 'category' AND d.kind = 'expense' THEN
    -- набор департамента (или общий, если своего нет) + Оплата труда, Билеты, Виза
    WITH own AS (
      SELECT c.id, c.name FROM fin_department_categories dc JOIN fin_categories c ON c.id = dc.category_id
       WHERE dc.department_id = d.department_id AND c.is_active AND c.direction = 'out'
    ), base AS (
      SELECT id, name FROM own
      UNION
      SELECT c.id, c.name FROM fin_categories c
       WHERE NOT EXISTS (SELECT 1 FROM own) AND c.direction = 'out' AND c.visible_to_departments AND c.is_active
      UNION
      SELECT c.id, c.name FROM fin_categories c WHERE c.code IN ('dept_labor', 'tickets', 'visa') AND c.is_active
    )
    SELECT jsonb_agg(jsonb_build_object('v', left(id::text, 8), 't', name) ORDER BY name) INTO v FROM base;
  ELSIF p_need = 'murti_size' THEN
    RETURN '[{"v":"small","t":"Маленький"},{"v":"medium","t":"Средний"},{"v":"large","t":"Большой"}]'::jsonb;
  ELSIF p_need = 'murti_count' THEN
    SELECT jsonb_agg(jsonb_build_object('v', n::text, 't', n::text) ORDER BY n) INTO v FROM generate_series(1, 6) n;
  END IF;
  RETURN COALESCE(v, '[]'::jsonb);
END $function$;

CREATE OR REPLACE FUNCTION public.tg_ip_pick(p_id uuid, p_field text, p_value text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d tg_ip_drafts%ROWTYPE; v_opt jsonb; v_full uuid;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id AND status = 'proposed' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;

  -- значение должно быть среди показанных вариантов этого вопроса
  SELECT o INTO v_opt FROM jsonb_array_elements(tg_ip_options(p_id, p_field)) o WHERE o->>'v' = p_value;
  IF v_opt IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_value'); END IF;

  IF p_field = 'kind' THEN
    UPDATE tg_ip_drafts SET kind = p_value, target_account_id = NULL, category_id = NULL,
           department_id = NULL, no_department = false
     WHERE id = p_id;
    -- подсказка из текста: «мурти», «касса кафе», «магазин», «деревья», «проценты» → статья прихода сразу
    IF p_value = 'income' AND d.hint_category_code IN ('murti', 'cafe_cash', 'shop_cash', 'tree_donation', 'interest_received') THEN
      UPDATE tg_ip_drafts SET category_id = (SELECT id FROM fin_categories WHERE code = d.hint_category_code)
       WHERE id = p_id;
    ELSIF p_value = 'expense' AND d.hint_category_code = 'taxes' THEN
      UPDATE tg_ip_drafts SET no_department = true, category_id = (SELECT id FROM fin_categories WHERE code = 'taxes')
       WHERE id = p_id;
    END IF;
  ELSIF p_field IN ('account', 'target') THEN
    SELECT a.account_id INTO v_full FROM tg_account_chat_accounts a
     WHERE a.chat_id = d.chat_id AND left(a.account_id::text, 8) = p_value;
    IF p_field = 'account' THEN
      UPDATE tg_ip_drafts SET account_id = v_full,
             target_account_id = CASE WHEN target_account_id = v_full THEN NULL ELSE target_account_id END
       WHERE id = p_id;
    ELSE
      UPDATE tg_ip_drafts SET target_account_id = v_full WHERE id = p_id;
    END IF;
  ELSIF p_field = 'department' THEN
    IF p_value = 'none' THEN
      UPDATE tg_ip_drafts SET no_department = true, department_id = NULL,
             category_id = (SELECT id FROM fin_categories WHERE code = 'taxes')
       WHERE id = p_id;
    ELSE
      UPDATE tg_ip_drafts SET no_department = false, category_id = NULL,
             department_id = (SELECT id FROM fin_departments WHERE left(id::text, 8) = p_value LIMIT 1)
       WHERE id = p_id;
    END IF;
  ELSIF p_field = 'category' THEN
    UPDATE tg_ip_drafts SET category_id = (SELECT id FROM fin_categories WHERE left(id::text, 8) = p_value LIMIT 1)
     WHERE id = p_id;
  ELSIF p_field = 'murti_size' THEN
    UPDATE tg_ip_drafts SET murti_size = p_value WHERE id = p_id;
  ELSIF p_field = 'murti_count' THEN
    UPDATE tg_ip_drafts SET murti_count = p_value::int WHERE id = p_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_field');
  END IF;
  RETURN tg_ip_state(p_id);
END $function$;
