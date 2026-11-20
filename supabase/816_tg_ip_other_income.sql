-- 816: чат счетов ИП — приход «Прочий приход» со своим описанием.
-- Описание = текст сообщения без даты в начале и суммы со знаком валюты
-- («20.11 продали старый холодильник 5000 ₽» → «продали старый холодильник»).
-- Без слов (одни цифры) кнопку не показываем — приход без пояснения не заводим.

INSERT INTO fin_categories (code, name, direction, visible_to_departments, is_active)
SELECT 'other_income', 'Прочий приход', 'in', false, true
 WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code = 'other_income');

CREATE OR REPLACE FUNCTION public.tg_ip_other_note(p_text text)
 RETURNS text LANGUAGE sql IMMUTABLE
AS $$
  SELECT NULLIF(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(COALESCE(p_text, ''),
           '^\s*\d{1,2}[./]\d{1,2}([./]\d{2,4})?', ''),                    -- дата в начале
           '[-+]?\d[\d\s.,]*\s*(₽|руб\S*|р\.|rub)', '', 'gi'),             -- сумма со знаком
           '[-+]?\d[\d\s.,]*$', ''),                                         -- сумма в конце без знака
           '\s+', ' ', 'g'), ' .,:;-—'), '')
$$;

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
                     ORDER BY array_position(ARRAY['murti','cafe_cash','shop_cash','tree_donation','interest_received','other_income'], c.code)) INTO v
      FROM fin_categories c
     WHERE c.code IN ('murti', 'cafe_cash', 'shop_cash', 'tree_donation', 'interest_received', 'other_income') AND c.is_active
       AND (c.code <> 'other_income' OR tg_ip_other_note(d.raw_text) ~ '[[:alpha:]]');
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

CREATE OR REPLACE FUNCTION public.tg_ip_state(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d tg_ip_drafts%ROWTYPE; v_need text; v_code text; v_murti text;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  SELECT code INTO v_code FROM fin_categories WHERE id = d.category_id;

  v_need := CASE
    WHEN d.kind IS NULL THEN 'kind'
    WHEN d.account_id IS NULL THEN 'account'
    WHEN d.kind = 'move' AND d.target_account_id IS NULL THEN 'target'
    WHEN d.kind = 'income' AND d.category_id IS NULL THEN 'category'
    WHEN d.kind = 'income' AND v_code = 'murti' AND d.murti_size IS NULL THEN 'murti_size'
    WHEN d.kind = 'income' AND v_code = 'murti' AND d.murti_count IS NULL THEN 'murti_count'
    WHEN d.kind = 'expense' AND d.department_id IS NULL AND NOT d.no_department THEN 'department'
    WHEN d.kind = 'expense' AND d.category_id IS NULL THEN 'category'
  END;

  IF d.murti_size IS NOT NULL THEN
    v_murti := CASE d.murti_size WHEN 'small' THEN 'Маленький' WHEN 'medium' THEN 'Средний' ELSE 'Большой' END
               || ' сет' || COALESCE(' × ' || d.murti_count, '');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'id', d.id, 'status', d.status, 'kind', d.kind,
    'amount', d.amount, 'amount_fmt', fin_fmt_money(d.amount, 'RUB'),
    'occurred_on', to_char(d.occurred_on, 'DD.MM.YYYY'),
    'days_ago', v_today - d.occurred_on,
    'raw_text', d.raw_text,
    'account', (SELECT name FROM fin_accounts WHERE id = d.account_id),
    'target', (SELECT name FROM fin_accounts WHERE id = d.target_account_id),
    'category', (SELECT name FROM fin_categories WHERE id = d.category_id),
    'department', CASE WHEN d.no_department THEN 'без департамента'
                       ELSE (SELECT name FROM fin_departments WHERE id = d.department_id) END,
    'murti', v_murti,
    'other', CASE WHEN d.kind = 'income' AND v_code = 'other_income' THEN tg_ip_other_note(d.raw_text) END,
    'needs', v_need,
    'options', CASE WHEN v_need IS NULL THEN '[]'::jsonb ELSE tg_ip_options(d.id, v_need) END
  );
END $function$;

-- Запись: описание «Прочего прихода» — в примечание строки, как сет у мурти.
DO $do$
DECLARE s text := pg_get_functiondef('public.tg_ip_confirm'::regproc);
BEGIN
  IF position('v_note := s->>''murti'';' in s) = 0 THEN RAISE EXCEPTION 'tg_ip_confirm: не нашёл строку v_note'; END IF;
  EXECUTE replace(s, 'v_note := s->>''murti'';', 'v_note := COALESCE(s->>''murti'', s->>''other'');');
END $do$;
