-- =============================================================
-- 795. Жильё: «кому платим» и «начислено, не оплачено» (ВГ 18.11, п. 4)
--
-- У жилья в позиции — получатель: хозяину / сотруднику / вернуть заплатившему
-- + имя; не указан = «не выяснено». Ведомость сверху показывает всё жильё к
-- оплате и отдельно — у кого получатель не выяснен. Страница департамента
-- показывает строку «Начислено, не оплачено»: это не расход и не проводка —
-- касса не трогается; расходом «Жильё за пределами ШРСК» сумма становится
-- только при оплате.
-- =============================================================

ALTER TABLE fin_payroll_positions
  ADD COLUMN IF NOT EXISTS housing_paid_to text CHECK (housing_paid_to IN ('landlord', 'employee', 'reimburse')),
  ADD COLUMN IF NOT EXISTS housing_payee text;
COMMENT ON COLUMN fin_payroll_positions.housing_paid_to IS 'Кому платим за жильё (795); NULL — не выяснено';

CREATE OR REPLACE VIEW fin_v_payroll_positions AS
 SELECT pp.id,
    pp.vaishnava_id,
    fin_private_person_name(pp.vaishnava_id) AS employee_name,
    pp.department_id,
    d.name AS department_name,
    pp.position_title,
    pp.salary_amount,
    pp.currency_code,
    pp.effective_from,
    pp.effective_to,
    (pp.effective_to IS NULL) AS is_current,
    COALESCE(acc.total_accrued, (0)::numeric) AS total_accrued,
    COALESCE(pay.total_paid, (0)::numeric) AS total_paid,
    (COALESCE(acc.total_accrued, (0)::numeric) - COALESCE(pay.total_paid, (0)::numeric)) AS balance,
    pay.last_payment_on,
    fin_payroll_tg_enabled(pp.vaishnava_id) AS telegram_enabled,
    pp.housing_amount,
    COALESCE(hacc.total, (0)::numeric) AS housing_accrued,
    COALESCE(hpay.total, (0)::numeric) AS housing_paid,
    (COALESCE(hacc.total, (0)::numeric) - COALESCE(hpay.total, (0)::numeric)) AS housing_balance,
    fin_payroll_person_debt(pp.vaishnava_id, pp.currency_code) AS person_debt,
    pp.housing_paid_to,
    pp.housing_payee
   FROM fin_payroll_positions pp
     JOIN fin_departments d ON d.id = pp.department_id
     LEFT JOIN ( SELECT position_id, sum(amount) AS total_accrued
                   FROM fin_payroll_accruals GROUP BY position_id) acc ON acc.position_id = pp.id
     LEFT JOIN ( SELECT fpp.position_id, sum(po.amount) AS total_paid, max(o.occurred_on) AS last_payment_on
                   FROM fin_payroll_payments fpp
                   JOIN fin_postings po ON po.id = fpp.posting_id
                   JOIN fin_operations o ON o.id = po.operation_id
                  WHERE NOT o.is_reversed
                  GROUP BY fpp.position_id) pay ON pay.position_id = pp.id
     LEFT JOIN ( SELECT position_id, sum(amount) AS total
                   FROM fin_payroll_housing_accruals WHERE cancelled_at IS NULL GROUP BY position_id) hacc ON hacc.position_id = pp.id
     LEFT JOIN ( SELECT hp.position_id, sum(po.amount) AS total
                   FROM fin_payroll_housing_payments hp
                   JOIN fin_postings po ON po.id = hp.posting_id
                   JOIN fin_operations o ON o.id = po.operation_id
                  WHERE NOT o.is_reversed
                  GROUP BY hp.position_id) hpay ON hpay.position_id = pp.id
  WHERE fin_is_admin();



-- Получатель жилья: меняется на месте, у всех периодов человека в департаменте
-- (это не условие пакета, версия позиции не нужна)
CREATE OR REPLACE FUNCTION public.fin_payroll_set_housing_payee(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos fin_payroll_positions%ROWTYPE;
  v_to text;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'paid_to', 'payee']);
  SELECT * INTO v_pos FROM fin_payroll_positions WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена'; END IF;
  v_to := NULLIF(payload->>'paid_to', '');
  IF v_to IS NOT NULL AND v_to NOT IN ('landlord', 'employee', 'reimburse') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Неизвестный получатель';
  END IF;
  UPDATE fin_payroll_positions
     SET housing_paid_to = v_to,
         housing_payee = CASE WHEN v_to IS NULL THEN NULL ELSE NULLIF(btrim(COALESCE(payload->>'payee', '')), '') END
   WHERE vaishnava_id = v_pos.vaishnava_id AND department_id = v_pos.department_id;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;
REVOKE ALL ON FUNCTION fin_payroll_set_housing_payee(jsonb) FROM anon;

-- Начислено, но не оплачено — по департаменту (страница департамента).
-- Права — как у счетов департамента (fin_department_accounts).
CREATE OR REPLACE FUNCTION public.fin_department_payables(p_department text)
 RETURNS TABLE(kind text, person_name text, amount numeric, currency_code text, paid_to text, payee text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dept fin_departments%ROWTYPE;
BEGIN
  SELECT * INTO v_dept FROM fin_departments d
   WHERE d.code = p_department OR d.name = p_department OR d.id::text = p_department
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT fin_can_read_all() AND v_dept.id NOT IN (SELECT fin_user_department_ids()) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  RETURN QUERY
  WITH acc AS (
    SELECT p.vaishnava_id, p.currency_code, sum(a.amount) AS s
      FROM fin_payroll_housing_accruals a JOIN fin_payroll_positions p ON p.id = a.position_id
     WHERE p.department_id = v_dept.id AND a.cancelled_at IS NULL
     GROUP BY 1, 2
  ), paid AS (
    SELECT p.vaishnava_id, po.currency_code, sum(po.amount) AS s
      FROM fin_payroll_housing_payments hp
      JOIN fin_payroll_positions p ON p.id = hp.position_id
      JOIN fin_postings po ON po.id = hp.posting_id
      JOIN fin_operations o ON o.id = po.operation_id
     WHERE p.department_id = v_dept.id AND NOT o.is_reversed
     GROUP BY 1, 2
  ), latest AS (
    SELECT DISTINCT ON (vaishnava_id) vaishnava_id, housing_paid_to, housing_payee
      FROM fin_payroll_positions WHERE department_id = v_dept.id
     ORDER BY vaishnava_id, effective_from DESC
  )
  SELECT 'housing'::text, fin_private_person_name(acc.vaishnava_id), acc.s - COALESCE(paid.s, 0), acc.currency_code,
         l.housing_paid_to, l.housing_payee
    FROM acc
    LEFT JOIN paid ON paid.vaishnava_id = acc.vaishnava_id AND paid.currency_code = acc.currency_code
    LEFT JOIN latest l ON l.vaishnava_id = acc.vaishnava_id
   WHERE acc.s - COALESCE(paid.s, 0) > 0.005
   ORDER BY 2;
END;
$function$;
REVOKE ALL ON FUNCTION fin_department_payables(text) FROM anon;
GRANT EXECUTE ON FUNCTION fin_department_payables(text) TO authenticated;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_payables_title', 'Жильё к оплате', 'Housing due', 'आवास देय'),
  ('fin_payroll_payee_unknown', 'кому — не выяснено', 'payee not clarified', 'किसे — स्पष्ट नहीं'),
  ('fin_payroll_payee_unknown_count', 'получатель не выяснен', 'payee not clarified', 'प्राप्तकर्ता स्पष्ट नहीं'),
  ('fin_payroll_housing_payee', 'Кому платим', 'Who we pay', 'किसे भुगतान'),
  ('fin_payroll_housing_payee_set', 'изменить', 'change', 'बदलें'),
  ('fin_payroll_not_clarified', 'Не выяснено', 'Not clarified', 'स्पष्ट नहीं'),
  ('dacc_payables', 'Начислено, не оплачено', 'Accrued, not paid', 'देय, भुगतान नहीं'),
  ('dacc_payables_hint', 'Не расход и не проводка: касса не тронута. Расходом станет при оплате в зарплатной ведомости.', 'Not an expense or posting: cash untouched. Becomes an expense when paid in the payroll.', 'व्यय या प्रविष्टि नहीं: नकद अछूता। वेतन रजिस्टर में भुगतान पर व्यय बनेगा।'),
  ('dacc_payables_housing', 'жильё', 'housing', 'आवास')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
