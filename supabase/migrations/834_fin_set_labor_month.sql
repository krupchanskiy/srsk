-- 834: месяц у уже проведённой разовой оплаты труда (вне ведомости), ВГ 27.11.
-- У такого расхода месяц живёт только в комментарии «… — за ноябрь 2026»: по этим
-- словам «Итоги» (fin_itogi_month_rows/ops) относят оплату труда к месяцу.
-- Функция меняет только комментарий операции: сумма, дата, счета не трогаются,
-- правка пишется в fin_audit_log с причиной.
-- Год «Итоги» берут не из текста, а угадывают по дате операции (месяц позже
-- следующего — прошлый год), поэтому месяц — в окне 10 месяцев назад … следующий.
-- Выплаты по ведомости сюда не идут: у них месяцы в fin_payroll_payment_periods.

CREATE OR REPLACE FUNCTION public.fin_set_labor_month(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_op fin_operations%ROWTYPE;
  v_period date;
  v_base text;
  v_comment text;
  v_occ date;
  v_detail text;
  v_months text[] := ARRAY['январь','февраль','март','апрель','май','июнь','июль','август',
                           'сентябрь','октябрь','ноябрь','декабрь'];
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['operation_id', 'comment', 'period']);

  SELECT * INTO v_op FROM fin_operations WHERE id = fin_private_get_uuid(payload, 'operation_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Операция не найдена';
  END IF;
  IF v_op.type <> 'expense' OR v_op.is_reversed THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Месяц ставится только у действующего расхода';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_postings p JOIN fin_categories c ON c.id = p.category_id
              WHERE p.operation_id = v_op.id AND c.code <> 'dept_labor')
     OR NOT EXISTS (SELECT 1 FROM fin_postings p WHERE p.operation_id = v_op.id) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Месяц ставится только у расхода «Оплата труда»';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_payroll_payments f JOIN fin_postings p ON p.id = f.posting_id
              WHERE p.operation_id = v_op.id) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Это выплата по ведомости — месяц меняется в Финансы → Зарплата';
  END IF;

  v_period := date_trunc('month', fin_private_get_date(payload, 'period', true))::date;
  v_occ := date_trunc('month', v_op.occurred_on)::date;
  IF v_period < (v_occ - interval '10 months')::date OR v_period > (v_occ + interval '1 month')::date THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format(
      'Месяц — от %s до %s (в пределах года от даты выплаты)',
      v_months[extract(month FROM v_occ - interval '10 months')::int] || ' ' || extract(year FROM v_occ - interval '10 months'),
      v_months[extract(month FROM v_occ + interval '1 month')::int] || ' ' || extract(year FROM v_occ + interval '1 month'));
  END IF;

  v_base := NULLIF(btrim(COALESCE(payload->>'comment', '')), '');
  IF lower(COALESCE(v_base, '')) ~ 'за [^.;]*(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)'
     OR COALESCE(v_base, '') ~ 'за \d{2}\.\d{4}' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Уберите месяц из комментария — он ставится полем «Месяц»';
  END IF;

  v_comment := COALESCE(v_base || ' — ', '') || 'за ' || v_months[extract(month FROM v_period)::int]
               || ' ' || extract(year FROM v_period);

  PERFORM set_config('app.change_reason', 'Месяц оплаты труда: ' || v_comment, true);
  UPDATE fin_operations SET comment = v_comment WHERE id = v_op.id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('comment', v_comment));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END $$;

REVOKE ALL ON FUNCTION public.fin_set_labor_month(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_set_labor_month(jsonb) TO authenticated;
