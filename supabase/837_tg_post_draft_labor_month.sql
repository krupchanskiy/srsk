-- =============================================================
-- «Входящие» → «Статьи расхода» / «Уже потрачено»: у строки «Оплата труда»
-- появился месяц, за который платим (ВГ, 28.11.2026: «тут нет месяца»).
--
-- Строка разбивки p_rows получает необязательный ключ period ('YYYY-MM-01').
-- После того как tg_post_draft всё провёл, tg_private_apply_row_periods:
--   • строка привязана к ведомости → месяц выплаты = выбранный
--     (вместо «самого старого неоплаченного», который ставит триггер 828);
--   • строка вне ведомости → к комментарию расхода «… — за ноябрь 2026»,
--     как кнопка «Месяц» в ДДС (fin_set_labor_month, 834). Разные месяцы
--     в одном расходе вне ведомости не пишутся — «Итоги» берут один месяц
--     на комментарий, поэтому отказ с понятным текстом.
-- Окно месяцев как в 834: −10 … +1 от даты расхода.
-- Всё в той же транзакции: ошибка месяца откатывает и проведение.
-- =============================================================

CREATE OR REPLACE FUNCTION public.tg_private_apply_row_periods(p_draft uuid, p_rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d tg_drafts%ROWTYPE;
  r record; v_pay uuid; v_amt numeric; v_op uuid; v_occ date;
  v_ops jsonb := '{}'::jsonb; v_key text; v_period date; v_comment text;
  v_months text[] := ARRAY['январь','февраль','март','апрель','май','июнь','июль','август',
                           'сентябрь','октябрь','ноябрь','декабрь'];
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) x WHERE NULLIF(x->>'period','') IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_draft;

  -- Для каждой строки — id её проводки: те же детерминированные id,
  -- что строит tg_post_draft (свои строки, выдача «уже потрачено»,
  -- строки чужих департаментов по группам в порядке имени департамента)
  FOR r IN
    WITH rows AS (
      SELECT x, ord,
             NULLIF(x->>'department_id','')::uuid AS dept,
             COALESCE((x->>'as_expense')::boolean, true) AS as_expense
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(x, ord)
    ),
    grp AS (
      SELECT g.dept, g.as_expense, row_number() OVER (ORDER BY d.name, g.as_expense) AS seq
        FROM (SELECT DISTINCT dept, as_expense FROM rows WHERE dept IS NOT NULL) g
        JOIN fin_departments d ON d.id = g.dept
    ),
    rows2 AS (
      SELECT rows.*, grp.seq,
             row_number() OVER (PARTITION BY rows.dept, rows.as_expense ORDER BY rows.ord) AS gord
        FROM rows LEFT JOIN grp ON grp.dept = rows.dept AND grp.as_expense = rows.as_expense
    )
    SELECT ord, date_trunc('month', (x->>'period')::date)::date AS period,
           CASE
             WHEN v_d.kind = 'transfer' THEN fin_private_child_uuid(p_draft, 'chat-issue-row-' || ord::text)
             WHEN dept IS NULL THEN fin_private_child_uuid(p_draft, 'chat-expense-row-' || ord::text)
             WHEN as_expense THEN fin_private_child_uuid(p_draft, format('chat-dept-row-%s-%s', seq, gord))
           END AS posting_id
      FROM rows2
     WHERE NULLIF(x->>'period','') IS NOT NULL
     ORDER BY ord
  LOOP
    IF r.posting_id IS NULL THEN CONTINUE; END IF;  -- передача без расхода: месяцу некуда лечь
    SELECT p.amount, p.operation_id, o.occurred_on INTO v_amt, v_op, v_occ
      FROM fin_postings p
      JOIN fin_operations o ON o.id = p.operation_id
      JOIN fin_categories c ON c.id = p.category_id
     WHERE p.id = r.posting_id AND c.code = 'dept_labor';
    IF v_op IS NULL THEN CONTINUE; END IF;          -- не «Оплата труда» — месяц не нужен

    IF r.period < (date_trunc('month', v_occ) - interval '10 months')::date
       OR r.period > (date_trunc('month', v_occ) + interval '1 month')::date THEN
      RAISE EXCEPTION 'chat_post_failed' USING DETAIL = format(
        'Строка %s: месяц — в пределах 10 месяцев до даты выплаты и не позже следующего', r.ord);
    END IF;

    SELECT id INTO v_pay FROM fin_payroll_payments WHERE posting_id = r.posting_id;
    IF v_pay IS NOT NULL THEN
      PERFORM fin_private_set_payment_periods(v_pay,
        jsonb_build_array(jsonb_build_object('period', r.period, 'amount', v_amt)), 'manual');
    ELSE
      v_key := v_op::text;
      IF v_ops ? v_key AND (v_ops->>v_key)::date <> r.period THEN
        RAISE EXCEPTION 'chat_post_failed' USING DETAIL =
          'Оплата труда вне ведомости за разные месяцы в одном расходе — укажите один месяц или проведите отдельно';
      END IF;
      v_ops := v_ops || jsonb_build_object(v_key, r.period);
    END IF;
    v_pay := NULL; v_op := NULL;
  END LOOP;

  FOR v_key, v_comment IN SELECT key, value FROM jsonb_each_text(v_ops) LOOP
    v_period := v_comment::date;
    v_comment := 'за ' || v_months[extract(month FROM v_period)::int] || ' ' || extract(year FROM v_period);
    PERFORM set_config('app.change_reason', 'Месяц оплаты труда: ' || v_comment, true);
    UPDATE fin_operations
       SET comment = COALESCE(NULLIF(btrim(comment), '') || ' — ', '') || v_comment
     WHERE id = v_key::uuid;
  END LOOP;
END $function$;

REVOKE ALL ON FUNCTION public.tg_private_apply_row_periods(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Вызов внутри tg_post_draft — в его блоке с перехватом ошибок, чтобы отказ
-- пришёл казначею текстом, а проведение откатилось целиком.
DO $mig$
DECLARE
  v_src text;
  v_needle text := E'  EXCEPTION WHEN OTHERS THEN\n    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;\n    RETURN jsonb_build_object(''ok'', false, ''error'', COALESCE(NULLIF(v_detail, ''''), SQLERRM));\n  END;\n\n  UPDATE tg_drafts SET status=''posted''';
  v_new text;
BEGIN
  v_src := pg_get_functiondef('public.tg_post_draft(uuid,jsonb,uuid,text,uuid,boolean)'::regprocedure);
  IF position('tg_private_apply_row_periods' IN v_src) > 0 THEN RETURN; END IF;
  IF position(v_needle IN v_src) = 0 THEN
    RAISE EXCEPTION 'tg_post_draft: не найдено место вставки';
  END IF;
  v_new := replace(v_src, v_needle,
    E'    -- месяц оплаты труда из строк разбивки (837)\n    PERFORM tg_private_apply_row_periods(v_d.id, p_rows);\n' || v_needle);
  EXECUTE v_new;
END $mig$;
